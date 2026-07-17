import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createChapter,
  createNovel,
  createScene,
  deleteChapter,
  deleteNovel,
  deleteScene,
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
} from "@/api";
import type {
  CreateChapterInput,
  CreateNovelInput,
  CreateSceneInput,
  UpdateChapterInput,
  UpdateNovelInput,
  UpdateSceneInput,
} from "@/api";
import type {
  ChapterId,
  NovelId,
  SceneId,
  WorldId,
} from "@/types";

// ─── Novel queries ───────────────────────────────────────────────────────────

export const useNovels = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["novels", spaceId, worldId],
    queryFn: () => listNovels(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

export const useNovel = (spaceId: string, worldId: WorldId, id: NovelId) =>
  useQuery({
    queryKey: ["novels", spaceId, worldId, id],
    queryFn: () => getNovel(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

// ─── Novel mutations ─────────────────────────────────────────────────────────

export const useCreateNovel = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNovelInput) => createNovel(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["novels", spaceId, worldId] }),
  });
};

export const useUpdateNovel = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: NovelId; input: UpdateNovelInput }) =>
      updateNovel(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["novels", spaceId, worldId] }),
  });
};

export const useDeleteNovel = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: NovelId) => deleteNovel(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["novels", spaceId, worldId] }),
  });
};

// ─── Chapter queries ─────────────────────────────────────────────────────────

export const useChapters = (spaceId: string, worldId: WorldId, novelId: NovelId) =>
  useQuery({
    queryKey: ["chapters", spaceId, worldId, novelId],
    queryFn: () => listChapters(spaceId, worldId, novelId),
    enabled: !!spaceId && !!worldId && !!novelId,
  });

// ─── Chapter mutations ───────────────────────────────────────────────────────

export const useCreateChapter = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ novelId, input }: { novelId: NovelId; input: CreateChapterInput }) =>
      createChapter(spaceId, worldId, novelId, input),
    onSuccess: (_data, { novelId }) =>
      qc.invalidateQueries({ queryKey: ["chapters", spaceId, worldId, novelId] }),
  });
};

export const useUpdateChapter = (
  spaceId: string,
  worldId: WorldId,
  novelId: NovelId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: ChapterId; input: UpdateChapterInput }) =>
      updateChapter(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["chapters", spaceId, worldId, novelId] }),
  });
};

export const useDeleteChapter = (
  spaceId: string,
  worldId: WorldId,
  novelId: NovelId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ChapterId) => deleteChapter(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["chapters", spaceId, worldId, novelId] }),
  });
};

export const useReorderChapters = (
  spaceId: string,
  worldId: WorldId,
  novelId: NovelId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chapterIds: ChapterId[]) =>
      reorderChapters(spaceId, worldId, novelId, chapterIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["chapters", spaceId, worldId, novelId] }),
  });
};

// ─── Scene queries ───────────────────────────────────────────────────────────

export const useScenes = (spaceId: string, worldId: WorldId, chapterId: ChapterId) =>
  useQuery({
    queryKey: ["scenes", spaceId, worldId, chapterId],
    queryFn: () => listScenes(spaceId, worldId, chapterId),
    enabled: !!spaceId && !!worldId && !!chapterId,
  });

export const useScene = (spaceId: string, worldId: WorldId, id: SceneId) =>
  useQuery({
    queryKey: ["scenes", spaceId, worldId, id],
    queryFn: () => getScene(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

// ─── Scene mutations ─────────────────────────────────────────────────────────

export const useCreateScene = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chapterId, input }: { chapterId: ChapterId; input: CreateSceneInput }) =>
      createScene(spaceId, worldId, chapterId, input),
    onSuccess: (_data, { chapterId }) =>
      qc.invalidateQueries({ queryKey: ["scenes", spaceId, worldId, chapterId] }),
  });
};

export const useUpdateScene = (
  spaceId: string,
  worldId: WorldId,
  chapterId: ChapterId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: SceneId; input: UpdateSceneInput }) =>
      updateScene(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scenes", spaceId, worldId, chapterId] }),
  });
};

export const useDeleteScene = (
  spaceId: string,
  worldId: WorldId,
  chapterId: ChapterId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: SceneId) => deleteScene(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scenes", spaceId, worldId, chapterId] }),
  });
};

export const useReorderScenes = (
  spaceId: string,
  worldId: WorldId,
  chapterId: ChapterId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sceneIds: SceneId[]) =>
      reorderScenes(spaceId, worldId, chapterId, sceneIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scenes", spaceId, worldId, chapterId] }),
  });
};
