/**
 * Novel / Chapter / Scene IPC API.
 *
 * Novel → Chapter → Scene tree structure. Ordering within a parent
 * is managed by `position` column, reorderable via dedicated commands.
 * All scoped to a Space + World via `spaceId` + `worldId`.
 */

import type {
  Chapter,
  ChapterId,
  ChapterSummary,
  Novel,
  NovelId,
  NovelSummary,
  Scene,
  SceneId,
  SceneSummary,
  WorldId,
} from '@/types';
import { call } from './client';
import type {
  CreateChapterInput,
  CreateNovelInput,
  CreateSceneInput,
  UpdateChapterInput,
  UpdateNovelInput,
  UpdateSceneInput,
} from './types';

// ─── Novel ──────────────────────────────────────────────────────────────────

export function createNovel(spaceId: string, worldId: WorldId, input: CreateNovelInput): Promise<Novel> {
  return call<Novel>('create_novel', { spaceId, worldId, input });
}

export function getNovel(spaceId: string, worldId: WorldId, id: NovelId): Promise<Novel> {
  return call<Novel>('get_novel', { spaceId, worldId, id });
}

export function listNovels(spaceId: string, worldId: WorldId): Promise<Novel[]> {
  return call<Novel[]>('list_novels', { spaceId, worldId });
}

/** Lightweight novel list — `id`, `title`, `tags`, `author`. */
export function listNovelSummaries(spaceId: string, worldId: WorldId): Promise<NovelSummary[]> {
  return call<NovelSummary[]>('list_novel_summaries', { spaceId, worldId });
}

/** Substring search across title, description, author, and tags. Returns matching summaries. */
export function searchNovels(spaceId: string, worldId: WorldId, query: string): Promise<NovelSummary[]> {
  return call<NovelSummary[]>('search_novels', { spaceId, worldId, query });
}

export function updateNovel(
  spaceId: string,
  worldId: WorldId,
  id: NovelId,
  input: UpdateNovelInput,
): Promise<Novel> {
  return call<Novel>('update_novel', { spaceId, worldId, id, input });
}

export function deleteNovel(spaceId: string, worldId: WorldId, id: NovelId): Promise<void> {
  return call<void>('delete_novel', { spaceId, worldId, id });
}

// ─── Chapter ────────────────────────────────────────────────────────────────

export function createChapter(
  spaceId: string,
  worldId: WorldId,
  novelId: NovelId,
  input: CreateChapterInput,
): Promise<Chapter> {
  return call<Chapter>('create_chapter', { spaceId, worldId, novelId, input });
}

export function getChapter(spaceId: string, worldId: WorldId, id: ChapterId): Promise<Chapter> {
  return call<Chapter>('get_chapter', { spaceId, worldId, id });
}

export function listChapters(spaceId: string, worldId: WorldId, novelId: NovelId): Promise<Chapter[]> {
  return call<Chapter[]>('list_chapters', { spaceId, worldId, novelId });
}

/** Lightweight chapter list — `id`, `title` only. */
export function listChapterSummaries(spaceId: string, worldId: WorldId, novelId: NovelId): Promise<ChapterSummary[]> {
  return call<ChapterSummary[]>('list_chapter_summaries', { spaceId, worldId, novelId });
}

/** Substring search across title and summary. Returns matching summaries. */
export function searchChapters(spaceId: string, worldId: WorldId, query: string): Promise<ChapterSummary[]> {
  return call<ChapterSummary[]>('search_chapters', { spaceId, worldId, query });
}

export function updateChapter(
  spaceId: string,
  worldId: WorldId,
  id: ChapterId,
  input: UpdateChapterInput,
): Promise<Chapter> {
  return call<Chapter>('update_chapter', { spaceId, worldId, id, input });
}

export function deleteChapter(spaceId: string, worldId: WorldId, id: ChapterId): Promise<void> {
  return call<void>('delete_chapter', { spaceId, worldId, id });
}

export function reorderChapters(
  spaceId: string,
  worldId: WorldId,
  novelId: NovelId,
  chapterIds: ChapterId[],
): Promise<void> {
  return call<void>('reorder_chapters', { spaceId, worldId, novelId, chapterIds });
}

// ─── Scene ──────────────────────────────────────────────────────────────────

export function createScene(
  spaceId: string,
  worldId: WorldId,
  chapterId: ChapterId,
  input: CreateSceneInput,
): Promise<Scene> {
  return call<Scene>('create_scene', { spaceId, worldId, chapterId, input });
}

export function getScene(spaceId: string, worldId: WorldId, id: SceneId): Promise<Scene> {
  return call<Scene>('get_scene', { spaceId, worldId, id });
}

export function listScenes(spaceId: string, worldId: WorldId, chapterId: ChapterId): Promise<Scene[]> {
  return call<Scene[]>('list_scenes', { spaceId, worldId, chapterId });
}

/** Lightweight scene list — `id`, `title` only. */
export function listSceneSummaries(spaceId: string, worldId: WorldId, chapterId: ChapterId): Promise<SceneSummary[]> {
  return call<SceneSummary[]>('list_scene_summaries', { spaceId, worldId, chapterId });
}

/** Substring search across title, summary, content, start time, and end time. Returns matching summaries. */
export function searchScenes(spaceId: string, worldId: WorldId, query: string): Promise<SceneSummary[]> {
  return call<SceneSummary[]>('search_scenes', { spaceId, worldId, query });
}

export function updateScene(
  spaceId: string,
  worldId: WorldId,
  id: SceneId,
  input: UpdateSceneInput,
): Promise<Scene> {
  return call<Scene>('update_scene', { spaceId, worldId, id, input });
}

export function deleteScene(spaceId: string, worldId: WorldId, id: SceneId): Promise<void> {
  return call<void>('delete_scene', { spaceId, worldId, id });
}

export function reorderScenes(
  spaceId: string,
  worldId: WorldId,
  chapterId: ChapterId,
  sceneIds: SceneId[],
): Promise<void> {
  return call<void>('reorder_scenes', { spaceId, worldId, chapterId, sceneIds });
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Export format. Bare string over IPC — the Rust side is a unit enum
 * `ExportFormat { Epub, Txt }` with `#[serde(rename_all = "camelCase")]`,
 * which serde accepts as a plain string for unit variants.
 */
export type ExportFormat = 'epub' | 'txt';

/**
 * Export a novel to a file on disk.
 *
 * `outputPath` MUST be an absolute path, typically obtained from the
 * `save()` native dialog (`@tauri-apps/plugin-dialog`). The Rust side
 * writes the file via `std::fs`, so no `fs:*` Tauri capability is
 * required. Returns void; rejects with `ErrorPayload` on failure.
 *
 * See ADR-0027 for the EPUB + TXT generation contract.
 */
export function exportNovel(args: {
  spaceId: string;
  worldId: WorldId;
  novelId: NovelId;
  format: ExportFormat;
  outputPath: string;
}): Promise<void> {
  return call<void>('export_novel', {
    spaceId: args.spaceId,
    worldId: args.worldId,
    novelId: args.novelId,
    format: args.format,
    outputPath: args.outputPath,
  });
}
