/**
 * Input type definitions for Tauri IPC commands.
 *
 * All types are derived from entity types via `Pick` + utility types —
 * no field types are duplicated. If an entity field changes, input
 * types follow automatically.
 *
 * - `Update*` = entity minus metadata (`id`, `worldId`, timestamps, child arrays)
 * - `Create*` = same fields, but everything except the primary key is optional
 *   (mirrors Rust `#[serde(default)]`)
 */

import type {
  Character,
  CharacterPhase,
  Chapter,
  Event,
  Location,
  Novel,
  Scene,
  World,
} from '@/types';

/**
 * Build a create-input: require only keys `R`, make everything else optional.
 *
 * ```ts
 * type CreateWorldInput = CreateInput<Pick<World, 'name' | 'description'>, 'name'>;
 * // => { name: string; description?: string }
 * ```
 */
type CreateInput<T, R extends keyof T> = Pick<T, R> & Partial<Omit<T, R>>;

// ─── Editable field sets (shared between Create and Update) ─────────────────

type WorldFields = Pick<World, 'name' | 'description'>;
type PhaseFields = Pick<CharacterPhase, 'appearance' | 'changes' | 'triggerEventId'>;
type CharacterFields = Pick<Character, 'name' | 'aliases' | 'description' | 'notes' | 'tags'>;
type ElementFields = Pick<Location, 'name' | 'description' | 'notes' | 'tags'>;
type EventFields = Pick<Event, 'name' | 'description' | 'startAt' | 'endAt' | 'characterRefs' | 'locationId' | 'notes' | 'tags'>;
type NovelFields = Pick<Novel, 'title' | 'tags'>;
type ChapterFields = Pick<Chapter, 'title' | 'summary'>;
type SceneFields = Pick<Scene, 'title' | 'summary' | 'content' | 'startAt' | 'endAt' | 'characterRefs' | 'locationId' | 'itemIds' | 'eventIds'>;

// ─── World ──────────────────────────────────────────────────────────────────

export type CreateWorldInput = CreateInput<WorldFields, 'name'>;
export type UpdateWorldInput = WorldFields;

// ─── Character + Phase ──────────────────────────────────────────────────────

export type CreatePhaseInput = CreateInput<PhaseFields, 'appearance'>;
export type UpdatePhaseInput = PhaseFields;

export type CreateCharacterInput = CreateInput<CharacterFields, 'name'> & {
  initialPhase: CreatePhaseInput;
};
export type UpdateCharacterInput = CharacterFields;

// ─── Location / Item / Lore (identical shape) ───────────────────────────────

export type CreateElementInput = CreateInput<ElementFields, 'name'>;
export type UpdateElementInput = ElementFields;

// ─── Event ──────────────────────────────────────────────────────────────────

export type CreateEventInput = CreateInput<EventFields, 'name'>;
export type UpdateEventInput = EventFields;

// ─── Novel ──────────────────────────────────────────────────────────────────

export type CreateNovelInput = CreateInput<NovelFields, 'title'>;
export type UpdateNovelInput = NovelFields;

// ─── Chapter ────────────────────────────────────────────────────────────────

export type CreateChapterInput = CreateInput<ChapterFields, 'title'>;
export type UpdateChapterInput = ChapterFields;

// ─── Scene ──────────────────────────────────────────────────────────────────

export type CreateSceneInput = CreateInput<SceneFields, 'title'>;
export type UpdateSceneInput = SceneFields;
