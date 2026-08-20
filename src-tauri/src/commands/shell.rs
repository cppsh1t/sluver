// Agent shell execution commands — ADR-0041.
//
// Two commands live here:
//   - `shell_exec` — runs the model's command string through
//     `deno_task_shell`: the string is parsed to an AST FIRST (parse failure
//     returns to the model without spawning anything), built-ins (`cd`, `cp`,
//     `rm`, `mkdir`, …) run as audited in-process Rust operations, and
//     external commands are resolved via `which` then spawned directly (no
//     `cmd.exe` / PowerShell ever interprets the string).
//   - `shell_kill` — idempotent kill for an in-flight run, keyed by the
//     client-generated `run_id`.
//
// ## Execution model
//
// `deno_task_shell` futures are `!Send` (the internals are `Rc`-based), so
// each run executes on a dedicated blocking thread via
// `tauri::async_runtime::spawn_blocking` + `Handle::current().block_on(...)`.
// The async command awaits the join handle. The `KillSignal` cannot cross
// threads either (`!Send`), so the kill path is bridged through an mpsc
// channel + `AtomicBool` held in the managed [`ShellRegistry`] — the blocking
// thread owns the actual `KillSignal` and applies incoming requests.
//
// ## Kill semantics (verified against deno_task_shell 0.33.3 source)
//
// `KillSignal::send(SIGTERM)` is observed by the external-command select loop
// (`wait_any()` → `child.start_kill()` = TerminateProcess on Windows), and
// every spawned child is additionally assigned to a per-`ShellState` Windows
// Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — so dropping the
// run's state kills any survivor, including on app crash. ADR-0041's
// "Job Object as future work" item is already satisfied upstream.
//
// ## Redaction (ADR-0016)
//
// The command string is prompt-adjacent creative input (⚠️ TRACE-only tier —
// first 80 chars as `command_preview` at TRACE, nothing else). Command
// OUTPUT is NEVER logged at any level (❌ tier — it can contain creative
// content). Only metadata is emitted: `run_id`, `space_id`, `exit_code`,
// `timed_out`, `killed`, `duration_ms`, `truncated`.
//
// ## Errors
//
// [`ShellError`] mirrors `db/error.rs`'s `ErrorPayload { code, message,
// args }` serialization: parse failures → `SHELL_PARSE_ERROR` (model-facing
// message, no i18n value), input validation → `INVALID_INPUT`, everything
// else → `INTERNAL_ERROR`. No `anyhow` in the public API.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use deno_task_shell::parser::SequentialList;
use deno_task_shell::{
    execute_with_pipes, pipe, KillSignal, ShellState, SignalKind,
};
use serde::Serialize;
use tauri::State;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::db::error::ErrorPayload;
use crate::db::DbManager;

// ─── tuning constants (ADR-0041 §4) ───────────────────────────────────────────

/// Default wall-clock budget for a run (industry consensus: Claude Code's
/// 2-minute default).
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// Server-side clamp bounds for `timeout_ms`. Values outside the range are
/// clamped silently (never rejected) — the Rust side enforces the bound
/// independently of what the frontend sends.
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

/// Grace period for the execute future to unwind after a kill signal (user
/// Stop or timeout): lets it terminate children and flush partial output.
const CLEANUP_GRACE: Duration = Duration::from_secs(5);

/// Extra slack for draining the output pipe after the run finished. Once the
/// execute future is dropped every writer handle is closed (survivors are
/// killed by the Job Object), so the drain normally resolves immediately.
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(1);

/// Output cap in chars (not bytes — truncation must respect char boundaries).
const MAX_OUTPUT_CHARS: usize = 30_000;
const OUTPUT_HEAD_CHARS: usize = 24_000;
const OUTPUT_TAIL_CHARS: usize = 5_000;

// ═════════════════════════════════════════════════════════════════════════════
// DTOs + error
// ═════════════════════════════════════════════════════════════════════════════

/// Frozen IPC result contract (ADR-0041 §5) — the TS side is built against
/// this shape; do not rename or retype fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecResult {
    /// `None` when the run was killed or timed out without a real exit.
    pub exit_code: Option<i32>,
    /// Merged stdout+stderr (single shared pipe → chronological
    /// interleaving), head+tail truncated.
    pub output: String,
    /// `true` when `output` was truncated to fit [`MAX_OUTPUT_CHARS`].
    pub truncated: bool,
    /// Pre-truncation char count (never a partial value).
    pub output_length: usize,
    pub timed_out: bool,
    pub killed: bool,
    pub duration_ms: u64,
}

/// Error type for the shell command family. Serializes to the shared
/// `ErrorPayload` shape exactly like [`DbError`] does (see `db/error.rs`),
/// so the frontend's `toErrorPayload` / `translateError` pipeline works
/// unchanged.
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    /// `deno_task_shell` could not parse the command string. Model-facing:
    /// the message is the parse failure text itself (English is fine —
    /// ADR-0041 §5, no i18n value).
    #[error("{0}")]
    ParseError(String),

    /// Rejected input (empty command, non-absolute cwd, malformed space id).
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// Infrastructure failure (blocking task join error, etc.). Dynamic
    /// message only — collapses to `INTERNAL_ERROR`.
    #[error("{0}")]
    Internal(String),
}

impl ShellError {
    /// Map this error into a serializable payload (mirrors
    /// `DbError::to_payload`).
    fn to_payload(&self) -> ErrorPayload {
        let (code, args): (&'static str, HashMap<String, String>) = match self {
            ShellError::ParseError(_) => ("SHELL_PARSE_ERROR", HashMap::new()),
            ShellError::InvalidInput(msg) => (
                "INVALID_INPUT",
                HashMap::from([("message".to_string(), msg.clone())]),
            ),
            ShellError::Internal(_) => ("INTERNAL_ERROR", HashMap::new()),
        };
        ErrorPayload {
            code: code.to_string(),
            message: self.to_string(),
            args,
        }
    }
}

impl Serialize for ShellError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.to_payload().serialize(serializer)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Kill-signal registry
// ═════════════════════════════════════════════════════════════════════════════

/// Handle for one in-flight run. Both fields are `Send + Sync` — the actual
/// `KillSignal` is `!Send` and stays on the run's blocking thread, which owns
/// the receiving end of the channel.
struct RunHandle {
    kill_tx: UnboundedSender<SignalKind>,
    kill_requested: Arc<AtomicBool>,
}

/// Managed state mapping `run_id` → kill handle for in-flight `shell_exec`
/// runs (ADR-0041 §3). In-memory only — nothing here is persisted.
///
/// `Clone` hands out cheap handles so the blocking thread can deregister
/// itself on completion (see [`RunGuard`]).
#[derive(Clone, Default)]
pub struct ShellRegistry {
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
}

impl ShellRegistry {
    /// Register a run's kill handle.
    fn register(
        &self,
        run_id: String,
        kill_tx: UnboundedSender<SignalKind>,
        kill_requested: Arc<AtomicBool>,
    ) {
        self.runs
            .lock()
            .unwrap()
            .insert(run_id, RunHandle { kill_tx, kill_requested });
    }

    /// Remove a run's entry (idempotent).
    fn unregister(&self, run_id: &str) {
        self.runs.lock().unwrap().remove(run_id);
    }

    /// Request a kill for `run_id`. Returns `false` for unknown /
    /// already-finished runs. Never fails: a dropped receiver (run racing to
    /// completion) makes the channel send a harmless no-op.
    fn kill_run(&self, run_id: &str) -> bool {
        let runs = self.runs.lock().unwrap();
        match runs.get(run_id) {
            Some(handle) => {
                handle.kill_requested.store(true, Ordering::SeqCst);
                let _ = handle.kill_tx.send(SignalKind::SIGTERM);
                true
            }
            None => false,
        }
    }
}

/// Removes the registry entry when dropped — covers normal completion,
/// timeout, kill, AND a panic unwinding the blocking thread, so entries can
/// never leak past a run's lifetime.
struct RunGuard {
    registry: ShellRegistry,
    run_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.run_id);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Core execution
// ═════════════════════════════════════════════════════════════════════════════

/// Parse a command string, mapping failures to [`ShellError::ParseError`].
/// Runs BEFORE any spawn or registry mutation — parse failures never spawn.
fn parse_command(command: &str) -> Result<SequentialList, ShellError> {
    deno_task_shell::parser::parse(command)
        .map_err(|e| ShellError::ParseError(e.to_string()))
}

/// Core run loop. MUST be driven by `block_on` on the run's dedicated
/// blocking thread (the `deno_task_shell` future is `!Send`).
///
/// Phases:
///   1. Race the execute future against (a) an external kill request on
///      `kill_rx` and (b) the overall timeout.
///   2. On kill/timeout: send `SIGTERM`, then await the same future with a
///      [`CLEANUP_GRACE`] grace period so it can terminate children and
///      return partial output. A grace expiry logs `shell.exec cleanup_hang`
///      and returns with whatever metadata is available (output may be
///      empty).
///
/// `killed` additionally consults the shared `kill_requested` flag — the
/// authoritative "user Stop" indicator (`KillSignal::aborted_code()` is NOT:
/// deno_task_shell itself SIGTERMs sibling commands whenever one pipeline
/// member fails, which would misreport every failing pipeline as "killed").
async fn run_parsed_command(
    list: SequentialList,
    cwd: PathBuf,
    env_vars: HashMap<OsString, OsString>,
    timeout: Duration,
    run_id: &str,
    mut kill_rx: UnboundedReceiver<SignalKind>,
    kill_requested: Arc<AtomicBool>,
) -> ShellExecResult {
    let started = Instant::now();
    let kill_signal = KillSignal::default();

    // One shared output pipe: the same writer is passed for BOTH stdout and
    // stderr, so the reader observes chronologically interleaved output
    // (ADR-0041 §4) rather than two separately buffered streams.
    let (out_reader, out_writer) = pipe();
    let state =
        ShellState::new(env_vars, cwd, HashMap::new(), kill_signal.clone());
    let output_task = out_reader.pipe_to_string_handle();

    // EOF stdin: a pipe whose writer end is dropped immediately (reads return
    // 0). Avoids `ShellPipeReader::stdin()` — it dups the app process's
    // stdin and its internal `unwrap()` can panic in a windowed app where
    // there is no console stdin.
    let (stdin_reader, stdin_writer) = pipe();
    drop(stdin_writer);

    let mut timed_out = false;
    let mut killed_by_signal = false;
    let mut cleanup_hang = false;
    let exit_code: Option<i32>;

    {
        let mut fut = pin!(execute_with_pipes(
            list,
            state,
            stdin_reader,
            out_writer.clone(),
            out_writer.clone(),
        ));

        enum Phase {
            Finished(i32),
            Killed,
        }

        // A closed kill channel (all senders dropped — cannot happen while
        // the run's registry entry exists) must NOT count as a kill: the
        // select precondition disables the branch instead of spinning on a
        // resolved `None`. Runtime-verified against a long-running external
        // process (SIGTERM → prompt unwind → `killed: true`).
        let phase = tokio::time::timeout(timeout, async {
            let mut kill_open = true;
            loop {
                tokio::select! {
                    code = &mut fut => return Phase::Finished(code),
                    kind = kill_rx.recv(), if kill_open => {
                        match kind {
                            Some(kind) => {
                                kill_signal.send(kind);
                                return Phase::Killed;
                            }
                            None => kill_open = false,
                        }
                    }
                }
            }
        })
        .await;

        match phase {
            Ok(Phase::Finished(code)) => {
                exit_code = Some(code);
            }
            Ok(Phase::Killed) => {
                killed_by_signal = true;
                match tokio::time::timeout(CLEANUP_GRACE, &mut fut).await {
                    Ok(_) => exit_code = None,
                    Err(_) => {
                        cleanup_hang = true;
                        exit_code = None;
                    }
                }
            }
            Err(_elapsed) => {
                timed_out = true;
                kill_signal.send(SignalKind::SIGTERM);
                match tokio::time::timeout(CLEANUP_GRACE, &mut fut).await {
                    Ok(_) => exit_code = None,
                    Err(_) => {
                        cleanup_hang = true;
                        exit_code = None;
                    }
                }
            }
        }
        // `fut` (and the `ShellState` inside it) drops at the end of this
        // scope: the Windows Job Object tracker's `Rc` releases (killing any
        // survivor that ignored the signal) and every writer clone closes,
        // letting the output drain below resolve.
    }
    drop(out_writer);

    if cleanup_hang {
        // The execute future did not unwind within the grace period. Its
        // drop above has already signalled the Job Object kill — report and
        // move on with whatever output the drain can salvage.
        tracing::warn!(run_id = %run_id, "shell.exec cleanup_hang");
    }

    let output = match tokio::time::timeout(OUTPUT_DRAIN_GRACE, output_task)
        .await
    {
        Ok(Ok(s)) => s,
        // Drain task panicked or the pipe was still held past the grace
        // (extreme edge; the Job Object kill is async) — return what we can.
        Ok(Err(_)) | Err(_) => String::new(),
    };

    let killed = killed_by_signal || kill_requested.load(Ordering::SeqCst);
    let (output, truncated, output_length) = truncate_output(output);
    ShellExecResult {
        exit_code,
        output,
        truncated,
        output_length,
        timed_out,
        killed,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

/// Cap output at [`MAX_OUTPUT_CHARS`] chars: head [`OUTPUT_HEAD_CHARS`] +
/// elision marker + tail [`OUTPUT_TAIL_CHARS`]. Returns the (possibly
/// truncated) output, whether truncation happened, and the pre-truncation
/// char count — applied only AFTER full capture, so `output_length` is never
/// a partial value.
fn truncate_output(output: String) -> (String, bool, usize) {
    let total = output.chars().count();
    if total <= MAX_OUTPUT_CHARS {
        return (output, false, total);
    }
    let head: String = output.chars().take(OUTPUT_HEAD_CHARS).collect();
    let tail: String =
        output.chars().skip(total - OUTPUT_TAIL_CHARS).collect();
    let omitted = total - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
    (
        format!("{head}\n...[truncated {omitted} chars]...\n{tail}"),
        true,
        total,
    )
}

// ═════════════════════════════════════════════════════════════════════════════
// Commands
// ═════════════════════════════════════════════════════════════════════════════

/// Execute a shell command string in the Space's context (ADR-0041 §5 —
/// frozen IPC contract; `timeoutMs`/`cwd` are optional, `runId` is generated
/// client-side so `shell_kill` can reference the run before this resolves).
#[tracing::instrument(
    skip(command, cwd, timeout_ms, state, registry),
    fields(run_id = %run_id, space_id = %space_id)
)]
#[tauri::command]
pub async fn shell_exec(
    space_id: String,
    run_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, DbManager>,
    registry: State<'_, ShellRegistry>,
) -> Result<ShellExecResult, ShellError> {
    // ── validation (rejects) ────────────────────────────────────────────────
    if command.trim().is_empty() {
        return Err(ShellError::InvalidInput(
            "command must not be empty".to_string(),
        ));
    }
    if let Some(cwd) = &cwd {
        if !Path::new(cwd).is_absolute() {
            return Err(ShellError::InvalidInput(format!(
                "cwd must be an absolute path: {cwd}"
            )));
        }
    }
    // Parse first: failures return to the model WITHOUT spawning anything.
    let list = parse_command(&command)?;

    // `space_id` feeds filesystem path construction — same UUID-shape
    // traversal guard every `with_space` call runs.
    DbManager::validate_id(&space_id)
        .map_err(|e| ShellError::InvalidInput(format!("invalid space id: {e}")))?;

    // ── input normalization (clamps, never rejects) ─────────────────────────
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let timeout = Duration::from_millis(timeout_ms);

    // Default cwd: the Space's data directory (same path convention as the
    // Space db — `DbManager::space_data_dir` is the single source of truth).
    let cwd = match cwd {
        Some(cwd) => PathBuf::from(cwd),
        None => {
            let dir = state.space_data_dir(&space_id);
            // Best-effort ensure: a Space dir normally exists by the time an
            // agent runs, but a wiped directory would otherwise surface as a
            // confusing "Error launching" exit from the spawned process.
            if let Err(e) = std::fs::create_dir_all(&dir) {
                tracing::debug!(
                    space_id = %space_id,
                    error = %e,
                    "shell.exec default_cwd create failed"
                );
            }
            dir
        }
    };

    // Full env inheritance from the app process (ADR-0041 §1 — `env_clear()`
    // is not viable, external-command resolution needs `PATH`).
    let env_vars: HashMap<OsString, OsString> = std::env::vars_os().collect();

    // Command string preview: prompt-adjacent content, TRACE-only tier
    // (ADR-0016 — same tier as AI response previews).
    let preview: String = command.chars().take(80).collect();
    tracing::trace!(run_id = %run_id, command_preview = %preview, "shell.exec preview");

    // ── registry + blocking-thread execution ────────────────────────────────
    let (kill_tx, kill_rx) = tokio::sync::mpsc::unbounded_channel();
    let kill_requested = Arc::new(AtomicBool::new(false));
    registry.register(
        run_id.clone(),
        kill_tx,
        Arc::clone(&kill_requested),
    );

    let guard_registry = ShellRegistry::clone(&registry);
    let run_id_for_thread = run_id.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        // Deregisters the registry entry on ANY exit path (incl. panic).
        let _guard =
            RunGuard { registry: guard_registry, run_id: run_id_for_thread.clone() };
        let runtime = tokio::runtime::Handle::current();
        runtime.block_on(run_parsed_command(
            list,
            cwd,
            env_vars,
            timeout,
            &run_id_for_thread,
            kill_rx,
            kill_requested,
        ))
    });

    let result = join
        .await
        .map_err(|e| ShellError::Internal(format!("shell task join error: {e}")))?;

    // Completion metadata only — command output is NEVER logged (ADR-0016
    // redaction "NEVER log" tier).
    tracing::info!(
        run_id = %run_id,
        space_id = %space_id,
        exit_code = result.exit_code,
        timed_out = result.timed_out,
        killed = result.killed,
        duration_ms = result.duration_ms,
        truncated = result.truncated,
        "shell.executed"
    );

    Ok(result)
}

/// Kill an in-flight `shell_exec` run (ADR-0041 §3). Idempotent: an unknown
/// or already-finished `run_id` is a logged no-op — the TS side fires this
/// fire-and-forget, frequently racing the exec resolving naturally.
#[tracing::instrument(skip(state), fields(run_id = %run_id))]
#[tauri::command]
pub fn shell_kill(
    run_id: String,
    state: State<'_, ShellRegistry>,
) -> Result<(), ShellError> {
    if !state.kill_run(&run_id) {
        tracing::debug!(run_id = %run_id, "shell.kill unknown_run");
    }
    Ok(())
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
#[path = "tests/shell.rs"]
mod tests;
