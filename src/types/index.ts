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

// ─── Timeline (derived view — ADR-0033) ────────────────────────────────────
export {
  TIMELINE_LIMIT_MAX,
  timelineQuerySchema,
  type TimelineQuery,
  timelineEntrySchema,
  type TimelineEntry,
  timelineResponseSchema,
  type TimelineResponse,
  timelineLaneSchema,
  type TimelineLane,
} from './timeline';

// ─── Grep (match-centric retrieval — ADR-0035) ─────────────────────────────
export {
  grepEntityTypeSchema,
  type GrepEntityType,
  grepSnippetSchema,
  type GrepSnippet,
  grepMatchGroupSchema,
  type GrepMatchGroup,
  grepResultSchema,
  type GrepResult,
} from './grep';

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

// ─── Notes (single-table tree — ADR-0038) ─────────────────────────────────
export {
  noteIdSchema,
  type NoteId,
  noteKindSchema,
  type NoteKind,
  noteSchema,
  type Note,
  noteSummarySchema,
  type NoteSummary,
  createNoteInputSchema,
  type CreateNoteInput,
  updateNoteInputSchema,
  type UpdateNoteInput,
  grepNotesInputSchema,
  type GrepNotesInput,
  noteSnippetSchema,
  type NoteSnippet,
  noteMatchGroupSchema,
  type NoteMatchGroup,
  grepNotesResponseSchema,
  type GrepNotesResponse,
  noteTreeNodeSchema,
  type NoteTreeNode,
} from './note';

// ─── Conversation (AI chat) ────────────────────────────────────────────────
export {
  conversationSchema,
  type Conversation,
  conversationMetaSchema,
  type ConversationMeta,
  messageSchema,
  type Message,
} from './conversation';

// ─── Agent Skills (storage-center install model — ADR-0043) ───────────────
export {
  skillIdSchema,
  type SkillId,
  skillSummarySchema,
  type SkillSummary,
  enabledSkillSchema,
  type EnabledSkill,
  skillEntrySchema,
  type SkillEntry,
} from './skill';
