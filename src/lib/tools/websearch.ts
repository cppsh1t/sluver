/**
 * Web search tool — public-web lookups (provider-dispatched per the
 * user's web-search settings, ADR-0049; keyless Bing is the default).
 *
 * Wraps the server-side `search_web` command (see `@/api/search`). Lets the
 * agent fetch information not present in the worldbuilding database:
 * real-world facts (history, geography, science, public figures, current
 * events) AND material from existing media or franchises — characters,
 * settings, and lore from anime, games, films, novels (fan wikis and
 * encyclopedia pages are ideal sources).
 *
 * The user's current i18n locale (`i18n.language`) is passed through as the
 * `Accept-Language` header so results match the user's language.
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
        "Search the public web — a fallback for information the worldbuilding database cannot provide, not a first resort: " +
        "check the worldbook first, and search only after it cannot answer and the subject is external to it. " +
        "External means real-world facts (history, geography, science, public figures, current events, names of real places or people) " +
        "and material from existing media or franchises — characters, settings, and lore from anime, games, films, novels " +
        "(fan wikis and encyclopedia pages are ideal sources). " +
        "Returns a list of results each with a title, URL, and short snippet. " +
        "Query discipline: keep queries to 3-8 keywords rather than full sentences. " +
        "For time-sensitive topics, append the year to the query (e.g. \"oscar winners 2026\").",
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
