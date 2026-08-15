/**
 * Timeline tool — `timeline_lookup`.
 *
 * Returns a flat, time-ordered chronology of the World's Events and Scenes
 * ("the story so far"), computed on demand by the `query_timeline` Rust
 * aggregation command (ADR-0033). Unlike `list_events`, this cross-entity-joins
 * Events + Scenes into a single list with resolved location names, participant
 * names, description excerpts, and cross-reference annotations.
 *
 * Consent level: `auto` (pure read — matches list_events / search_events /
 * context_read). No approval gate.
 */

import { z } from "zod";

import { queryTimeline } from "@/api/timeline";
import { TIMELINE_LIMIT_MAX, type TimelineQuery } from "@/types";
import type { ToolDef } from "./types";

const inputSchema = z.object({
  characterId: z
    .string()
    .optional()
    .describe("Restrict to entries involving this character (UUID)."),
  locationId: z
    .string()
    .optional()
    .describe("Restrict to entries taking place at this location (UUID)."),
  from: z
    .string()
    .optional()
    .describe(
      "Lower bound (inclusive) on startAt as an ISO 8601 timestamp " +
        '(e.g. "0001-01-01T00:00:00Z"). Entries with startAt before this are excluded.',
    ),
  to: z
    .string()
    .optional()
    .describe(
      "Upper bound (exclusive) on startAt as an ISO 8601 timestamp. " +
        'Entries with startAt at or after this are excluded.',
    ),
  novelId: z
    .string()
    .optional()
    .describe(
      "Restrict scene entries to this novel (UUID). Event entries are unaffected.",
    ),
  includeScenes: z
    .boolean()
    .optional()
    .describe(
      "Whether to include Scene entries alongside Events (default true).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(TIMELINE_LIMIT_MAX)
    .optional()
    .describe(
      `Maximum entries to return (default 50, max ${TIMELINE_LIMIT_MAX}).`,
    ),
});

/** Timeline tools, keyed by `snake_case` name. */
export function timelineTools(): Record<string, ToolDef> {
  return {
    timeline_lookup: {
      description:
        "Look up the Timeline — a time-ordered chronology of the world's events and scenes (\"the story so far\"). " +
        "Entries are sorted ascending by startAt (undated entries — those with null startAt — sort last). " +
        "Each entry carries its id, name, startAt, endAt, resolved location name, participant (character) names, a description excerpt, and cross-references: " +
        "events list which scenes narrate them (narratedBySceneNames); scenes list which events they reference (narratedEventNames) and their novel's title. " +
        "Filterable by character, location, time window (from/to), novel, and limit. " +
        "Unlike list_events, this returns time-ordered, cross-entity-joined entries; call get_event/get_scene for full detail. " +
        "NOTE: every event and scene appears at its own startAt (events referenced by scenes are NOT deduplicated) so the chronology is chronologically truthful. " +
        `Results are capped at limit (default 50, max ${TIMELINE_LIMIT_MAX}); if truncated, total reports the full match count — narrow your filters or request a later window.`,
      inputSchema,
      consentLevel: "auto",
      execute: async (input, ctx) =>
        queryTimeline(ctx.spaceId, ctx.worldId, input as TimelineQuery),
    },
  };
}
