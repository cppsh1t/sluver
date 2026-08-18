/**
 * Tests for the shell execution tool `run_shell_command` (ADR-0041 / ADR-0042):
 * execute wiring, client-generated runId, abort → shell_kill, and schema
 * bounds. The IPC layer (`@/api/shell`) is mocked — never real Tauri IPC.
 *
 * Registration gating by `ctx.shellToolEnabled` is owned by the sibling
 * worldbook test suite; here we exercise the ToolDef itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { shellExec, shellKill, type ShellExecResult } from "@/api/shell";
import { shellTools } from "@/lib/tools/shell";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

vi.mock("@/api/shell", () => ({
  shellExec: vi.fn(),
  shellKill: vi.fn(),
}));

// ─── Helpers (inline) ────────────────────────────────────────────────────

function makeToolContext(): ToolContext {
  return {
    spaceId: spaceIdSchema.parse("space-1"),
    worldId: worldIdSchema.parse("world-1"),
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: true,
    planAccess: { get: vi.fn(() => null), set: vi.fn(async () => {}) },
    threadLookup: { findToolPair: vi.fn(() => undefined) },
    skills: [],
    activatedSkills: new Set(),
  };
}

function shellTool(): ToolDef {
  const def = shellTools().run_shell_command;
  if (!def) {
    throw new Error("run_shell_command not found");
  }
  return def;
}

/**
 * `ToolDef.inputSchema` is typed as the SDK's `FlexibleSchema` union (no
 * `.parse`), but every tool in this module hands `buildToolSet` a plain zod
 * object — a single `as unknown as` bridge recovers the typed schema.
 */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

/** Parsed output shape of the shell input schema (timeoutMs defaulted → required). */
type ShellParsed = { command: string; cwd?: string; timeoutMs: number };

const execMock = vi.mocked(shellExec);
const killMock = vi.mocked(shellKill);

const SUCCESS: ShellExecResult = {
  exitCode: 0,
  output: "ok",
  truncated: false,
  outputLength: 2,
  timedOut: false,
  killed: false,
  durationMs: 12,
};

const KILLED: ShellExecResult = {
  exitCode: null,
  output: "",
  truncated: false,
  outputLength: 0,
  timedOut: false,
  killed: true,
  durationMs: 5,
};

// `crypto.randomUUID()` emits lowercase v4 UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const shellSchema = () => toZod<ShellParsed>(shellTools().run_shell_command.inputSchema);

// ─── Tests ───────────────────────────────────────────────────────────────

describe("run_shell_command", () => {
  beforeEach(() => {
    execMock.mockReset();
    killMock.mockReset();
  });

  it("executes with a client-generated runId and forwards space + input fields", async () => {
    execMock.mockResolvedValue(SUCCESS);
    const ctx = makeToolContext();

    const result = await shellTool().execute(
      { command: "git status", cwd: "D:/work", timeoutMs: 5_000 },
      ctx,
      { abortSignal: new AbortController().signal },
    );

    expect(result).toBe(SUCCESS);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith({
      spaceId: ctx.spaceId,
      runId: expect.stringMatching(UUID_RE),
      command: "git status",
      cwd: "D:/work",
      timeoutMs: 5_000,
    });
    expect(killMock).not.toHaveBeenCalled();
  });

  it("aborts the in-flight run: shell_kill fires with the same runId, then exec resolves naturally", async () => {
    let resolveExec: (value: ShellExecResult) => void = () => {};
    const pendingExec = new Promise<ShellExecResult>((resolve) => {
      resolveExec = resolve;
    });
    execMock.mockImplementation(() => pendingExec);
    killMock.mockResolvedValue(undefined);

    const controller = new AbortController();
    // The async execute body runs synchronously up to the `await shellExec(...)`,
    // so the runId is already committed by the time the promise is returned.
    const pending = shellTool().execute({ command: "sleep 100" }, makeToolContext(), {
      abortSignal: controller.signal,
    });

    const runId = execMock.mock.calls[0]?.[0].runId;
    expect(runId).toMatch(UUID_RE);
    expect(killMock).not.toHaveBeenCalled();

    controller.abort();

    expect(killMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledWith(runId);

    // Listener + natural-resolve pattern: the exec invoke settles with killed:true.
    resolveExec(KILLED);
    await expect(pending).resolves.toBe(KILLED);
  });

  it("applies the 120_000ms timeout default via schema parse (execute calls bypass zod)", () => {
    expect(shellSchema().parse({ command: "x" }).timeoutMs).toBe(120_000);

    // Direct execute calls skip zod, so an omitted timeoutMs forwards as undefined.
    execMock.mockResolvedValue(SUCCESS);
    void shellTool().execute(
      { command: "x" },
      makeToolContext(),
      { abortSignal: new AbortController().signal },
    );
    expect(execMock.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
  });

  describe("inputSchema bounds", () => {
    it.each([
      { label: "command 1 char (min)", input: { command: "x" }, ok: true },
      { label: "command empty", input: { command: "" }, ok: false },
      { label: "command 10_000 chars (max)", input: { command: "x".repeat(10_000) }, ok: true },
      { label: "command 10_001 chars", input: { command: "x".repeat(10_001) }, ok: false },
      { label: "timeoutMs 1_000 (min)", input: { command: "x", timeoutMs: 1_000 }, ok: true },
      { label: "timeoutMs 999", input: { command: "x", timeoutMs: 999 }, ok: false },
      { label: "timeoutMs 600_000 (max)", input: { command: "x", timeoutMs: 600_000 }, ok: true },
      { label: "timeoutMs 600_001", input: { command: "x", timeoutMs: 600_001 }, ok: false },
      { label: "timeoutMs non-integer", input: { command: "x", timeoutMs: 1_000.5 }, ok: false },
      { label: "cwd optional string", input: { command: "x", cwd: "D:/tmp" }, ok: true },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(shellSchema().safeParse(input).success).toBe(ok);
    });
  });
});
