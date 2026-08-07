/**
 * WebView fetch tool — fetch a URL via a real browser engine (WebView2).
 *
 * Wraps the server-side `fetch_url_via_webview` command (see `@/api/search`).
 * The agent uses this as a fallback when `web_fetch` fails with 403 Forbidden
 * or when the page requires JavaScript to render content. The hidden WebView2
 * window loads the page in a real browser engine, letting Cloudflare/anti-bot
 * JS challenges resolve naturally, then extracts `document.documentElement
 * .outerHTML` via native `ExecuteScript` and runs the same Readability
 * extraction as `web_fetch`.
 *
 * **Slower** than `web_fetch` (~3-5s per fetch vs <1s). The tool description
 * guides the agent to try `web_fetch` first and fall back here on failure.
 *
 * Following Cherry Studio's `@cherry/browser` model, this is an explicit peer
 * tool — the agent decides when the expensive browser path is warranted.
 *
 * Consent level: `auto` (read-only, no side effects — consistent with
 * `web_fetch`).
 */

import i18n from "@/i18n";
import { z } from "zod";

import { fetchUrlViaWebview } from "@/api/search";
import type { ToolDef } from "./types";

const fetchInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe('Absolute URL to fetch, e.g. "https://example.com/article"'),
  maxLength: z
    .number()
    .int()
    .min(500)
    .max(50_000)
    .optional()
    .describe("Maximum content length in chars (default 10_000)"),
});

/** All WebView-fetch tools, keyed by `snake_case` name. */
export function webViewFetchTools(): Record<string, ToolDef> {
  return {
    web_fetch_via_browser: {
      description:
        "Fetch a URL using a REAL browser engine (WebView2), bypassing anti-bot protections. " +
        "Use this ONLY when `web_fetch` returned an error (e.g. 403 Forbidden, access denied) " +
        "or when the page requires JavaScript to render content. " +
        "Slower than `web_fetch` (3-5 seconds per fetch) but handles Cloudflare/JS challenges. " +
        "Returns the same format as `web_fetch` (title, content, metadata).",
      inputSchema: fetchInputSchema,
      consentLevel: "auto",
      execute: async (input) => {
        const { url, maxLength } = input as { url: string; maxLength?: number };
        const page = await fetchUrlViaWebview(url, i18n.language ?? "en", maxLength);
        return { page };
      },
    },
  };
}
