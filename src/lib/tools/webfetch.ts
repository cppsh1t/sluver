/**
 * Web fetch tool — read a specific URL's content.
 *
 * Wraps the server-side `fetch_url` command (see `@/api/search`). The agent
 * uses this to dig deeper into a specific page found via `web_search`, or to
 * read any URL the user mentions. Server-side extraction via Readability
 * strips navigation, ads, and footer chrome; returns the main article text
 * plus title/author/excerpt/date metadata.
 *
 * The user's current i18n locale (`i18n.language`) is passed as
 * `Accept-Language` for sites that do language negotiation (e.g. Wikipedia).
 *
 * Consent level: `auto` (read-only, no side effects — consistent with
 * `web_search`).
 */

import i18n from "@/i18n";
import { z } from "zod";

import { fetchUrl } from "@/api/search";
import type { ToolDef } from "./types";

const fetchInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe('Absolute URL to fetch, e.g. "https://en.wikipedia.org/wiki/Tang_dynasty"'),
  maxLength: z
    .number()
    .int()
    .min(500)
    .max(50_000)
    .optional()
    .describe("Maximum content length in chars (default 10_000)"),
});

/** All web-fetch tools, keyed by `snake_case` name. */
export function webFetchTools(): Record<string, ToolDef> {
  return {
    web_fetch: {
      description:
        "Fetch a specific URL and extract its main article content as plain text. " +
        "Use this after `web_search` to read a full page, OR when the user gives you a URL directly. " +
        "Returns the page's title, content (truncated to maxLength chars), and optional metadata " +
        "(author, excerpt, published date). Server-side Readability extraction strips nav/ads/footer.",
      inputSchema: fetchInputSchema,
      consentLevel: "auto",
      execute: async (input) => {
        const { url, maxLength } = input as { url: string; maxLength?: number };
        const page = await fetchUrl(url, i18n.language ?? "en", maxLength);
        return { page };
      },
    },
  };
}
