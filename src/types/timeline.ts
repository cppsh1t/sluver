import { z } from "zod";

/**
 * Timeline — derived, read-only chronological projection of a World's Events
 * and Scenes (ADR-0033).
 *
 * The Timeline is never persisted and never authored: it is computed at query
 * time by the `query_timeline` Rust aggregation command, which cross-entity-
 * joins Events + Scenes with their resolved location names, participant names,
 * and cross-reference annotations into a single flat list.
 *
 * Unlike `list_events` (which returns Event rows), the Timeline returns
 * time-ordered, cross-entity-joined entries. Every Event and Scene appears at
 * its own `startAt` — events referenced by scenes are NOT deduplicated, so the
 * chronology is chronologically truthful (the tool surface intentionally
 * diverges from the UI surface's visual absorption rule).
 */

// ─── Query ────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on `limit` — mirrored from `MAX_LIMIT` in
 * `src-tauri/src/commands/timeline.rs`; keep both in sync. The Timeline UI
 * steps toward this via its "load more" control.
 */
export const TIMELINE_LIMIT_MAX = 500;

/**
 * Filter parameters for a Timeline query. All fields optional; an empty query
 * returns the whole chronology (up to `limit`, default 50).
 */
export const timelineQuerySchema = z.object({
  /** Restrict to entries involving this character (by id). */
  characterId: z.string().optional(),
  /** Restrict to entries taking place at this location (by id). */
  locationId: z.string().optional(),
  /** Lower bound (inclusive) on `startAt`, as an ISO 8601 timestamp. */
  from: z.string().optional(),
  /** Upper bound (exclusive) on `startAt`, as an ISO 8601 timestamp. */
  to: z.string().optional(),
  /** Restrict scene entries to this novel (by id). Events are unaffected. */
  novelId: z.string().optional(),
  /** Restrict scene entries to those referencing this item (by id). Does not affect events — events have no items. */
  itemId: z.string().optional(),
  /** Whether to include Scene entries alongside Events (default `true`). */
  includeScenes: z.boolean().optional(),
  /** Maximum entries to return (default 50, max `TIMELINE_LIMIT_MAX`). */
  limit: z.number().int().min(1).max(TIMELINE_LIMIT_MAX).optional(),
});

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

// ─── Entry ────────────────────────────────────────────────────────────────

/**
 * A single node in the chronology — either an Event or a Scene, flattened into
 * a uniform shape with resolved (denormalized) names.
 *
 * The `id` is polymorphic: it is an Event id when `kind === "event"` and a
 * Scene id when `kind === "scene"`. It is therefore a plain `string`, not a
 * branded entity id.
 *
 * Cross-reference fields are optional and kind-specific:
 * - Events carry `narratedBySceneNames` (scenes that reference this event).
 * - Scenes carry `narratedEventNames` (events this scene references),
 *   `novelTitle` (the containing novel's title), and `novelId` / `chapterId`
 *   (the ids needed to navigate from a Scene node to its Novel chapter
 *   workspace — ADR-0034 additive extension).
 */
export const timelineEntrySchema = z.object({
  /** Discriminator: `"event"` or `"scene"`. */
  kind: z.enum(["event", "scene"]),
  /** Event or Scene UUID (polymorphic — not a branded entity id). */
  id: z.string(),
  /** Display name (Event name or Scene title). */
  name: z.string(),
  /** Story timeline — when the entry starts (ISO 8601). `null` if undated. */
  startAt: z.iso.datetime().nullable(),
  /** Story timeline — when the entry ends (ISO 8601). `null` if undated. */
  endAt: z.iso.datetime().nullable(),
  /** Resolved location name. `null` if no location is set. */
  locationName: z.string().nullable(),
  /** Resolved character names participating in this entry. */
  participants: z.array(z.string()),
  /** First ~200 characters of the Event description or Scene summary. */
  descriptionExcerpt: z.string().nullable(),
  /**
   * Names of Scenes that narrate / reference this Event. An array (possibly
   * empty) for events; `null` for scenes. Always present in the payload —
   * Rust serde emits the key with `null` for the non-applicable kind.
   */
  narratedBySceneNames: z.array(z.string()).nullable(),
  /** Names of Events this Scene references. An array for scenes; `null` for events. */
  narratedEventNames: z.array(z.string()).nullable(),
  /** Title of the Novel containing this Scene. A string for scenes; `null` for events. */
  novelTitle: z.string().nullable(),
  /** Id of the Novel containing this Scene. A string for scenes; `null` for events (ADR-0034). */
  novelId: z.string().nullable(),
  /** Id of the Chapter containing this Scene. A string for scenes; `null` for events (ADR-0034). */
  chapterId: z.string().nullable(),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// ─── Response ─────────────────────────────────────────────────────────────

/**
 * Result of a Timeline query. Entries are sorted ascending by `startAt`
 * (undated entries — `null` startAt — sort last). `total` reports the full
 * match count (ignoring `limit`); `truncated` is `true` when `entries.length`
 * was capped by `limit`.
 */
export const timelineResponseSchema = z.object({
  entries: z.array(timelineEntrySchema),
  /** Full match count (may exceed `entries.length` when truncated). */
  total: z.number().int(),
  /** Whether `limit` cut the result short. */
  truncated: z.boolean(),
});

export type TimelineResponse = z.infer<typeof timelineResponseSchema>;

// ─── Lane ─────────────────────────────────────────────────────────────────

/**
 * A Character plus their Timeline participation count — the number of
 * DISTINCT Events (via `event_character_refs`) plus Scenes (via
 * `scene_character_refs`) they appear in. A character in one event via two
 * phases counts as 1.
 *
 * Drives the Timeline UI's default lane selection: lanes where
 * `participationCount > 2` are auto-shown; the rest populate the character
 * multiselect. Characters with zero participation are excluded by the
 * backend query (they'd never be default-selected).
 *
 * Returned by `list_timeline_lanes`.
 */
export const timelineLaneSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  participationCount: z.number().int(),
});

export type TimelineLane = z.infer<typeof timelineLaneSchema>;
