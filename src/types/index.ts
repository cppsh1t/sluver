/**
 * Barrel re-exports for all domain entity types.
 *
 * Import types and schemas from here:
 * ```ts
 * import { type World, type Scene, sceneSchema, type ChapterId } from '@/types';
 * ```
 */

// ─── Branded IDs ──────────────────────────────────────────────────────────
export { worldIdSchema, type WorldId } from './world';
export { characterIdSchema, type CharacterId, phaseIdSchema, type PhaseId } from './character';
export { locationIdSchema, type LocationId } from './location';
export { itemIdSchema, type ItemId } from './item';
export { loreIdSchema, type LoreId } from './lore';
export { eventIdSchema, type EventId } from './event';
export { novelIdSchema, type NovelId, chapterIdSchema, type ChapterId, sceneIdSchema, type SceneId } from './novel';

// ─── Top-level ────────────────────────────────────────────────────────────
export { worldSchema, type World } from './world';
export { appConfigSchema, type AppConfig } from './config';

// ─── World elements ───────────────────────────────────────────────────────
export { characterSchema, type Character, characterPhaseSchema, type CharacterPhase, characterRefSchema, type CharacterRef } from './character';
export { locationSchema, type Location } from './location';
export { itemSchema, type Item } from './item';
export { loreSchema, type Lore } from './lore';
export { eventSchema, type Event } from './event';

// ─── Novel structure ──────────────────────────────────────────────────────
export { novelSchema, type Novel, chapterSchema, type Chapter, sceneSchema, type Scene } from './novel';
