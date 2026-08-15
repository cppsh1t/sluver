import { z } from "zod";

/**
 * Grep — match-centric full-corpus retrieval (ADR-0035).
 *
 * Complements the 8 per-entity `search_*` tools (entity-centric discovery):
 * `grep` answers "where does this text occur?" across ALL author-written
 * text in a World — including the four CharacterPhase fields, which the
 * existing `search_characters` does not cover. Results are occurrence
 * evidence (match counts + before/match/after snippets) grouped by
 * (entityType, entityId, fieldName), not entity summaries.
 *
 * Computed on demand by the `grep` Rust aggregation command (SQL `LIKE`
 * prefilter + in-memory Rust scan with identical ASCII case folding, so
 * the two passes have zero false negatives between them). Never persisted.
 */

// ─── Entity type ──────────────────────────────────────────────────────────

/**
 * The entity types `grep` can sweep: the 8 `search_*` entity types plus
 * `phase` — CharacterPhase is an independent table whose text fields
 * (`name`, `appearance`, `description`, `conversation_style`) are part of
 * the corpus but invisible to `search_characters`. Also the fixed
 * tie-break order for equally-ranked match groups (ADR-0035 §5).
 */
export const grepEntityTypeSchema = z.enum([
  "character",
  "phase",
  "location",
  "item",
  "lore",
  "event",
  "novel",
  "chapter",
  "scene",
]);

export type GrepEntityType = z.infer<typeof grepEntityTypeSchema>;

// ─── Snippet ──────────────────────────────────────────────────────────────

/**
 * One match occurrence rendered as three parts: the matched substring with
 * up to ~40 chars of context on each side. Character-based truncation
 * (UTF-8 boundary safe on the Rust side), no `...` / `【】` marker glyphs —
 * markers collide with characters that occur in prose and mislead the
 * model (ADR-0035 §4).
 */
export const grepSnippetSchema = z.object({
  /** Up to ~40 chars immediately before the match (`""` at text start). */
  before: z.string(),
  /** The matched substring, exactly as it occurs in the text. */
  match: z.string(),
  /** Up to ~40 chars immediately after the match (`""` at text end). */
  after: z.string(),
});

export type GrepSnippet = z.infer<typeof grepSnippetSchema>;

// ─── Match group ──────────────────────────────────────────────────────────

/**
 * All matches of the query within one `(entityType, entityId, fieldName)`
 * field, carrying redundant entity identity so the model can act without
 * a follow-up `get_*` call. `entityId` is always directly usable by the
 * `get_*` family — phase hits are `entityType: "phase"` with
 * `entityId = phaseId`, never an overloaded character encoding
 * (ADR-0035 §3).
 *
 * `characterId` / `characterName` are non-null only when
 * `entityType === "phase"`; they arrive as `null` (not `undefined`) from
 * serde.
 */
export const grepMatchGroupSchema = z.object({
  /** Which entity type the matched field belongs to. */
  entityType: grepEntityTypeSchema,
  /** UUID of the entity (the phase id when `entityType === "phase"`). Polymorphic — not a branded entity id. */
  entityId: z.string(),
  /** Display name of the entity (character name, phase name, scene title, …). */
  entityTitle: z.string(),
  /** Owning character id — non-null only when `entityType === "phase"`. */
  characterId: z.string().nullable(),
  /** Owning character name — non-null only when `entityType === "phase"`. */
  characterName: z.string().nullable(),
  /** Field name the matches were found in (e.g. `"description"`, `"content"`). */
  fieldName: z.string(),
  /** Total matches in this field — not capped, unlike `snippets`. */
  matchCount: z.number().int(),
  /** Up to 3 snippet samples; need more context → fetch the entity via `get_*`. */
  snippets: z.array(grepSnippetSchema).max(3),
});

export type GrepMatchGroup = z.infer<typeof grepMatchGroupSchema>;

// ─── Response ─────────────────────────────────────────────────────────────

/**
 * Result of a `grep` query — one PAGE of a deterministically ordered result
 * set. Groups are sorted by `matchCount` descending, ties broken by fixed
 * entity-type enum order then title ascending — deterministic, so the model
 * can diff two greps across turns AND paginate stably: 50 groups per page,
 * walk `offset` (0, 50, 100, …) while `truncated` is `true`.
 */
export const grepResultSchema = z.object({
  /** Echo of the query string. */
  query: z.string(),
  /** One page of match groups, `matchCount` desc, up to 50 entries. */
  groups: z.array(grepMatchGroupSchema),
  /**
   * FULL group count before pagination — may exceed `groups.length` when
   * further pages exist (pairs with `truncated` to tell the model how much
   * was cut).
   */
  groupCount: z.number().int(),
  /**
   * `true` when more groups exist BEYOND this page
   * (`offset + groups.length < groupCount`) — fetch the next page by
   * passing an increased `offset`.
   */
  truncated: z.boolean(),
});

export type GrepResult = z.infer<typeof grepResultSchema>;
