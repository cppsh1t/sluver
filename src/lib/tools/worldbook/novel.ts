/**
 * Novel domain tools — Novel, Chapter, Scene.
 *
 * Novel → Chapter → Scene tree. Chapters and Scenes are ordered within their
 * parent (reorderable). Scenes carry prose content and reference worldbook
 * entities (characters at phases, items, events, location).
 *
 * Consent levels: list/get → `auto`, create → `configurable`, update/delete/reorder → `always`.
 */

import { z } from "zod";

import {
  createChapter,
  createNovel,
  createScene,
  deleteChapter,
  deleteNovel,
  deleteScene,
  getChapter,
  getNovel,
  getScene,
  listChapters,
  listNovels,
  listScenes,
  reorderChapters,
  reorderScenes,
  updateChapter,
  updateNovel,
  updateScene,
} from "@/api/novel";
import type { ToolDef } from "../types";

// ─── Shared ───────────────────────────────────────────────────────────────

const characterRefSchema = z.object({
  characterId: z.string().describe("The character's UUID."),
  phaseId: z.string().describe("The phase UUID the character is in during this scene."),
});

// ─── Novel ────────────────────────────────────────────────────────────────

const createNovelSchema = z.object({
  title: z.string().min(1).describe("Novel title (must be unique within the world)."),
  description: z.string().optional().describe("Novel description / synopsis."),
  tags: z.array(z.string()).optional().describe("Categorization tags."),
});

const updateNovelSchema = createNovelSchema.extend({
  id: z.string().describe("The novel's UUID."),
});

export function novelTools(): Record<string, ToolDef> {
  return {
    list_novels: {
      description: "List all novels in the current world.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listNovels(ctx.spaceId, ctx.worldId),
    },
    get_novel: {
      description: "Get a single novel by ID, including its chapter IDs.",
      inputSchema: z.object({ id: z.string().describe("The novel's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getNovel(ctx.spaceId, ctx.worldId, id as never);
      },
    },
    create_novel: {
      description: "Create a new novel. The title must be unique within the world.",
      inputSchema: createNovelSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        return createNovel(ctx.spaceId, ctx.worldId, input as never);
      },
    },
    update_novel: {
      description:
        "Update an existing novel. Only provided fields are changed; omitted fields keep their current values.",
      inputSchema: updateNovelSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as { id: string; title?: string; description?: string; tags?: string[] };
        const current = await getNovel(ctx.spaceId, ctx.worldId, id as never);
        return updateNovel(ctx.spaceId, ctx.worldId, id as never, {
          title: changes.title ?? current.title,
          description: changes.description ?? current.description,
          tags: changes.tags ?? current.tags,
        });
      },
    },
    delete_novel: {
      description: "Delete a novel and all its chapters and scenes.",
      inputSchema: z.object({ id: z.string().describe("The novel's UUID.") }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteNovel(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },
  };
}

// ─── Chapter ──────────────────────────────────────────────────────────────

const createChapterSchema = z.object({
  novelId: z.string().describe("The parent novel's UUID."),
  title: z.string().min(1).describe("Chapter title (must be unique within the novel)."),
  summary: z.string().optional().describe("Chapter outline or purpose (not the prose itself)."),
});

const updateChapterSchema = z.object({
  id: z.string().describe("The chapter's UUID."),
  title: z.string().optional().describe("New title."),
  summary: z.string().optional().describe("New summary."),
});

export function chapterTools(): Record<string, ToolDef> {
  return {
    list_chapters: {
      description: "List all chapters in a novel, including their scene IDs.",
      inputSchema: z.object({ novelId: z.string().describe("The novel's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { novelId } = input as { novelId: string };
        return listChapters(ctx.spaceId, ctx.worldId, novelId as never);
      },
    },
    get_chapter: {
      description: "Get a single chapter by ID.",
      inputSchema: z.object({ id: z.string().describe("The chapter's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getChapter(ctx.spaceId, ctx.worldId, id as never);
      },
    },
    create_chapter: {
      description: "Create a new chapter in a novel. Position auto-appends to the end.",
      inputSchema: createChapterSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { novelId, ...rest } = input as { novelId: string; title: string; summary?: string };
        return createChapter(ctx.spaceId, ctx.worldId, novelId as never, rest as never);
      },
    },
    update_chapter: {
      description:
        "Update an existing chapter. Only provided fields are changed; omitted fields keep their current values.",
      inputSchema: updateChapterSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as { id: string; title?: string; summary?: string };
        const current = await getChapter(ctx.spaceId, ctx.worldId, id as never);
        return updateChapter(ctx.spaceId, ctx.worldId, id as never, {
          title: changes.title ?? current.title,
          summary: changes.summary ?? current.summary,
        });
      },
    },
    delete_chapter: {
      description: "Delete a chapter and all its scenes.",
      inputSchema: z.object({ id: z.string().describe("The chapter's UUID.") }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteChapter(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },
    reorder_chapters: {
      description:
        "Reorder chapters within a novel. Pass ALL chapter IDs in the desired order. Call list_chapters first.",
      inputSchema: z.object({
        novelId: z.string().describe("The novel's UUID."),
        chapterIds: z.array(z.string()).describe("All chapter UUIDs in the desired order."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { novelId, chapterIds } = input as { novelId: string; chapterIds: string[] };
        await reorderChapters(ctx.spaceId, ctx.worldId, novelId as never, chapterIds as never);
        return { reordered: true, novelId, order: chapterIds };
      },
    },
  };
}

// ─── Scene ────────────────────────────────────────────────────────────────

const createSceneSchema = z.object({
  chapterId: z.string().describe("The parent chapter's UUID."),
  title: z.string().min(1).describe("Scene title (must be unique within the chapter)."),
  summary: z.string().optional().describe("Scene summary / outline."),
  content: z.string().optional().describe("The scene's prose text (plain text)."),
  startAt: z.string().datetime({ offset: true }).optional().describe("ISO 8601 timestamp (e.g. 2026-01-15T10:30:00Z) for when the scene starts. Free-form text like \"midnight\" is rejected."),
  endAt: z.string().datetime({ offset: true }).optional().describe("ISO 8601 timestamp (e.g. 2026-01-15T10:30:00Z) for when the scene ends. Free-form text like \"midnight\" is rejected."),
  characterRefs: z.array(characterRefSchema).optional().describe("Characters appearing, each pinned to a phase."),
  locationId: z.string().optional().describe("UUID of the location."),
  itemIds: z.array(z.string()).optional().describe("UUIDs of items appearing."),
  eventIds: z.array(z.string()).optional().describe("UUIDs of events referenced."),
});

const updateSceneSchema = createSceneSchema.extend({
  id: z.string().describe("The scene's UUID."),
});

export function sceneTools(): Record<string, ToolDef> {
  return {
    list_scenes: {
      description: "List all scenes in a chapter, including their character/item/event references.",
      inputSchema: z.object({ chapterId: z.string().describe("The chapter's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { chapterId } = input as { chapterId: string };
        return listScenes(ctx.spaceId, ctx.worldId, chapterId as never);
      },
    },
    get_scene: {
      description: "Get a single scene by ID, including prose content and references.",
      inputSchema: z.object({ id: z.string().describe("The scene's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getScene(ctx.spaceId, ctx.worldId, id as never);
      },
    },
    create_scene: {
      description:
        "Create a new scene in a chapter. Position auto-appends. Pass characterRefs, itemIds, eventIds to link worldbook entities.",
      inputSchema: createSceneSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { chapterId, ...rest } = input as { chapterId: string; [k: string]: unknown };
        return createScene(ctx.spaceId, ctx.worldId, chapterId as never, rest as never);
      },
    },
    update_scene: {
      description:
        "Update an existing scene. Only provided fields are changed. NOTE: characterRefs/itemIds/eventIds are full-replacement — provide the COMPLETE desired array.",
      inputSchema: updateSceneSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as {
          id: string;
          title?: string;
          summary?: string;
          content?: string;
          startAt?: string;
          endAt?: string;
          characterRefs?: unknown[];
          locationId?: string;
          itemIds?: string[];
          eventIds?: string[];
        };
        const current = await getScene(ctx.spaceId, ctx.worldId, id as never);
        return updateScene(ctx.spaceId, ctx.worldId, id as never, {
          title: changes.title ?? current.title,
          summary: changes.summary ?? current.summary,
          content: changes.content ?? current.content,
          startAt: changes.startAt ?? current.startAt,
          endAt: changes.endAt ?? current.endAt,
          characterRefs: (changes.characterRefs ?? current.characterRefs) as never,
          locationId: (changes.locationId ?? current.locationId) as never,
          itemIds: (changes.itemIds ?? current.itemIds) as never,
          eventIds: (changes.eventIds ?? current.eventIds) as never,
        });
      },
    },
    delete_scene: {
      description: "Delete a scene.",
      inputSchema: z.object({ id: z.string().describe("The scene's UUID.") }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteScene(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },
    reorder_scenes: {
      description:
        "Reorder scenes within a chapter. Pass ALL scene IDs in the desired order. Call list_scenes first.",
      inputSchema: z.object({
        chapterId: z.string().describe("The chapter's UUID."),
        sceneIds: z.array(z.string()).describe("All scene UUIDs in the desired order."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { chapterId, sceneIds } = input as { chapterId: string; sceneIds: string[] };
        await reorderScenes(ctx.spaceId, ctx.worldId, chapterId as never, sceneIds as never);
        return { reordered: true, chapterId, order: sceneIds };
      },
    },
  };
}
