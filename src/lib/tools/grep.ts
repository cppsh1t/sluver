/**
 * Grep tool — `grep` (ADR-0035).
 *
 * Match-centric full-corpus retrieval: sweeps ALL author-written text in
 * the current World — including the four CharacterPhase fields — for a
 * substring, returning field-grouped occurrence evidence (match counts +
 * before/match/after snippets). Complements the 8 entity-centric
 * `search_*` tools; the description below states the division of labor
 * explicitly (load-bearing per ADR-0035 — without it, models double-call
 * both tools for the same question).
 *
 * Consent level: `auto` (pure read — same classification as the
 * `search_*` tools, ADR-0025). No approval gate.
 *
 * NOTE (ADR-0016 NEVER-log): the query may be verbatim prose and the
 * returned snippets are content fragments — neither is ever logged.
 */

import { z } from "zod";

import { grep } from "@/api/grep";
import { grepEntityTypeSchema, type GrepEntityType } from "@/types";
import type { ToolDef } from "./types";

/**
 * Widened input shape re-asserted at the execute boundary — the SDK hands
 * `execute` a parsed-but-`unknown` input (same cast pattern as the
 * worldbook CRUD tools, see `worldbook/character.ts`).
 */
interface GrepToolInput {
  query: string;
  entityTypes?: GrepEntityType[];
}

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Substring to search for (ASCII case-insensitive)."),
  entityTypes: z
    .array(grepEntityTypeSchema)
    .optional()
    .describe(
      "Optional scope filter — entity types to search. Omit to sweep the full corpus.",
    ),
});

/** Grep tool, keyed by `snake_case` name. */
export function grepTools(): Record<string, ToolDef> {
  return {
    grep: {
      description:
        "Search for a substring across ALL author-written text in the current world — characters, phases (appearance/description/conversation_style), locations, items, lore, events, novels, chapters, and scene prose — " +
        "returning occurrence evidence: match counts plus before/match/after context snippets grouped by (entity, field), sorted by match count descending and capped at 50 groups (a truncated flag signals the cap). " +
        'Use it to answer "where does this text occur?" — motif tracking, consistency checks across entity descriptions. ' +
        'For entity discovery ("which entities match a name/description?") use the per-entity search_* tools instead. ' +
        "Optionally narrow the scope with entityTypes (e.g. [\"scene\"] to search prose only).",
      inputSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query, entityTypes } = input as GrepToolInput;
        return grep(ctx.spaceId, ctx.worldId, query, entityTypes);
      },
    },
  };
}
