/**
 * Tests for the dispatch_subagent tool (ADR-0050 D3): the static 8-role
 * enum schema, the required task brief, execute's verbatim delegation to
 * `ctx.subagentRunner.run` (input + parentToolCallId anchoring +
 * abortSignal forwarding + result pass-through), and the consentLevel
 * "auto" classification. The runner is a vi.fn stub — the real dispatch
 * runtime is covered by the conversation-runtime store tests
 * (store.test.ts → "subagent dispatch runtime").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { subagentTools } from "@/lib/tools/subagent";
import type { SubagentDispatchResult, ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

// ─── Helpers (inline) ────────────────────────────────────────────────────

function makeToolContext(
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    spaceId: spaceIdSchema.parse("space-1"),
    worldId: worldIdSchema.parse("world-1"),
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(() => null), set: vi.fn(async () => {}) },
    threadLookup: { findToolPair: vi.fn(() => undefined) },
    skills: [],
    activatedSkills: new Set(),
    visionConfig: null,
    subagentRunner: { run: vi.fn() },
    attachmentLookup: { findByFilename: vi.fn(() => null) },
    entityImageLookup: { findByEntity: vi.fn(async () => null) },
    ...overrides,
  };
}

function dispatchTool(): ToolDef {
  const def = subagentTools().dispatch_subagent;
  if (!def) {
    throw new Error("dispatch_subagent tool not found");
  }
  return def;
}

/** See grep.test.ts — `FlexibleSchema` has no `.parse`, zod is the runtime reality. */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

type DispatchParsed = { role?: string; task?: string };

const schema = () => toZod<DispatchParsed>(dispatchTool().inputSchema);

const SIGNAL = () => new AbortController().signal;

const RUNNER_RESULT: SubagentDispatchResult = {
  runId: "run-conv-1",
  status: "completed",
  finalMessage: "Report: done.",
  usage: { input: 12, output: 34 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("dispatch_subagent", () => {
  describe("inputSchema", () => {
    it.each([
      "explorer",
      "curator",
      "scribe",
      "historian",
      "editor",
      "plotter",
      "writer",
      "critic",
    ])("accepts the roster role %s", (role) => {
      const parsed = schema().safeParse({ role, task: "do the thing" });
      expect(parsed.success).toBe(true);
    });

    it.each([
      { label: "unknown role", input: { role: "orchestrator", task: "self-dispatch" } },
      { label: "missing role", input: { task: "no role" } },
      { label: "missing task", input: { role: "writer" } },
      { label: "empty task", input: { role: "writer", task: "" } },
      { label: "empty input", input: {} },
    ])("rejects: $label", ({ input }) => {
      expect(schema().safeParse(input).success).toBe(false);
    });
  });

  it('is consentLevel "auto" (pure coordination — the child run carries its own gate, D5)', () => {
    expect(dispatchTool().consentLevel).toBe("auto");
  });

  it("delegates to ctx.subagentRunner.run with the parsed input + the SDK toolCallId anchor, forwards the abort signal, and returns the result verbatim", async () => {
    const run = vi.fn<
      (
        input: {
          role: string;
          task: string;
          parentToolCallId?: string;
        },
        abortSignal: AbortSignal,
      ) => Promise<SubagentDispatchResult>
    >(async () => RUNNER_RESULT);
    const ctx = makeToolContext({ subagentRunner: { run } });
    const abortSignal = SIGNAL();

    const got = await dispatchTool().execute(
      { role: "writer", task: "Draft scene ch-1/sc-2 in gothic prose." },
      ctx,
      { abortSignal, toolCallId: "tc-77" },
    );

    expect(got).toBe(RUNNER_RESULT);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      {
        role: "writer",
        task: "Draft scene ch-1/sc-2 in gothic prose.",
        parentToolCallId: "tc-77",
      },
      abortSignal,
    );
  });

  it("mints a UUID-shaped parentToolCallId fallback when the call options carry no toolCallId (direct execute calls)", async () => {
    const run = vi.fn<
      (
        input: {
          role: string;
          task: string;
          parentToolCallId?: string;
        },
        abortSignal: AbortSignal,
      ) => Promise<SubagentDispatchResult>
    >(async () => RUNNER_RESULT);
    const ctx = makeToolContext({ subagentRunner: { run } });

    await dispatchTool().execute(
      { role: "explorer", task: "Survey the worldbook." },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]?.[0];
    // UUID v4 shape (8-4-4-4-12 hex) — the fallback only fires outside the
    // SDK pipeline, but it must still be a stable unique anchor.
    expect(input?.parentToolCallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
