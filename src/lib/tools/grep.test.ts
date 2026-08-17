/**
 * Tests for the grep tool (ADR-0035): execute passthrough into the IPC
 * wrapper and input-schema validation. `@/api/grep` is mocked — never real
 * Tauri IPC.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { grep } from "@/api/grep";
import { grepTools } from "@/lib/tools/grep";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { grepEntityTypeSchema, spaceIdSchema, worldIdSchema, type GrepResult } from "@/types";

vi.mock("@/api/grep", () => ({
  grep: vi.fn(),
}));

// ─── Helpers (inline) ────────────────────────────────────────────────────

function makeToolContext(): ToolContext {
  return {
    spaceId: spaceIdSchema.parse("space-1"),
    worldId: worldIdSchema.parse("world-1"),
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(() => null), set: vi.fn(async () => {}) },
    threadLookup: { findToolPair: vi.fn(() => undefined) },
  };
}

function grepTool(): ToolDef {
  const def = grepTools().grep;
  if (!def) {
    throw new Error("grep tool not found");
  }
  return def;
}

/** See shell.test.ts — `FlexibleSchema` has no `.parse`, zod is the runtime reality. */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

type GrepParsed = { query: string; entityTypes?: string[]; offset?: number };

const grepMock = vi.mocked(grep);
const grepSchema = () => toZod<GrepParsed>(grepTools().grep.inputSchema);

// ─── Tests ───────────────────────────────────────────────────────────────

describe("grep", () => {
  it("passes (spaceId, worldId, query, entityTypes, offset) through and returns the result verbatim", async () => {
    const result: GrepResult = { query: "龙", groups: [], groupCount: 0, truncated: false };
    grepMock.mockResolvedValue(result);
    const ctx = makeToolContext();

    const got = await grepTool().execute(
      { query: "龙", entityTypes: ["scene", "event"], offset: 50 },
      ctx,
      { abortSignal: new AbortController().signal },
    );

    expect(got).toBe(result);
    expect(grepMock).toHaveBeenCalledTimes(1);
    expect(grepMock).toHaveBeenCalledWith(ctx.spaceId, ctx.worldId, "龙", ["scene", "event"], 50);
  });

  it("forwards entityTypes/offset as undefined when omitted", async () => {
    grepMock.mockResolvedValue({ query: "x", groups: [], groupCount: 0, truncated: false });
    const ctx = makeToolContext();

    await grepTool().execute({ query: "x" }, ctx, { abortSignal: new AbortController().signal });

    expect(grepMock).toHaveBeenCalledWith(ctx.spaceId, ctx.worldId, "x", undefined, undefined);
  });

  describe("inputSchema", () => {
    it("sweeps all 9 entity types (the 8 search_* types plus phase)", () => {
      expect(grepEntityTypeSchema.options).toEqual([
        "character",
        "phase",
        "location",
        "item",
        "lore",
        "event",
        "novel",
        "chapter",
        "scene",
      ]);
      const parsed = grepSchema().safeParse({ query: "x", entityTypes: ["phase"] });
      expect(parsed.success).toBe(true);
    });

    it.each([
      { label: "empty query", input: { query: "" }, ok: false },
      { label: "unknown entity type", input: { query: "x", entityTypes: ["dragon"] }, ok: false },
      { label: "negative offset", input: { query: "x", offset: -1 }, ok: false },
      { label: "non-integer offset", input: { query: "x", offset: 1.5 }, ok: false },
      { label: "offset 0 is valid", input: { query: "x", offset: 0 }, ok: true },
      { label: "full valid input", input: { query: "x", entityTypes: ["lore"], offset: 100 }, ok: true },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(grepSchema().safeParse(input).success).toBe(ok);
    });
  });
});
