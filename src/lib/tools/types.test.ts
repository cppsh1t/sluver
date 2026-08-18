/**
 * Tests for the tool-infrastructure core (ADR-0025): the `needsConsent`
 * truth table, `ToolDeniedError`, and `buildToolSet`'s consent-gate wiring
 * around each tool's `execute`.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ToolSet } from "@/lib/ai";
import {
  buildToolSet,
  needsConsent,
  ToolDeniedError,
  type ConsentLevel,
  type ToolContext,
  type ToolDef,
} from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

// ─── Stub ToolContext (inline builder — no shared helpers) ───────────────

/**
 * Build a fully-stubbed `ToolContext`. The branded ids come from the real
 * zod schema factories (`.parse` returns the branded type), so no `as any`
 * is needed anywhere.
 */
function makeToolContext(
  overrides: Partial<
    Pick<ToolContext, "autoExecuteDangerousTools" | "shellToolEnabled">
  > = {},
): ToolContext {
  return {
    spaceId: spaceIdSchema.parse("space-1"),
    worldId: worldIdSchema.parse("world-1"),
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: overrides.autoExecuteDangerousTools ?? false,
    shellToolEnabled: overrides.shellToolEnabled ?? false,
    planAccess: {
      get: vi.fn(() => null),
      set: vi.fn(async () => {}),
    },
    threadLookup: { findToolPair: vi.fn(() => undefined) },
    skills: [],
    activatedSkills: new Set(),
  };
}

/** A stub ToolDef with an injectable consent level + execute spy. */
function makeDef(consentLevel: ConsentLevel, execute: ToolDef["execute"]): ToolDef {
  return {
    description: "stub tool for gate wiring tests",
    inputSchema: z.object({ value: z.number() }),
    consentLevel,
    execute,
  };
}

/**
 * Invoke a compiled tool's SDK `execute` the way `streamText` would.
 * `tool()` is a runtime identity, so this exercises the exact consent-gate
 * wrapper `buildToolSet` installed.
 */
function callTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  abortSignal: AbortSignal,
): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) {
    throw new Error(`tool "${name}" has no execute function`);
  }
  return execute(input, {
    toolCallId: "call-1",
    messages: [],
    abortSignal,
    context: {},
  });
}

// ─── needsConsent ─────────────────────────────────────────────────────────

describe("needsConsent", () => {
  const truthTable: ReadonlyArray<{
    level: ConsentLevel;
    auto: boolean;
    expected: boolean;
  }> = [
    { level: "auto", auto: true, expected: false },
    { level: "auto", auto: false, expected: false },
    { level: "configurable", auto: true, expected: false },
    { level: "configurable", auto: false, expected: true },
    { level: "always", auto: true, expected: true },
    { level: "always", auto: false, expected: true },
  ];

  it.each(truthTable)('consentLevel "$level" + autoExecuteDangerousTools $auto → $expected', ({ level, auto, expected }) => {
    expect(needsConsent(level, auto)).toBe(expected);
  });
});

// ─── ToolDeniedError ──────────────────────────────────────────────────────

describe("ToolDeniedError", () => {
  it("carries the tool name and the stable do-not-retry message", () => {
    const error = new ToolDeniedError("delete_character");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ToolDeniedError");
    expect(error.toolName).toBe("delete_character");
    expect(error.message).toBe(
      'The user denied the "delete_character" tool call. Do not retry the same action without changing your approach.',
    );
  });
});

// ─── buildToolSet consent-gate wiring ─────────────────────────────────────

describe("buildToolSet", () => {
  it("compiles one SDK tool per definition, keyed by name", () => {
    const tools = buildToolSet(
      {
        alpha: makeDef("auto", vi.fn(async () => 1)),
        beta: makeDef("always", vi.fn(async () => 2)),
      },
      makeToolContext(),
    );
    expect(Object.keys(tools).sort()).toEqual(["alpha", "beta"]);
  });

  it("auto tool: executes directly with (input, ctx, { abortSignal }) and never consults the gate", async () => {
    const ctx = makeToolContext();
    const execute = vi.fn(async () => "done");
    const tools = buildToolSet({ echo: makeDef("auto", execute) }, ctx);
    const abortSignal = new AbortController().signal;
    const input = { value: 1 };

    const result = await callTool(tools, "echo", input, abortSignal);

    expect(result).toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(input, ctx, { abortSignal });
    expect(ctx.approvalGate.request).not.toHaveBeenCalled();
  });

  it("always tool + gate approves: gate receives the full request, then execute runs", async () => {
    const ctx = makeToolContext();
    const request = vi.fn(async () => true);
    const gatedCtx: ToolContext = { ...ctx, approvalGate: { request } };
    const execute = vi.fn(async () => "executed");
    const tools = buildToolSet({ danger: makeDef("always", execute) }, gatedCtx);
    const abortSignal = new AbortController().signal;
    const input = { value: 2 };

    const result = await callTool(tools, "danger", input, abortSignal);

    expect(result).toBe("executed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "danger",
      input,
      consentLevel: "always",
      abortSignal,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(input, gatedCtx, { abortSignal });
  });

  it("always tool + gate denies: execute is skipped and the wrapper rejects with ToolDeniedError", async () => {
    const ctx = makeToolContext();
    const request = vi.fn(async () => false);
    const gatedCtx: ToolContext = { ...ctx, approvalGate: { request } };
    const execute = vi.fn(async () => "never happens");
    const tools = buildToolSet({ danger: makeDef("always", execute) }, gatedCtx);
    const promise = callTool(tools, "danger", { value: 3 }, new AbortController().signal);

    await expect(promise).rejects.toBeInstanceOf(ToolDeniedError);
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ToolDeniedError);
    if (error instanceof ToolDeniedError) {
      expect(error.name).toBe("ToolDeniedError");
      expect(error.toolName).toBe("danger");
      expect(error.message).toBe(
        'The user denied the "danger" tool call. Do not retry the same action without changing your approach.',
      );
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("configurable tool + autoExecuteDangerousTools=false: the gate is consulted", async () => {
    const ctx = makeToolContext({ autoExecuteDangerousTools: false });
    const request = vi.fn(async () => true);
    const gatedCtx: ToolContext = { ...ctx, approvalGate: { request } };
    const execute = vi.fn(async () => "created");
    const tools = buildToolSet({ create: makeDef("configurable", execute) }, gatedCtx);

    const result = await callTool(tools, "create", { value: 4 }, new AbortController().signal);

    expect(result).toBe("created");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "create", consentLevel: "configurable" }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("configurable tool + autoExecuteDangerousTools=true: bypasses the gate entirely", async () => {
    const ctx = makeToolContext({ autoExecuteDangerousTools: true });
    const request = vi.fn(async () => true);
    const gatedCtx: ToolContext = { ...ctx, approvalGate: { request } };
    const execute = vi.fn(async () => "created");
    const tools = buildToolSet({ create: makeDef("configurable", execute) }, gatedCtx);

    const result = await callTool(tools, "create", { value: 5 }, new AbortController().signal);

    expect(result).toBe("created");
    expect(request).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
