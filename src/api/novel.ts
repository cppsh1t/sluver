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
  Novel,
  NovelId,
  Scene,
  SceneId,
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
