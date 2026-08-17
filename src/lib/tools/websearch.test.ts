/**
 * Tests for the web search tool `web_search`: i18n locale pass-through, arg
 * mapping, result unwrapping, and schema bounds. `@/i18n` is stubbed (avoids
 * i18next init side effects) and `@/api/search` is mocked — no network, no IPC.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { searchWeb } from "@/api/search";
import { webSearchTools } from "@/lib/tools/websearch";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

vi.mock("@/i18n", () => ({
  default: { language: "zh-CN" },
  // @/types/setting.ts imports these named exports at runtime (z.enum) — keep them defined.
  AUTO_LOCALE: "auto",
  SUPPORTED_LOCALES: ["zh-CN", "en"],
}));

vi.mock("@/api/search", () => ({
  searchWeb: vi.fn(),
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

function webSearchTool(): ToolDef {
  const def = webSearchTools().web_search;
  if (!def) {
    throw new Error("web_search not found");
  }
  return def;
}

/** See shell.test.ts — `FlexibleSchema` has no `.parse`, zod is the runtime reality. */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

type SearchParsed = { query: string; maxResults?: number };

const searchWebMock = vi.mocked(searchWeb);
const searchSchema = () => toZod<SearchParsed>(webSearchTools().web_search.inputSchema);

// ─── Tests ───────────────────────────────────────────────────────────────

describe("web_search", () => {
  it("passes (query, i18n locale, maxResults) through and unwraps the results", async () => {
    const results = [
      { title: "Tang dynasty", url: "https://example.com/tang", snippet: "an imperial dynasty" },
    ];
    searchWebMock.mockResolvedValue(results);

    const got = await webSearchTool().execute(
      { query: "Tang dynasty capital", maxResults: 7 },
      makeToolContext(),
      { abortSignal: new AbortController().signal },
    );

    expect(got).toEqual({ results });
    expect(searchWebMock).toHaveBeenCalledTimes(1);
    expect(searchWebMock).toHaveBeenCalledWith("Tang dynasty capital", "zh-CN", 7);
  });

  it("forwards maxResults as undefined when omitted (locale still passed)", async () => {
    searchWebMock.mockResolvedValue([]);

    await webSearchTool().execute({ query: "x" }, makeToolContext(), {
      abortSignal: new AbortController().signal,
    });

    expect(searchWebMock).toHaveBeenCalledWith("x", "zh-CN", undefined);
  });

  describe("inputSchema", () => {
    it.each([
      { label: "empty query", input: { query: "" }, ok: false },
      { label: "query 500 chars (max)", input: { query: "x".repeat(500) }, ok: true },
      { label: "query 501 chars", input: { query: "x".repeat(501) }, ok: false },
      { label: "maxResults 0", input: { query: "x", maxResults: 0 }, ok: false },
      { label: "maxResults 1 (min)", input: { query: "x", maxResults: 1 }, ok: true },
      { label: "maxResults 20 (max)", input: { query: "x", maxResults: 20 }, ok: true },
      { label: "maxResults 21", input: { query: "x", maxResults: 21 }, ok: false },
      { label: "maxResults non-integer", input: { query: "x", maxResults: 2.5 }, ok: false },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(searchSchema().safeParse(input).success).toBe(ok);
    });
  });
});
