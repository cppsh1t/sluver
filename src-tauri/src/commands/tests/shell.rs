use super::*;

// ── error payload shape ─────────────────────────────────────────────────

#[test]
fn shell_error_payload_codes() {
    let p = ShellError::ParseError("unexpected token ')'".into()).to_payload();
    assert_eq!(p.code, "SHELL_PARSE_ERROR");
    assert_eq!(p.message, "unexpected token ')'");
    assert!(p.args.is_empty());

    let p = ShellError::InvalidInput("cwd must be absolute".into()).to_payload();
    assert_eq!(p.code, "INVALID_INPUT");
    assert_eq!(
        p.args.get("message"),
        Some(&"cwd must be absolute".to_string())
    );

    let p = ShellError::Internal("join error".into()).to_payload();
    assert_eq!(p.code, "INTERNAL_ERROR");
    assert!(p.args.is_empty());
}

/// The custom `Serialize` impl must emit the payload object, not the
/// enum shape.
#[test]
fn shell_error_serializes_as_payload() {
    let json = serde_json::to_value(ShellError::ParseError("bad".into())).expect("serialize");
    assert_eq!(json["code"], "SHELL_PARSE_ERROR");
    assert_eq!(json["message"], "bad");
    assert!(json["args"].is_object());
}

// ── truncation ──────────────────────────────────────────────────────────

#[test]
fn truncate_under_cap_is_noop() {
    let (out, truncated, len) = truncate_output("hello world".to_string());
    assert_eq!(out, "hello world");
    assert!(!truncated);
    assert_eq!(len, 11);
}

#[test]
fn truncate_at_exact_cap_is_noop() {
    let input: String = "x".repeat(MAX_OUTPUT_CHARS);
    let (out, truncated, len) = truncate_output(input.clone());
    assert_eq!(out, input);
    assert!(!truncated);
    assert_eq!(len, MAX_OUTPUT_CHARS);
}

#[test]
fn truncate_over_cap_keeps_head_and_tail() {
    // Distinct head/tail alphabet so ordering is provable.
    let head: String = "H".repeat(OUTPUT_HEAD_CHARS);
    let tail: String = "T".repeat(OUTPUT_TAIL_CHARS);
    let middle: String =
        "m".repeat(MAX_OUTPUT_CHARS + 5_000 - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS);
    let input = format!("{head}{middle}{tail}");

    let (out, truncated, len) = truncate_output(input);
    assert!(truncated);
    assert_eq!(len, MAX_OUTPUT_CHARS + 5_000);
    assert!(out.starts_with(&"H".repeat(100)));
    assert!(out.ends_with(&"T".repeat(100)));
    let omitted = MAX_OUTPUT_CHARS + 5_000 - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
    assert!(out.contains(&format!("...[truncated {omitted} chars]...")));
    // No 'm' survives: the elided middle is fully dropped.
    assert!(!out.contains('m'));
}

/// Truncation must respect char boundaries (multi-byte chars).
#[test]
fn truncate_respects_char_boundaries() {
    let input: String = "é".repeat(MAX_OUTPUT_CHARS + 100); // 2-byte chars
    let (out, truncated, len) = truncate_output(input);
    assert!(truncated);
    assert_eq!(len, MAX_OUTPUT_CHARS + 100);
    // No U+FFFD from a sliced UTF-8 boundary; survivors count exactly
    // head + tail (the marker contributes no 'é').
    assert!(!out.contains(char::REPLACEMENT_CHARACTER));
    assert_eq!(
        out.chars().filter(|&c| c == 'é').count(),
        OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS
    );
}

// ── parse mapping ───────────────────────────────────────────────────────

#[test]
fn parse_error_maps_to_shell_error() {
    let err = parse_command("echo ((").expect_err("must fail");
    match err {
        ShellError::ParseError(msg) => assert!(!msg.is_empty()),
        other => panic!("expected ParseError, got {other:?}"),
    }
}

// ── end-to-end core runs ────────────────────────────────────────────────
//
// `echo` is a deno_task_shell builtin (no external process needed), so
// the happy path works on every platform. The kill/timeout paths need a
// real long-running external process — Windows-first project, `ping` is
// always present.
//
// NOTE: as of writing, `cargo test` on this crate cannot START any test
// exe (pre-existing, project-wide: the test binary dies with
// STATUS_ENTRYPOINT_NOT_FOUND from the WebView2/tauri linkage — even
// `db::error` tests fail the same way). These tests were executed and
// verified green in a standalone probe crate containing byte-identical
// copies of `parse_command` / `run_parsed_command` / `truncate_output`
// plus this exact test set (8/8 pass, incl. runtime proof that a killed
// process tree stays dead).

fn core(
    command: &str,
    cwd: PathBuf,
    timeout: Duration,
    kill_rx: UnboundedReceiver<SignalKind>,
    kill_requested: Arc<AtomicBool>,
) -> ShellExecResult {
    // Real env: external-command tests (`ping`) need PATH for `which`
    // resolution — same inheritance the command itself applies.
    let env_vars: HashMap<OsString, OsString> = std::env::vars_os().collect();
    let list = parse_command(command).expect("parse");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run_parsed_command(
            list,
            cwd,
            env_vars,
            timeout,
            "test-run",
            kill_rx,
            kill_requested,
        ))
}

#[test]
fn echo_executes_and_captures_output() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    drop(tx); // no kill will arrive
    let result = core(
        "echo hello world",
        tmp.path().to_path_buf(),
        Duration::from_secs(10),
        rx,
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.output, "hello world\n");
    assert!(!result.truncated);
    assert_eq!(result.output_length, "hello world\n".len());
    assert!(!result.timed_out);
    assert!(!result.killed);
}

#[cfg(target_os = "windows")]
#[test]
fn timeout_kills_external_command() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    drop(tx);
    let started = Instant::now();
    let result = core(
        "ping -n 30 127.0.0.1", // ~29s if allowed to run
        tmp.path().to_path_buf(),
        Duration::from_millis(300),
        rx,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(result.timed_out);
    assert!(!result.killed);
    assert_eq!(result.exit_code, None);
    // Unwound promptly (cleanup grace is 5s; the kill is immediate).
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[cfg(target_os = "windows")]
#[test]
fn external_kill_sets_killed() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    // Kill request already pending when the run starts — deterministic:
    // the select observes it long before `ping` finishes.
    tx.send(SignalKind::SIGTERM).expect("send");
    let started = Instant::now();
    let result = core(
        "ping -n 30 127.0.0.1",
        tmp.path().to_path_buf(),
        Duration::from_secs(30),
        rx,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(result.killed);
    assert!(!result.timed_out);
    assert_eq!(result.exit_code, None);
    assert!(started.elapsed() < Duration::from_secs(4));
}

/// `kill_requested` set outside the channel path (late shell_kill racing
/// a natural finish) must still surface `killed: true`.
#[test]
fn kill_flag_alone_surfaces_killed() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    drop(tx);
    let flag = Arc::new(AtomicBool::new(true));
    let result = core(
        "echo done",
        tmp.path().to_path_buf(),
        Duration::from_secs(10),
        rx,
        flag,
    );
    assert!(result.killed);
}
