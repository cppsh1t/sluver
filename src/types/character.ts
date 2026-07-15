import { z } from "zod";
import { worldIdSchema } from "./world";
import { eventIdSchema } from "./ids";

/**
 * 角色（Character）— 世界中的人物。
 *
 * A character is NOT a single fixed state — it contains multiple **phases**,
 * each representing a distinct period in the character's life. Scenes reference
 * a character at a specific phase, not the character as a whole.
 */

// ─── Branded IDs ──────────────────────────────────────────────────────────

export const characterIdSchema = z.string().brand<"CharacterId">();
export type CharacterId = z.infer<typeof characterIdSchema>;

export const phaseIdSchema = z.string().brand<"PhaseId">();
export type PhaseId = z.infer<typeof phaseIdSchema>;

// ─── Character Phase ──────────────────────────────────────────────────────

/**
 * A single phase / period in a character's life.
 *
 * Keeps the essential identity anchors (`name`, `appearance`, temporal
 * `triggerEventId`) and collapses all narrative-state detail (identity,
 * personality, relationships, abilities, etc.) into a single free-form
 * `changes` field.
 *
 * Phase ordering within a character is determined by array position in
 * `Character.phases` (position 0 = earliest period). No separate `order` field.
 */
export const characterPhaseSchema = z.object({
  id: phaseIdSchema,
  characterId: characterIdSchema,
  /** 名称 — short label for this life period. */
  name: z.string(),
  /** 外观 — physical appearance description in this period. */
  appearance: z.string(),
  /** 变化 — free-form description of this period's state and changes
   *  (identity, personality, relationships, abilities, etc.). */
  changes: z.string(),
  /** ID of the Event that triggered the transition INTO this phase. `null` for the initial phase. */
  triggerEventId: eventIdSchema.nullable(),
  /** Resolved name of the trigger event (LEFT JOIN from events table). `null` when `triggerEventId` is null. */
  triggerEventName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type CharacterPhase = z.infer<typeof characterPhaseSchema>;

// ─── Character ────────────────────────────────────────────────────────────

export const characterSchema = z.object({
  id: characterIdSchema,
  worldId: worldIdSchema,
  name: z.string(),
  /** Alternative names, nicknames, or aliases. */
  aliases: z.array(z.string()),
  /** Base-level info that doesn't change across phases. */
  description: z.string(),
  /** Ordered list of phases (position 0 = earliest period). May be empty — a zero-phase Character is a valid stub. */
  phases: z.array(characterPhaseSchema),
  /** Free-form notes (markdown). */
  notes: z.string(),
  /** User-defined tags for categorization / filtering. */
  tags: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Character = z.infer<typeof characterSchema>;

// ─── Character Reference ──────────────────────────────────────────────────

/**
 * A reference to a character at a specific phase.
 *
 * Used by Scene, Event, and other entities to point at a character in a
 * particular narrative state. Both IDs are foreign keys into the Character /
 * CharacterPhase tables.
 *
 * **Semantics**:
 * - Treated as a composite key — collections of `CharacterRef` (e.g.
 *   `Scene.characterRefs`, `Event.characterRefs`) MUST NOT contain duplicates
 *   (same `characterId` + `phaseId` pair). Enforce at the application/store layer.
 * - **Cascade on delete**: if a `CharacterPhase` is deleted, all refs pointing
 *   at its `phaseId` must be removed (or rewritten to the character's current
 *   phase) by the backend. If a `Character` is deleted, all refs with its
 *   `characterId` are removed. Frontend assumes referential integrity.
 */
export const characterRefSchema = z.object({
  characterId: characterIdSchema,
  phaseId: phaseIdSchema,
});

export type CharacterRef = z.infer<typeof characterRefSchema>;
