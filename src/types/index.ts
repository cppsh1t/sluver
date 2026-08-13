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
export { novelIdSchema, type NovelId, chapterIdSchema, type ChapterId, sceneIdSchema, type SceneId, sceneImageIdSchema, type SceneImageId } from './novel';
export { conversationIdSchema, type ConversationId } from './conversation';
export { spaceIdSchema, type SpaceId } from './space';
export { providerCredentialIdSchema, type ProviderCredentialId, agentConfigIdSchema, type AgentConfigId } from './ai';

// ─── Top-level ────────────────────────────────────────────────────────────
export { worldSchema, type World } from './world';
export { appSettingSchema, type AppSetting } from './setting';
export {
  spaceSummarySchema,
  type SpaceSummary,
  createSpaceInputSchema,
  type CreateSpaceInput,
  updateSpaceInputSchema,
  type UpdateSpaceInput,
  setSpacePasswordInputSchema,
  type SetSpacePasswordInput,
} from './space';
export { sessionStateSchema, type SessionState } from './session';

// ─── AI config ─────────────────────────────────────────────────────────────
export {
  providerCredentialSchema,
  type ProviderCredential,
  setProviderCredentialInputSchema,
  type SetProviderCredentialInput,
  agentConfigSchema,
  type AgentConfig,
  contextCompactionSchema,
  type ContextCompaction,
  catalogModelSchema,
  type CatalogModel,
  catalogProviderSchema,
  type CatalogProvider,
  modelsDevCatalogSchema,
  type ModelsDevCatalog,
} from './ai';

// ─── World elements ───────────────────────────────────────────────────────
export {
  characterSchema,
  type Character,
  characterSummarySchema,
  type CharacterSummary,
  characterPhaseSchema,
  type CharacterPhase,
  characterRefSchema,
  type CharacterRef,
} from './character';
export { locationSchema, type Location, locationSummarySchema, type LocationSummary } from './location';
export { itemSchema, type Item, itemSummarySchema, type ItemSummary } from './item';
export { loreSchema, type Lore, loreSummarySchema, type LoreSummary } from './lore';
export { eventSchema, type Event, eventSummarySchema, type EventSummary } from './event';

// ─── Novel structure ──────────────────────────────────────────────────────
export {
  novelSchema,
  type Novel,
  novelSummarySchema,
  type NovelSummary,
  chapterSchema,
  type Chapter,
  chapterSummarySchema,
  type ChapterSummary,
  sceneSchema,
  type Scene,
  sceneSummarySchema,
  type SceneSummary,
  sceneOverviewSchema,
  type SceneOverview,
  chapterOverviewSchema,
  type ChapterOverview,
  sceneImageMetaSchema,
  type SceneImageMeta,
} from './novel';

// ─── Conversation (AI chat) ────────────────────────────────────────────────
export {
  conversationSchema,
  type Conversation,
  conversationMetaSchema,
  type ConversationMeta,
  messageSchema,
  type Message,
} from './conversation';
