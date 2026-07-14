import { z } from "zod";
import { worldIdSchema } from "./world";
import { characterRefSchema } from "./character";
import { locationIdSchema } from "./location";
import { itemIdSchema } from "./item";
import { eventIdSchema } from "./event";

// ─── Branded IDs ──────────────────────────────────────────────────────────

export const novelIdSchema = z.string().brand<"NovelId">();
export type NovelId = z.infer<typeof novelIdSchema>;

export const chapterIdSchema = z.string().brand<"ChapterId">();
export type ChapterId = z.infer<typeof chapterIdSchema>;

export const sceneIdSchema = z.string().brand<"SceneId">();
export type SceneId = z.infer<typeof sceneIdSchema>;

// ─── Novel ────────────────────────────────────────────────────────────────

/**
 * 小说（Novel）— 一部完整的小说作品。
 *
 * Novel is a container — its **content** is its chapters. Novel-level
 * synopsis / outline do NOT live here; they belong to individual chapters
 * (Chapter.summary = 章节梗概, Chapter.sceneIds = 章节大纲).
 *
 * Structure tree:
 * ```
 * Novel
 * ├── title
 * ├── chapterIds ──→ Chapter[]   (ordered: position in array = reading order)
 * │                   ├── summary (章节梗概)
 * │                   └── sceneIds ──→ Scene[]  (章节大纲 = 场景序列)
 * │                                     ├── summary (场景梗概，来自大纲)
 * │                                     ├── content (AI 生成的正文)
 * │                                     └── entityRefs (角色/地点/物品/事件)
 * └── tags
 * ```
 */
export const novelSchema = z.object({
  id: novelIdSchema,
  worldId: worldIdSchema,
  title: z.string(),
  description: z.string(),
  /** Ordered chapter IDs — the novel's content. Position in array = reading order. */
  chapterIds: z.array(chapterIdSchema),
  /** User-defined tags for categorization / filtering. */
  tags: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Novel = z.infer<typeof novelSchema>;

// ─── Chapter ──────────────────────────────────────────────────────────────

/**
 * 章（Chapter）— a chapter in a novel.
 *
 * A chapter has:
 * - 章节梗概 (`summary`) — text describing what the chapter is about.
 * - 章节大纲 (`sceneIds`) — ordered reference list of the chapter's scenes.
 *   The outline EMERGES from resolving these references (each referenced
 *   scene's `summary` is a beat in the outline); `sceneIds` itself is just
 *   an ordered ID list, not the outline content.
 *
 * Chapter ordering within the novel is determined by the parent Novel's
 * `chapterIds` array position — no separate `order` field on Chapter.
 */
export const chapterSchema = z.object({
  id: chapterIdSchema,
  novelId: novelIdSchema,
  title: z.string(),
  /** 章节梗概 — what this chapter is about. */
  summary: z.string(),
  /** Ordered scene IDs — references that compose the chapter's outline.
   *  Position in array = narrative order. Outline content lives in each Scene. */
  sceneIds: z.array(sceneIdSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Chapter = z.infer<typeof chapterSchema>;

// ─── Scene ────────────────────────────────────────────────────────────────

/**
 * 场景（Scene）— the leaf unit of a novel, and the minimal AI generation target.
 *
 * A scene stores:
 * - 场景梗概 (`summary`, from the chapter outline — human or AI-assisted)
 * - 具体内容 (`content` — the AI-generated narrative prose)
 * - 关联实体引用 (entity references: characters at phases, single location,
 *   items, events)
 *
 * Entity references are stored as **pure ID references**. The frontend resolves
 * them to full entities by querying the Rust backend. This keeps Scene data
 * compact and avoids duplication — a character's details live in one place.
 *
 * Per the v0.1.0 design, ALL entity references are user-deletable after
 * AI auto-association. See doc §4.4.
 *
 * Scene ordering within the chapter is determined by the parent Chapter's
 * `sceneIds` array position — no separate `order` field on Scene.
 */
export const sceneSchema = z.object({
  id: sceneIdSchema,
  chapterId: chapterIdSchema,
  title: z.string(),
  /** 场景梗概 — short summary of what happens in this scene (from the chapter outline). */
  summary: z.string(),
  /** 具体内容 — the full AI-generated narrative prose. */
  content: z.string(),
  /** Story timeline — when this scene starts (ISO 8601). `null` if unspecified. */
  startAt: z.iso.datetime().nullable(),
  /** Story timeline — when this scene ends (ISO 8601). `null` if unspecified. */
  endAt: z.iso.datetime().nullable(),
  /**
   * Characters appearing in this scene, each pinned to a specific phase.
   * References `(characterId, phaseId)` pairs — the phase determines which
   * state of the character is active.
   */
  characterRefs: z.array(characterRefSchema),
  /** ID of the single location where this scene takes place. `null` if unspecified. */
  locationId: locationIdSchema.nullable(),
  /** IDs of items referenced in this scene. */
  itemIds: z.array(itemIdSchema),
  /** IDs of events referenced in this scene. */
  eventIds: z.array(eventIdSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Scene = z.infer<typeof sceneSchema>;
