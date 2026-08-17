/**
 * Tests for the system tools: `get_current_time`, `plan`, and `context_read`.
 *
 * All IPC / worker dependencies are mocked — `systemTools()` also spreads the
 * TimeMapper tools, so the TimeMapper façade is mocked to keep the import
 * chain free of worker / IPC side effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallPart, ToolResultPart } from "ai";

import { systemTools } from "@/lib/tools/system";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

vi.mock("@/lib/timemapper/format", () => ({
  formatTime: vi.fn(),
}));

// ─── Stub ToolContext (inline builder) ───────────────────────────────────

function makeToolContext(
  overrides: {
    planAccess?: ToolContext["planAccess"];
    threadLookup?: ToolContext["threadLookup"];
  } = {},
): ToolContext {
  return {
    spaceId: spaceIdSchema.parse("space-1"),
    worldId: worldIdSchema.parse("world-1"),
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: overrides.planAccess ?? {
      get: vi.fn(() => null),
      set: vi.fn(async () => {}),
    },
    threadLookup: overrides.threadLookup ?? {
      findToolPair: vi.fn(() => undefined),
    },
  };
}

function tool(name: string): ToolDef {
  const def = systemTools()[name];
  if (!def) {
    throw new Error(`system tool "${name}" not found`);
  }
  return def;
}

const callOptions = () => ({ abortSignal: new AbortController().signal });

// ─── get_current_time ────────────────────────────────────────────────────

describe("get_current_time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The tool formats with `Intl.DateTimeFormat(undefined, …)` — the runtime's
   * default locale — so the expectation is computed with an independent
   * formatter using the exact same semantics. Exact-string equality still
   * catches any drift in the fields the tool passes (timezone wiring, dateStyle,
   * timeStyle, and the faked system time).
   */
  it("formats the faked system time in the explicit timezone", async () => {
    const now = new Date("2024-03-15T10:30:00Z");
    vi.setSystemTime(now);

    const result = await tool("get_current_time").execute(
      { timezone: "Asia/Shanghai" },
      makeToolContext(),
      callOptions(),
    );

    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: "Asia/Shanghai",
    }).format(now);
    expect(result).toEqual({ iso: "2024-03-15T10:30:00.000Z", formatted: expected });
  });

  it("honors the timezone — different zones produce different wall-clock strings", async () => {
    vi.setSystemTime(new Date("2024-03-15T10:30:00Z"));

    const shanghai = await tool("get_current_time").execute(
      { timezone: "Asia/Shanghai" },
      makeToolContext(),
      callOptions(),
    );
    const newYork = await tool("get_current_time").execute(
      { timezone: "America/New_York" },
      makeToolContext(),
      callOptions(),
    );

    const format = (timeZone: string) =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(new Date("2024-03-15T10:30:00Z"));

    expect(shanghai).toEqual({
      iso: "2024-03-15T10:30:00.000Z",
      formatted: format("Asia/Shanghai"),
    });
    expect(newYork).toEqual({
      iso: "2024-03-15T10:30:00.000Z",
      formatted: format("America/New_York"),
    });
    expect(format("Asia/Shanghai")).not.toBe(format("America/New_York"));
  });

  it("omitting the timezone uses the system default and still succeeds", async () => {
    vi.setSystemTime(new Date("2024-03-15T10:30:00Z"));

    const result = await tool("get_current_time").execute({}, makeToolContext(), callOptions());

    expect(result).toEqual({
      iso: "2024-03-15T10:30:00.000Z",
      formatted: expect.any(String),
    });
  });

  it("rejects with a RangeError for an invalid IANA timezone", async () => {
    await expect(
      tool("get_current_time").execute(
        { timezone: "Not/AZone" },
        makeToolContext(),
        callOptions(),
      ),
    ).rejects.toThrow(RangeError);
  });
});

// ─── plan ─────────────────────────────────────────────────────────────────

describe("plan", () => {
  it("writes the wholesale-replacement Plan via planAccess.set and echoes per-status counts", async () => {
    const set = vi.fn(async () => {});
    const ctx = makeToolContext({
      planAccess: { get: vi.fn(() => null), set },
    });
    const items = [
      { text: "draft the scene", status: "pending" },
      { text: "check timeline", status: "in_progress" },
      { text: "name the city", status: "done" },
      { text: "fix chapter order", status: "done" },
    ];

    const result = await tool("plan").execute({ items }, ctx, callOptions());

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ items });
    expect(result).toEqual({
      plan: { items },
      pendingCount: 1,
      inProgressCount: 1,
      doneCount: 2,
    });
  });

  it("an empty items array clears the Plan", async () => {
    const set = vi.fn(async () => {});
    const ctx = makeToolContext({
      planAccess: { get: vi.fn(() => null), set },
    });

    const result = await tool("plan").execute({ items: [] }, ctx, callOptions());

    expect(set).toHaveBeenCalledWith({ items: [] });
    expect(result).toEqual({
      plan: { items: [] },
      pendingCount: 0,
      inProgressCount: 0,
      doneCount: 0,
    });
  });
});

// ─── context_read ─────────────────────────────────────────────────────────

describe("context_read", () => {
  const callPart: ToolCallPart = {
    type: "tool-call",
    toolCallId: "tc-42",
    toolName: "get_character",
    input: { id: "c-1" },
  };

  function ctxWithPair(output: ToolResultPart["output"]): ToolContext {
    const pair: { call: ToolCallPart; result: ToolResultPart } = {
      call: callPart,
      result: { type: "tool-result", toolCallId: "tc-42", toolName: "get_character", output },
    };
    return makeToolContext({
      threadLookup: { findToolPair: vi.fn(() => pair) },
    });
  }

  const statusCases: ReadonlyArray<{
    output: ToolResultPart["output"];
    status: "succeeded" | "failed" | "denied";
  }> = [
    { output: { type: "text", value: "Li Bai" }, status: "succeeded" },
    { output: { type: "json", value: { count: 2 } }, status: "succeeded" },
    { output: { type: "error-text", value: "boom" }, status: "failed" },
    { output: { type: "error-json", value: { code: 7 } }, status: "failed" },
    { output: { type: "execution-denied" }, status: "denied" },
  ];

  it.each(statusCases)("expands the stub for output $output.type → $status", async ({ output, status }) => {
    const result = await tool("context_read").execute(
      { toolCallId: "tc-42" },
      ctxWithPair(output),
      callOptions(),
    );

    expect(result).toEqual({
      toolName: "get_character",
      input: { id: "c-1" },
      output,
      status,
    });
  });

  it("resolves (never rejects) with a structured not_found payload for an unknown id", async () => {
    const ctx = makeToolContext(); // findToolPair → undefined

    const result = await tool("context_read").execute(
      { toolCallId: "tc-missing" },
      ctx,
      callOptions(),
    );

    expect(result).toEqual({
      error: "not_found",
      toolCallId: "tc-missing",
      message:
        'No tool call with id "tc-missing" in the thread. The id may be incorrect or the call evicted.',
    });
  });
});
