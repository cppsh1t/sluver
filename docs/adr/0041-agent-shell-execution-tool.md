# ADR-0041: Agent shell execution via `deno_task_shell` with always-on consent

**Status**: accepted.

## Context

The agent roles currently expose only IPC-backed CRUD and retrieval tools. Power users want the agent to run local commands (file management around the Space directory, exports, git, scripting helpers). Shell execution is the highest-risk tool category in the industry: the survey of Claude Code, Codex CLI, OpenHands, Gemini CLI, Cursor, Amp, Warp, VS Code Copilot and Aider shows a converged pattern — a parsing/validation layer in front of execution, per-command consent, hard timeout, output truncation, and a kill path that actually terminates the process tree.

Two structural gaps in our runtime had to be closed alongside: `ToolDef.execute` did not receive the run's `AbortSignal` (so a running command could not be stopped by the user), and the Rust side had no process-spawning capability at all.

## Decision

### 1. Execution layer — Rust-side `deno_task_shell`

A new Rust command family (`shell_exec` / `shell_kill`) executes the model's command string via [`deno_task_shell`](https://crates.io/crates/deno_task_shell): the string is parsed into an AST first (parse failure is returned to the model without spawning anything), built-ins (`cd`, `cp`, `rm`, `mkdir`, …) run as audited in-process Rust operations, and external commands are resolved via the `which` crate then spawned directly (no `cmd.exe` / PowerShell ever interprets the string). This eliminates shell-dialect ambiguity on Windows and the "validates-as-safe but executes-as-dangerous" parser-differential class. Alternatives rejected: spawning `cmd /c` / `powershell -Command` (loses argv control, dialect quirks, injection surface), `tauri-plugin-shell` (its scope is an IPC-layer ACL guarding only the webview surface; Rust-side calls bypass it entirely), PTY/`portable-pty` (only pays off for an embedded terminal UI; feeding VT-escaped output to the model is a loss).

Each call is a **one-shot session**: no persistent working directory or shell state across tool calls (unlike Claude Code's cwd tracking). `cwd` is an explicit input defaulting to the Space's data directory; the tool description tells the model to pass absolute paths.

The environment is **fully inherited** from the app process. `env_clear()` is not viable here because external-command resolution needs `PATH`; this is an accepted risk with a deny-list upgrade path (per ADR-0013-style threat honesty).

### 2. Consent — `always`, explorer role only

**Superseded by [ADR-0042](./0042-shell-tool-config-gated-auto-execution.md).** The `always` consent level below was replaced by a default-off, risk-acknowledged `shellToolEnabled` opt-in on the AgentConfig: OFF means the shell tool is not registered at all; ON registers it with `consentLevel: "auto"` (auto-executes, no per-call approval). The v1 explorer-only registration scope described below was likewise extended to the writer role by ADR-0042 §3. Every other section of this ADR is unchanged.

`consentLevel: "always"` — the gate can never be softened by `autoExecuteDangerousTools`. Shell access is also a deliberate, documented escape hatch from World isolation (ADR-0004): a command can touch anything the user can. Per-call explicit consent is the only gate, and the consent banner shows the raw command string. Registered on the **explorer** role only for v1 (least privilege; the writer role is prose-focused); adding it elsewhere is a one-line change in the role's `buildTools`.

### 3. Abort — `ToolCallOptions` third parameter on `ToolDef.execute`

```ts
export interface ToolCallOptions {
  readonly abortSignal: AbortSignal;
}

export interface ToolDef<I = unknown, O = unknown> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<I>;
  readonly consentLevel: ConsentLevel;
  readonly execute: (input: I, ctx: ToolContext, call: ToolCallOptions) => Promise<O>;
}
```

`buildToolSet` already receives the SDK's `options.abortSignal` in its wrapper (it forwards it to the approval gate); it now also forwards it as the third `execute` argument. Rationale: the signal is **per-run** (each `Agent.run()` creates a fresh internal `AbortController`) while `ToolContext` is **per-conversation** — putting the signal on `ctx` would misrepresent its scope or require another `agentRef`-style back-fill indirection for data that already has a direct path. Adding a library API (`Agent.currentRunSignal()`) would cross the ADR-0019 purity boundary to duplicate a source the SDK already provides. The parameter addition is non-breaking (TS functions with fewer parameters remain assignable) and touches only the app layer.

The shell tool uses the **listener + natural-resolve** pattern: on abort it fires `shell_kill(runId)` fire-and-forget, and the main `shell_exec` invoke resolves naturally with `killed: true` — one promise, deterministic result shape, no discarded dangling invokes. Ordering with the consent gate is inherently safe: a pending approval auto-denies on abort (ADR-0025), so an aborted run never reaches spawn.

`runId` is generated client-side (`crypto.randomUUID()`) so the kill command can reference the run before the exec invoke returns.

Defense in depth, three layers: abort signal (user Stop) → Rust-side timeout (bound) → future Job-Object kill-on-close (app crash — deferred, see Future Work).

### 4. Timeout and output caps

`timeoutMs` input clamped to [1_000, 600_000], default **120_000** (industry consensus: Claude Code 2 min default / 10 min max). Rust enforces the clamp independently. Output (stdout and stderr merged, chronologically interleaved) is capped at **30_000 chars** — head+tail truncation with an elision marker and the pre-truncation length reported (`outputLength`, `truncated`) so the model knows to redirect to a file or use paging. On timeout the kill signal fires, the result carries `timedOut: true` and partial output.

### 5. Frozen IPC contract

```ts
// invoke("shell_exec", { spaceId, runId, command, cwd?, timeoutMs? })
interface ShellExecResult {
  exitCode: number | null;   // null when killed / timed out without exit
  output: string;            // merged stdout+stderr, truncated
  truncated: boolean;
  outputLength: number;      // pre-truncation char count
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}
// invoke("shell_kill", { runId }) — idempotent, unknown runId is a no-op
```

Errors serialize to the existing `ErrorPayload { code, message, args }` shape: parse failures use the stable code `SHELL_PARSE_ERROR` (model-facing, message suffices — no i18n value), infrastructure failures use `INTERNAL_ERROR`, mirroring `db/error.rs`.

### 6. Logging (ADR-0016)

Metadata only: `run_id`, `space_id`, `exit_code`, `timed_out`, `killed`, `duration_ms`, `truncated` at INFO on completion (`shell.executed`). The command string's first 80 chars at TRACE (prompt-adjacent content, same tier as AI response previews). **Command output is NEVER logged at any level** — it can contain creative content.

## Consequences

**Positive:** deterministic cross-platform execution semantics on Windows-first; zero shell-dialect attack surface; kill actually works from the user's Stop button; the consent gate, banner UI, abort plumbing and GenericToolCard rendering all work with no UI changes.

**Negative / accepted risks:** full env inheritance; no persistent shell session (model repeats cwd or uses absolute paths); `deno_task_shell` futures are `!Send`, so execution runs on a blocking thread with `block_on` and a registry of kill channels keyed by `runId` (the `KillSignal` itself is also `!Send` and stays on that thread — this is also what makes `shell_kill` cheap).

**Better than planned (source-verified against 0.33.3):** upstream assigns every spawned child to a per-run Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — when the run's state drops (normal exit, kill, or app crash) the whole process tree dies. The kill path is doubly covered: `KillSignal::send(SIGTERM)` → `child.start_kill()` (TerminateProcess) for immediate stop, and the Job Object as crash safety.

## Future work

- **Streaming output byte cap**: output currently accumulates fully in memory (the upstream drain reads the pipe to EOF) before the 30k-char truncation is applied — a fast-flooding command within the timeout window can inflate RSS unboundedly. A head+tail ring-buffer drain with a few-MB byte ceiling closes this; blocked on upstream `ShellPipeReader`/`ShellPipeWriter` being enums (no wrapping seam), so it needs a custom drain path.
- **Job Object kill-on-close** per run (needs vendoring/patching `deno_task_shell`'s external-spawn path, which owns the `tokio::process` calls) and **AppContainer hardening** (`rappct`; requires direct `CreateProcessW`, incompatible with stable-Rust std/tokio spawn).
- **AST-derived consent preview**: walk the parsed `SequentialList` to show the user exactly which built-ins/externals will run, instead of the raw string.
- **Prefix-based "don't ask again"** with computed command prefixes (Claude Code pattern: static parser, no rule when no safe prefix exists) — deliberately absent from v1.
- **Background tasks** (`runInBackground`) with a TaskOutput/TaskStop-style tool split, and a model-facing kill tool (both callers share the same `shell_kill` command).
- Persistent session semantics (cwd/env tracking) if the one-shot model proves limiting.

## References

- ADR-0025 (execute-blocking consent gate this tool rides on), ADR-0016 (log redaction), ADR-0004 (World isolation this tool deliberately escapes), ADR-0019 (purity boundary — unchanged by this ADR).
- Industry survey (Claude Code bash engine, Codex CLI sandboxing, OpenHands PS1-sentinel sessions, Gemini CLI policy engine) — informed timeout/output defaults and the kill-path design.
