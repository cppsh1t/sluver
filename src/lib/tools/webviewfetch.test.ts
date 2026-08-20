/**
 * Tests for the WebView fetch tool `web_fetch_via_browser`: i18n locale
 * pass-through, arg mapping, page unwrapping, and schema bounds. `@/i18n` is
 * stubbed (avoids i18next init side effects) and `@/api/search` is mocked —
 * no network, no IPC, no real WebView2.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { fetchUrlViaWebview, type FetchedPage } from "@/api/search";
import { webViewFetchTools } from "@/lib/tools/webviewfetch";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

vi.mock("@/i18n", () => ({
  default: { language: "zh-CN" },
  // @/types/setting.ts imports these named exports at runtime (z.enum) — keep them defined.
  AUTO_LOCALE: "auto",
  SUPPORTED_LOCALES: ["zh-CN", "en"],
}));

vi.mock("@/api/search", () => ({
  fetchUrlViaWebview: vi.fn(),
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

function webViewFetchTool(): ToolDef {
  const def = webViewFetchTools().web_fetch_via_browser;
  if (!def) {
    throw new Error("web_fetch_via_browser not found");
  }
  return def;
}

/** See shell.test.ts — `FlexibleSchema` has no `.parse`, zod is the runtime reality. */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

type FetchParsed = { url: string; maxLength?: number };

const fetchViaWebviewMock = vi.mocked(fetchUrlViaWebview);
const fetchSchema = () => toZod<FetchParsed>(webViewFetchTools().web_fetch_via_browser.inputSchema);

const PAGE: FetchedPage = {
  url: "https://example.com/protected",
  title: "Behind Cloudflare",
  content: "rendered by js",
  contentFormat: "text",
  author: null,
  excerpt: null,
  publishedAt: null,
  mainImage: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe("web_fetch_via_browser", () => {
  it("passes (url, i18n locale, maxLength) through to the webview command and unwraps the page", async () => {
    fetchViaWebviewMock.mockResolvedValue(PAGE);

    const got = await webViewFetchTool().execute(
      { url: "https://example.com/protected", maxLength: 8_000 },
      makeToolContext(),
      { abortSignal: new AbortController().signal },
    );

    expect(got).toEqual({ page: PAGE });
    expect(fetchViaWebviewMock).toHaveBeenCalledTimes(1);
    expect(fetchViaWebviewMock).toHaveBeenCalledWith("https://example.com/protected", "zh-CN", 8_000);
  });

  it("forwards maxLength as undefined when omitted (locale still passed)", async () => {
    fetchViaWebviewMock.mockResolvedValue(PAGE);

    await webViewFetchTool().execute(
      { url: "https://example.com/protected" },
      makeToolContext(),
      { abortSignal: new AbortController().signal },
    );

    expect(fetchViaWebviewMock).toHaveBeenCalledWith("https://example.com/protected", "zh-CN", undefined);
  });

  describe("inputSchema", () => {
    it.each([
      { label: "url must be absolute", input: { url: "https://example.com/a" }, ok: true },
      { label: "url not a url", input: { url: "not-a-url" }, ok: false },
      { label: "maxLength 499", input: { url: "https://example.com/a", maxLength: 499 }, ok: false },
      { label: "maxLength 500 (min)", input: { url: "https://example.com/a", maxLength: 500 }, ok: true },
      { label: "maxLength 50_000 (max)", input: { url: "https://example.com/a", maxLength: 50_000 }, ok: true },
      { label: "maxLength 50_001", input: { url: "https://example.com/a", maxLength: 50_001 }, ok: false },
      { label: "maxLength non-integer", input: { url: "https://example.com/a", maxLength: 1234.5 }, ok: false },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(fetchSchema().safeParse(input).success).toBe(ok);
    });
  });
});
