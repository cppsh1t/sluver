/**
 * Shell execution tool — `run_shell_command` (ADR-0041).
 *
 * One-shot shell execution on the user's machine via the Rust-side
 * `deno_task_shell` engine (see `@/api/shell`): built-ins (`cd`, `cp`,
 * `rm`, `mkdir`, …) run as audited in-process operations, external
 * commands are resolved from PATH and spawned directly — no `cmd.exe` /
 * PowerShell ever interprets the string. Each call is a FRESH session (no
 * persistent cwd/shell state); the input descriptions tell the model to
 * use absolute paths or pass `cwd`, and to redirect large output to a file
 * (output is head+tail truncated past 30k chars).
 *
 * Consent level: `auto` (ADR-0042, supersedes ADR-0041 §2) — the tool is
 * gated by REGISTRATION, not the per-call approval gate: it is only
 * registered when the AgentConfig's `shellToolEnabled` flag is on, and
 * once registered it auto-executes without per-call confirmation.
 * Registered on both the explorer and writer roles (ADR-0042 §3), each
 * gated by its own AgentConfig's flag; the namer never carries it.
 *
 * Abort (ADR-0041 §3): listener + natural-resolve pattern — on abort the
 * kill fires fire-and-forget and the `shell_exec` invoke resolves
 * naturally with `killed: true`. `runId` is generated client-side so the
 * kill can reference the run before the exec invoke returns. Ordering
 * with the consent gate is inherently safe: a pending approval
 * auto-denies on abort (ADR-0025).
 *
 * NOTE (ADR-0016 NEVER-log): command output may contain creative content —
 * never logged at any level (this tool adds no logging of its own).
 */

import { z } from "zod";

import { shellExec, shellKill } from "@/api/shell";
import type { ToolDef } from "./types";

/**
 * Widened input shape re-asserted at the execute boundary — the SDK hands
 * `execute` a parsed-but-`unknown` input (same cast pattern as `grep.ts`).
 */
interface ShellToolInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "One-shot shell command to execute. There is NO persistent state between calls — each call starts a fresh shell with no memory of previous calls, so use absolute paths or pass cwd. Output beyond 30k chars is head+tail truncated; prefer redirecting large output to a file and reading slices of it.",
    ),
  cwd: z
    .string()
    .optional()
    .describe("Absolute working directory path. Defaults to the Space's data directory."),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000)
    .describe("Kill the command after this long (clamped server-side to [1s, 10min])."),
});

/** Shell execution tool, keyed by `snake_case` name. */
export function shellTools(): Record<string, ToolDef> {
  return {
    run_shell_command: {
      description:
        "Execute a one-shot shell command on the user's machine and return its merged stdout+stderr. " +
        "Runs via a cross-platform shell: built-ins (cd, cp, mv, rm, mkdir, …) execute in-process; external commands (git, python, node, …) are resolved from PATH and run directly. " +
        "Each call starts FRESH — no working directory, variables, or state persist between calls; use absolute paths or pass cwd. " +
        "The environment is fully inherited from the app (same permissions as the user). " +
        "Output is capped: past 30k chars it is head+tail truncated (truncated/outputLength report this) — redirect large output to a file and read slices instead. " +
        "exitCode is null when the run was killed or timed out (timedOut/killed flags say which). " +
        "Use for file management around the Space directory, exports, git operations, and scripting helpers.",
      inputSchema,
      consentLevel: "auto",
      execute: async (input, ctx, call) => {
        const { command, cwd, timeoutMs } = input as ShellToolInput;
        // Client-generated runId so shell_kill can reference the run before
        // the exec invoke returns (ADR-0041 §3).
        const runId = crypto.randomUUID();
        // Listener + natural-resolve: on abort, fire the kill
        // fire-and-forget; the exec invoke below then resolves naturally
        // with killed: true — one promise, no dangling invokes.
        const onAbort = () => {
          void shellKill(runId).catch(() => {});
        };
        call.abortSignal.addEventListener("abort", onAbort);
        try {
          return await shellExec({
            spaceId: ctx.spaceId,
            runId,
            command,
            cwd,
            timeoutMs,
          });
        } finally {
          call.abortSignal.removeEventListener("abort", onAbort);
        }
      },
    },
  };
}
