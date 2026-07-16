/**
 * Novel / Chapter / Scene IPC API.
 *
 * Novel → Chapter → Scene tree structure. Ordering within a parent
 * is managed by `position` column, reorderable via dedicated commands.
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

export function createNovel(worldId: WorldId, input: CreateNovelInput): Promise<Novel> {
  return call<Novel>('create_novel', { worldId, input });
}

export function getNovel(worldId: WorldId, id: NovelId): Promise<Novel> {
  return call<Novel>('get_novel', { worldId, id });
}

export function listNovels(worldId: WorldId): Promise<Novel[]> {
  return call<Novel[]>('list_novels', { worldId });
}

export function updateNovel(
  worldId: WorldId,
  id: NovelId,
  input: UpdateNovelInput,
): Promise<Novel> {
  return call<Novel>('update_novel', { worldId, id, input });
}

export function deleteNovel(worldId: WorldId, id: NovelId): Promise<void> {
  return call<void>('delete_novel', { worldId, id });
}

// ─── Chapter ────────────────────────────────────────────────────────────────

export function createChapter(
  worldId: WorldId,
  novelId: NovelId,
  input: CreateChapterInput,
): Promise<Chapter> {
  return call<Chapter>('create_chapter', { worldId, novelId, input });
}

export function getChapter(worldId: WorldId, id: ChapterId): Promise<Chapter> {
  return call<Chapter>('get_chapter', { worldId, id });
}

export function listChapters(worldId: WorldId, novelId: NovelId): Promise<Chapter[]> {
  return call<Chapter[]>('list_chapters', { worldId, novelId });
}

export function updateChapter(
  worldId: WorldId,
  id: ChapterId,
  input: UpdateChapterInput,
): Promise<Chapter> {
  return call<Chapter>('update_chapter', { worldId, id, input });
}

export function deleteChapter(worldId: WorldId, id: ChapterId): Promise<void> {
  return call<void>('delete_chapter', { worldId, id });
}

export function reorderChapters(
  worldId: WorldId,
  novelId: NovelId,
  chapterIds: ChapterId[],
): Promise<void> {
  return call<void>('reorder_chapters', { worldId, novelId, chapterIds });
}

// ─── Scene ──────────────────────────────────────────────────────────────────

export function createScene(
  worldId: WorldId,
  chapterId: ChapterId,
  input: CreateSceneInput,
): Promise<Scene> {
  return call<Scene>('create_scene', { worldId, chapterId, input });
}

export function getScene(worldId: WorldId, id: SceneId): Promise<Scene> {
  return call<Scene>('get_scene', { worldId, id });
}

export function listScenes(worldId: WorldId, chapterId: ChapterId): Promise<Scene[]> {
  return call<Scene[]>('list_scenes', { worldId, chapterId });
}

export function updateScene(
  worldId: WorldId,
  id: SceneId,
  input: UpdateSceneInput,
): Promise<Scene> {
  return call<Scene>('update_scene', { worldId, id, input });
}

export function deleteScene(worldId: WorldId, id: SceneId): Promise<void> {
  return call<void>('delete_scene', { worldId, id });
}

export function reorderScenes(
  worldId: WorldId,
  chapterId: ChapterId,
  sceneIds: SceneId[],
): Promise<void> {
  return call<void>('reorder_scenes', { worldId, chapterId, sceneIds });
}
