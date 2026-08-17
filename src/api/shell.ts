/**
 * Shell execution IPC API (ADR-0041).
 *
 * One-shot shell execution via the Rust-side `deno_task_shell` engine: the
 * command string is parsed into an AST (parse failure rejects with the
 * stable code `SHELL_PARSE_ERROR` without spawning anything), built-ins run
 * as audited in-process operations, and external commands are spawned
 * directly with argv control. Each call starts fresh — no persistent
 * working directory or shell state across calls. See `@/lib/tools/shell`
 * for the agent-facing tool built on this.
 *
 * Rejections carry the standard {@link ErrorPayload} shape (see
 * `@/api/client`). NOTE (ADR-0016 NEVER-log): command output may contain
 * creative content — it is never logged at any level.
 */

import { call } from './client';

/**
 * Result of a completed shell run (frozen contract — ADR-0041 §5).
 * Serialized camelCase from the Rust side.
 */
export interface ShellExecResult {
  /** Process exit code — `null` when killed / timed out without an exit. */
  exitCode: number | null;
  /** Merged stdout+stderr (chronologically interleaved), truncated to the cap. */
  output: string;
  /** True when `output` was head+tail truncated. */
  truncated: boolean;
  /** Pre-truncation output length in chars. */
  outputLength: number;
  /** True when the server-side timeout ended the run. */
  timedOut: boolean;
  /** True when a client-side `shell_kill` ended the run (user abort). */
  killed: boolean;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

/**
 * Arguments for the `shell_exec` command. A type alias (not an interface)
 * so instances satisfy `call()`'s `Record<string, unknown>` parameter via
 * the implicit index signature.
 */
export type ShellExecInput = {
  /** The Space whose data directory `cwd` defaults to. */
  spaceId: string;
  /**
   * Client-generated run identifier (`crypto.randomUUID()`) — created before
   * the invoke so `shell_kill` can reference a run still in flight.
   */
  runId: string;
  /** The raw command string, parsed and executed server-side. */
  command: string;
  /** Absolute working directory path. Defaults to the Space's data directory. */
  cwd?: string;
  /** Kill the command after this long (clamped server-side to [1s, 10min]). */
  timeoutMs?: number;
}

/**
 * Execute a one-shot shell command and wait for it to finish. Resolves with
 * the terminal result (exit, timeout, or kill) — including when the run was
 * ended by {@link shellKill} (`killed: true`).
 */
export function shellExec(input: ShellExecInput): Promise<ShellExecResult> {
  return call<ShellExecResult>('shell_exec', input);
}

/**
 * Kill an in-flight shell run by its `runId`. Idempotent — an unknown or
 * already-finished runId is a no-op, so fire-and-forget abort listeners can
 * call it unconditionally.
 */
export function shellKill(runId: string): Promise<void> {
  return call<void>('shell_kill', { runId });
}
