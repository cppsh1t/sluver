/**
 * Web fetch tool — read a specific URL's content.
 *
 * Wraps the server-side `fetch_url` command (see `@/api/search`). The agent
 * uses this to dig deeper into a specific page found via `web_search`, or to
 * read any URL the user mentions. Server-side extraction via Readability
 * strips navigation, ads, and footer chrome; returns the main article as
 * Markdown (with inline images preserved at their original document position
 * as `![alt](url)`) plus title/author/excerpt/date metadata and a `mainImage`
 * field (the page's designated hero/cover image from og:image / twitter:image
 * / JSON-LD).
 *
 * Image-handling notes (relevant when the agent is gathering entity portraits):
 *   - Readability's standardization pipeline transparently resolves lazy-load
 *     attributes (`data-src` → `src`), picks the largest source from `srcset`,
 *     and drops tracker/UI pixels (< 100×100). Relative URLs are absolutized
 *     against the final page URL.
 *   - `page.mainImage` is the strongest single signal for biographical / wiki
 *     pages (it's literally the page's chosen cover image). Inline
 *     `![](url)` entries in the markdown body are body illustrations and are
 *     the next-best candidates.
 *   - To download and store an image picked from this result, call the
 *     domain-specific `set_<entity>_image_from_url` tool with the URL.
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
        "Fetch a specific URL and extract its main article content as Markdown. " +
        "Use this after `web_search` to read a full page, OR when the user gives you a URL directly. " +
        "Returns the page's title, content (Markdown, truncated to maxLength chars — inline images " +
        "are preserved as `![alt](url)` at their original document position), `mainImage` (the page's " +
        "designated cover image from og:image / JSON-LD), and optional metadata (author, excerpt, " +
        "published date). Server-side Readability extraction strips nav/ads/footer. To download and " +
        "store an image from the result, pick the URL from `mainImage` or an inline `![](url)` and " +
        "pass it to the appropriate `set_<entity>_image_from_url` tool.",
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
