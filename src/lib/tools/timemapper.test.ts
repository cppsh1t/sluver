/**
 * Tests for the TimeMapper tool `format_time` (ADR-0026): ok:true resolves to
 * the display string; ok:false rejects by re-throwing the TimeMapperError.
 * The TimeMapper façade is mocked (formatTime only — the real TimeMapperError
 * class is kept via importOriginal so instanceof assertions are meaningful).
 */
import { describe, expect, it, vi } from "vitest";

import { formatTime, TimeMapperError } from "@/lib/timemapper/format";
import { timemapperTools } from "@/lib/tools/timemapper";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

vi.mock("@/lib/timemapper/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/timemapper/format")>();
  return { ...actual, formatTime: vi.fn() };
});

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

function formatTimeTool(): ToolDef {
  const def = timemapperTools().format_time;
  if (!def) {
    throw new Error("format_time not found");
  }
  return def;
}

const formatTimeMock = vi.mocked(formatTime);
const ISO = "2024-03-15T10:30:00Z";

// ─── Tests ───────────────────────────────────────────────────────────────

describe("format_time", () => {
  it("resolves with the mapper's display string when ok:true", async () => {
    formatTimeMock.mockResolvedValue({ ok: true, display: "格式化结果" });

    const got = await formatTimeTool().execute({ iso: ISO }, makeToolContext(), {
      abortSignal: new AbortController().signal,
    });

    expect(got).toBe("格式化结果");
    expect(formatTimeMock).toHaveBeenCalledTimes(1);
    expect(formatTimeMock).toHaveBeenCalledWith(ISO);
  });

  it("rejects with the exact TimeMapperError instance when ok:false", async () => {
    const error = new TimeMapperError("syntax", "unexpected token }");
    formatTimeMock.mockResolvedValue({ ok: false, display: ISO, error });

    const promise = formatTimeTool().execute({ iso: ISO }, makeToolContext(), {
      abortSignal: new AbortController().signal,
    });

    await expect(promise).rejects.toBeInstanceOf(TimeMapperError);
    const caught = await promise.catch((thrown: unknown) => thrown);
    expect(caught).toBe(error); // re-thrown verbatim, not wrapped
    if (caught instanceof TimeMapperError) {
      expect(caught.name).toBe("TimeMapperError");
      expect(caught.kind).toBe("syntax");
      expect(caught.message).toBe("Time mapper failed (syntax): unexpected token }");
    }
  });
});
