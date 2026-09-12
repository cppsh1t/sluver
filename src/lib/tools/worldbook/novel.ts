/**
 * Novel domain tools — Novel, Chapter, Scene.
 *
 * Novel → Chapter → Scene tree. Chapters and Scenes are ordered within their
 * parent (reorderable). Scenes carry prose content and reference worldbook
 * entities (characters at phases, items, lore, events, location). Scenes also
 * own a 1:N image gallery (`scene_images` sidecar table) with its own tool
 * surface below.
 *
 * Consent levels: list/get → `auto`, create + set_*_image_from_* +
 * add_scene_image_* → `configurable`, update/delete/reorder/clear_*_image →
 * `always`.
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
  getChapterOverview,
  getNovel,
  getScene,
  listChapterSummaries,
  listNovelSummaries,
  listSceneSummaries,
  reorderChapters,
  reorderScenes,
  searchChapters,
  searchNovels,
  searchScenes,
  updateChapter,
  updateNovel,
  updateScene,
} from "@/api/novel";
import {
  addSceneImage,
  deleteSceneImage,
  listSceneImageIds,
} from "@/api/scene-image";
import { clearNovelImage, updateNovelImage } from "@/api/image";
import type { ToolDef } from "../types";
import {
  executeAddSceneImageFromAttachment,
  executeAddSceneImageFromUrl,
  executeSetImageFromAttachment,
  filenameSchema,
} from "./image-from-attachment";
import {
  ENTITY_IMAGE_CROP_SPEC,
  executeSetImageFromUrl,
  imageUrlSchema,
} from "./image-from-url";

// ─── Shared ───────────────────────────────────────────────────────────────

const characterRefSchema = z.object({
  characterId: z.string().describe("The character's UUID."),
  phaseId: z.string().describe("The phase UUID the character is in during this scene."),
});

// ─── Novel ────────────────────────────────────────────────────────────────

const createNovelSchema = z.object({
  title: z.string().min(1).describe("Novel title (must be unique within the world)."),
  description: z.string().optional().describe("Novel description / synopsis."),
  author: z.string().optional().describe("Author name shown on exports."),
  tags: z.array(z.string()).optional().describe("Categorization tags."),
});

const updateNovelSchema = createNovelSchema.extend({
  id: z.string().describe("The novel's UUID."),
});

export function novelTools(): Record<string, ToolDef> {
  return {
    list_novels: {
      description:
        "List all novels in the current world. Returns summary fields (id, title, tags, author) only — call get_novel for description and chapter IDs.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listNovelSummaries(ctx.spaceId, ctx.worldId),
    },
    search_novels: {
      description:
        "Search novels by substring match across title, description, author, and tags. Returns matching novel summaries (id, title, tags, author) — call get_novel for full fields on specific hits.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchNovels(ctx.spaceId, ctx.worldId, query);
      },
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
        const { id, ...changes } = input as { id: string; title?: string; description?: string; author?: string; tags?: string[] };
        const current = await getNovel(ctx.spaceId, ctx.worldId, id as never);
        return updateNovel(ctx.spaceId, ctx.worldId, id as never, {
          title: changes.title ?? current.title,
          description: changes.description ?? current.description,
          author: changes.author ?? current.author,
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

    // ── Image from URL (configurable) ──────────────────────────────
    //
    // Center-crop to 2:3 portrait (book-cover aspect), resize to 320×480,
    // lossless WebP. The 2:3 ratio matches standard paperback covers.

    set_novel_image_from_url: {
      description:
        "Set a novel's cover image by downloading from a URL — useful for " +
        "attaching cover art, a dust-jacket scan, or promotional artwork found " +
        "via `web_search`. The image is downloaded, center-cropped to 2:3 " +
        "portrait (the standard book-cover aspect), resized to 320×480, and " +
        "re-encoded as lossless WebP. Any previous cover is overwritten. " +
        "Prefer portrait-orientation sources (typical book-cover shape) — " +
        "landscape sources get center-cropped and may cut the sides.",
      inputSchema: z.object({
        id: z.string().describe("The novel's UUID."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { id, imageUrl } = input as { id: string; imageUrl: string };
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.novel,
          (bytes, mime) =>
            updateNovelImage(ctx.spaceId, ctx.worldId, id as never, bytes, mime),
        );
      },
    },

    // ── Image from attachment (configurable) ─────────────────────────────
    //
    // Same 2:3 → 320×480 → lossless WebP pipeline as the from-URL tool,
    // but the source is an in-conversation attachment; `prepare_image`
    // compresses it into the canonical cover form (ADR-0048).

    set_novel_image_from_attachment: {
      description:
        "Set a novel's cover image from a file the user attached in this " +
        "conversation — e.g. cover art they commissioned or scanned " +
        "themselves. Pass the EXACT filename from the `[image attachment: " +
        "\"...\"]` marker; the attachment is fetched from the thread, " +
        "center-cropped to 2:3 portrait (the standard book-cover aspect), " +
        "resized to 320×480, and re-encoded as lossless WebP (large images " +
        "are compressed automatically). Any previous cover is overwritten. " +
        "Use set_novel_image_from_url instead when the image lives at a link.",
      inputSchema: z.object({
        id: z.string().describe("The novel's UUID."),
        filename: filenameSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { id, filename } = input as { id: string; filename: string };
        return executeSetImageFromAttachment(
          ctx,
          filename,
          ENTITY_IMAGE_CROP_SPEC.novel,
          (bytes, mime) =>
            updateNovelImage(ctx.spaceId, ctx.worldId, id as never, bytes, mime),
        );
      },
    },

    // ── Clear image (always) ──────────────────────────────────────────────

    clear_novel_image: {
      description:
        "Remove a novel's cover image. The novel, its chapters, and its " +
        "scenes are untouched — only the stored cover bytes are discarded, " +
        "and they cannot be recovered afterwards. Confirm with the user " +
        "first if they did not explicitly ask for the removal.",
      inputSchema: z.object({ id: z.string().describe("The novel's UUID.") }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await clearNovelImage(ctx.spaceId, ctx.worldId, id as never);
        return { cleared: true, id };
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
      description:
        "List all chapters in a novel. Returns summary fields (id, title) only — call get_chapter for summary text and scene IDs.",
      inputSchema: z.object({ novelId: z.string().describe("The novel's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { novelId } = input as { novelId: string };
        return listChapterSummaries(ctx.spaceId, ctx.worldId, novelId as never);
      },
    },
    search_chapters: {
      description:
        "Search chapters by substring match across title and summary. Returns matching chapter summaries (id, title) — call get_chapter for full fields on specific hits.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchChapters(ctx.spaceId, ctx.worldId, query);
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
    get_chapter_overview: {
      description:
        "Get a chapter with ALL its scenes' overviews in one call — the chapter's own fields (title, summary, sceneIds) plus every scene's summary, timeline, and entity references (characterRefs, locationId, itemIds, eventIds, loreIds). Scene prose (`content`) is deliberately excluded to keep the payload small. Use this to quickly understand what happens in a chapter and which worldbook entities it touches, before drafting or reordering.",
      inputSchema: z.object({ id: z.string().describe("The chapter's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getChapterOverview(ctx.spaceId, ctx.worldId, id as never);
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
  loreIds: z.array(z.string()).optional().describe("UUIDs of lore entries referenced."),
});

const updateSceneSchema = createSceneSchema.extend({
  id: z.string().describe("The scene's UUID."),
});

export function sceneTools(): Record<string, ToolDef> {
  return {
    list_scenes: {
      description:
        "List all scenes in a chapter. Returns summary fields (id, title) only — call get_scene for summary, content, and entity references.",
      inputSchema: z.object({ chapterId: z.string().describe("The chapter's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { chapterId } = input as { chapterId: string };
        return listSceneSummaries(ctx.spaceId, ctx.worldId, chapterId as never);
      },
    },
    search_scenes: {
      description:
        "Search scenes by substring match across title, summary, content, start time, and end time. Returns matching scene summaries (id, title) — call get_scene for full fields on specific hits.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchScenes(ctx.spaceId, ctx.worldId, query);
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
        "Create a new scene in a chapter. Position auto-appends. Pass characterRefs, itemIds, eventIds, loreIds to link worldbook entities.",
      inputSchema: createSceneSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { chapterId, ...rest } = input as { chapterId: string; [k: string]: unknown };
        return createScene(ctx.spaceId, ctx.worldId, chapterId as never, rest as never);
      },
    },
    update_scene: {
      description:
        "Update an existing scene. Only provided fields are changed. NOTE: characterRefs/itemIds/eventIds/loreIds are full-replacement — provide the COMPLETE desired array.",
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
          loreIds?: string[];
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
          loreIds: (changes.loreIds ?? current.loreIds) as never,
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

    // ── Scene gallery (mood-board images attached to a scene) ───────────
    //
    // Unlike entity portraits (fixed crop specs), gallery images keep their
    // source aspect ratio: `prepare_image` runs in fit-within mode, scaling
    // the longest edge down to ≤1600px and re-encoding as ≤1 MiB WebP
    // (ADR-0048). The backend appends at the tail of the gallery and
    // renumbers positions on delete.

    add_scene_image_from_url: {
      description:
        "Append an image to a scene's gallery by downloading it from a URL " +
        "— reference art, mood-board material, or location scouting found " +
        "via `web_search`. The image is downscaled to fit within 1600×1600 " +
        "(aspect ratio preserved — NO cropping), re-encoded as WebP under " +
        "1 MiB, and appended at the end of the gallery. Returns the new " +
        "image's id and position. Call list_scene_images to see the gallery " +
        "first.",
      inputSchema: z.object({
        sceneId: z.string().describe("The scene's UUID."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { sceneId, imageUrl } = input as { sceneId: string; imageUrl: string };
        return executeAddSceneImageFromUrl(ctx, imageUrl, (bytes, mime) =>
          addSceneImage(ctx.spaceId, ctx.worldId, sceneId as never, bytes, mime),
        );
      },
    },

    add_scene_image_from_attachment: {
      description:
        "Append an image to a scene's gallery from a file the user attached " +
        "in this conversation. Pass the EXACT filename from the " +
        '`[image attachment: "..."]` marker; the attachment is fetched from ' +
        "the thread, downscaled to fit within 1600×1600 (aspect ratio " +
        "preserved — NO cropping), re-encoded as WebP under 1 MiB, and " +
        "appended at the end of the gallery. Returns the new image's id and " +
        "position. Use add_scene_image_from_url instead when the image " +
        "lives at a link.",
      inputSchema: z.object({
        sceneId: z.string().describe("The scene's UUID."),
        filename: filenameSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { sceneId, filename } = input as { sceneId: string; filename: string };
        return executeAddSceneImageFromAttachment(ctx, filename, (bytes, mime) =>
          addSceneImage(ctx.spaceId, ctx.worldId, sceneId as never, bytes, mime),
        );
      },
    },

    delete_scene_image: {
      description:
        "Delete one image from a scene's gallery by its image id (from " +
        "list_scene_images). The remaining images keep their relative order " +
        "(positions are renumbered automatically); the scene itself and its " +
        "other images are untouched. The stored bytes cannot be recovered " +
        "afterwards.",
      inputSchema: z.object({
        imageId: z.string().describe("The gallery image's own UUID (from list_scene_images — NOT the scene id)."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { imageId } = input as { imageId: string };
        await deleteSceneImage(ctx.spaceId, ctx.worldId, imageId as never);
        return { deleted: true, id: imageId };
      },
    },

    list_scene_images: {
      description:
        "List a scene's gallery images in display order — id and position " +
        "per entry, metadata only (no pixels). Use look_at with " +
        'entityKind "scene_image" and an image\'s id to learn what a given ' +
        "image actually shows, and delete_scene_image to remove entries.",
      inputSchema: z.object({
        sceneId: z.string().describe("The scene's UUID."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { sceneId } = input as { sceneId: string };
        return listSceneImageIds(ctx.spaceId, ctx.worldId, sceneId as never);
      },
    },
  };
}
