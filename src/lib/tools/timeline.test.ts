/**
 * Tests for the timeline tool `timeline_lookup` (ADR-0033): the whole input
 * object is forwarded as the TimelineQuery, plus input-schema bounds.
 * `@/api/timeline` is mocked — never real Tauri IPC.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { queryTimeline } from "@/api/timeline";
import { timelineTools } from "@/lib/tools/timeline";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, TIMELINE_LIMIT_MAX, worldIdSchema, type TimelineResponse } from "@/types";

vi.mock("@/api/timeline", () => ({
  queryTimeline: vi.fn(),
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
    skills: [],
    activatedSkills: new Set(),
    visionConfig: null,
    attachmentLookup: { findByFilename: vi.fn(() => null) },
  };
}

function timelineTool(): ToolDef {
  const def = timelineTools().timeline_lookup;
  if (!def) {
    throw new Error("timeline_lookup not found");
  }
  return def;
}

/** See shell.test.ts — `FlexibleSchema` has no `.parse`, zod is the runtime reality. */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

type TimelineParsed = {
  characterId?: string;
  locationId?: string;
  from?: string;
  to?: string;
  novelId?: string;
  includeScenes?: boolean;
  limit?: number;
};

const queryTimelineMock = vi.mocked(queryTimeline);
const timelineSchema = () => toZod<TimelineParsed>(timelineTools().timeline_lookup.inputSchema);

// ─── Tests ───────────────────────────────────────────────────────────────

describe("timeline_lookup", () => {
  it("forwards the WHOLE input object (same reference) as the TimelineQuery", async () => {
    const response: TimelineResponse = { entries: [], total: 0, truncated: false };
    queryTimelineMock.mockResolvedValue(response);
    const ctx = makeToolContext();
    const input = {
      characterId: "c-1",
      from: "0001-01-01T00:00:00Z",
      includeScenes: false,
      limit: 10,
    };

    const got = await timelineTool().execute(input, ctx, { abortSignal: new AbortController().signal });

    expect(got).toBe(response);
    expect(queryTimelineMock).toHaveBeenCalledTimes(1);
    expect(queryTimelineMock).toHaveBeenCalledWith(ctx.spaceId, ctx.worldId, input);
    // Identity check — the tool must not clone/reshape the input.
    expect(queryTimelineMock.mock.calls[0]?.[2]).toBe(input);
  });

  describe("inputSchema", () => {
    it("caps limit at TIMELINE_LIMIT_MAX (500), mirrored from the Rust command", () => {
      expect(TIMELINE_LIMIT_MAX).toBe(500);
      expect(timelineSchema().safeParse({ limit: TIMELINE_LIMIT_MAX }).success).toBe(true);
      expect(timelineSchema().safeParse({ limit: TIMELINE_LIMIT_MAX + 1 }).success).toBe(false);
    });

    it.each([
      { label: "limit 0", input: { limit: 0 }, ok: false },
      { label: "limit 1 (min)", input: { limit: 1 }, ok: true },
      { label: "limit non-integer", input: { limit: 10.5 }, ok: false },
      { label: "includeScenes false", input: { includeScenes: false }, ok: true },
      { label: "includeScenes true", input: { includeScenes: true }, ok: true },
      { label: "includeScenes non-boolean", input: { includeScenes: "yes" }, ok: false },
      {
        label: "full valid query",
        input: {
          characterId: "c-1",
          locationId: "l-1",
          from: "0001-01-01T00:00:00Z",
          to: "9999-12-31T00:00:00Z",
          novelId: "n-1",
          includeScenes: true,
          limit: 50,
        },
        ok: true,
      },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(timelineSchema().safeParse(input).success).toBe(ok);
    });
  });
});
