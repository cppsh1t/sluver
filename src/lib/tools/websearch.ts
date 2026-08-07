/**
 * Web search tool — public-web lookups via Bing.
 *
 * Wraps the server-side `search_web` command (see `@/api/search`). Lets the
 * agent fetch real-world information not present in the worldbuilding
 * database: historical facts, geography, scientific concepts, public figures,
 * current events, real place / person names, etc.
 *
 * The user's current i18n locale (`i18n.language`) is passed through to Bing
 * as the `Accept-Language` header so results match the user's language.
 *
 * Consent level: `auto` (read-only, no side effects — explicitly approved by
 * the user as a default).
 */

import i18n from "@/i18n";
import { z } from "zod";

import { searchWeb } from "@/api/search";
import type { ToolDef } from "./types";

const searchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('The search query, e.g. "Tang dynasty capital city"'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum results to return (default 5)"),
});

/** All web-search tools, keyed by `snake_case` name. */
export function webSearchTools(): Record<string, ToolDef> {
  return {
    web_search: {
      description:
        "Search the public web via Bing. Use when you need real-world information not in the worldbuilding database: " +
        "historical facts, geography, scientific concepts, public figures, current events, names of real places or people, etc. " +
        "Returns a list of results each with a title, URL, and short snippet.",
      inputSchema: searchInputSchema,
      consentLevel: "auto",
      execute: async (input) => {
        const { query, maxResults } = input as {
          query: string;
          maxResults?: number;
        };
        const results = await searchWeb(query, i18n.language ?? "en", maxResults);
        return { results };
      },
    },
  };
}
