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
  catalogModelSchema,
  type CatalogModel,
  catalogProviderSchema,
  type CatalogProvider,
  modelsDevCatalogSchema,
  type ModelsDevCatalog,
} from './ai';

// ─── World elements ───────────────────────────────────────────────────────
export { characterSchema, type Character, characterPhaseSchema, type CharacterPhase, characterRefSchema, type CharacterRef } from './character';
export { locationSchema, type Location } from './location';
export { itemSchema, type Item } from './item';
export { loreSchema, type Lore } from './lore';
export { eventSchema, type Event } from './event';

// ─── Novel structure ──────────────────────────────────────────────────────
export { novelSchema, type Novel, chapterSchema, type Chapter, sceneSchema, type Scene, sceneImageMetaSchema, type SceneImageMeta } from './novel';

// ─── Conversation (AI chat) ────────────────────────────────────────────────
export {
  conversationSchema,
  type Conversation,
  conversationMetaSchema,
  type ConversationMeta,
  messageSchema,
  type Message,
} from './conversation';
