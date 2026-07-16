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

export const useNovels = (worldId: WorldId) =>
  useQuery({
    queryKey: ["novels", worldId],
    queryFn: () => listNovels(worldId),
    enabled: !!worldId,
  });

export const useNovel = (worldId: WorldId, id: NovelId) =>
  useQuery({
    queryKey: ["novels", worldId, id],
    queryFn: () => getNovel(worldId, id),
    enabled: !!worldId && !!id,
  });

// ─── Novel mutations ─────────────────────────────────────────────────────────

export const useCreateNovel = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNovelInput) => createNovel(worldId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["novels", worldId] }),
  });
};

export const useUpdateNovel = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: NovelId; input: UpdateNovelInput }) =>
      updateNovel(worldId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["novels", worldId] }),
  });
};

export const useDeleteNovel = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: NovelId) => deleteNovel(worldId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["novels", worldId] }),
  });
};

// ─── Chapter queries ─────────────────────────────────────────────────────────

export const useChapters = (worldId: WorldId, novelId: NovelId) =>
  useQuery({
    queryKey: ["chapters", worldId, novelId],
    queryFn: () => listChapters(worldId, novelId),
    enabled: !!worldId && !!novelId,
  });

// ─── Chapter mutations ───────────────────────────────────────────────────────

export const useCreateChapter = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ novelId, input }: { novelId: NovelId; input: CreateChapterInput }) =>
      createChapter(worldId, novelId, input),
    onSuccess: (_data, { novelId }) =>
      qc.invalidateQueries({ queryKey: ["chapters", worldId, novelId] }),
  });
};

export const useUpdateChapter = (worldId: WorldId, novelId: NovelId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: ChapterId; input: UpdateChapterInput }) =>
      updateChapter(worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["chapters", worldId, novelId] }),
  });
};

export const useDeleteChapter = (worldId: WorldId, novelId: NovelId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ChapterId) => deleteChapter(worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["chapters", worldId, novelId] }),
  });
};

export const useReorderChapters = (worldId: WorldId, novelId: NovelId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chapterIds: ChapterId[]) =>
      reorderChapters(worldId, novelId, chapterIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["chapters", worldId, novelId] }),
  });
};

// ─── Scene queries ───────────────────────────────────────────────────────────

export const useScenes = (worldId: WorldId, chapterId: ChapterId) =>
  useQuery({
    queryKey: ["scenes", worldId, chapterId],
    queryFn: () => listScenes(worldId, chapterId),
    enabled: !!worldId && !!chapterId,
  });

export const useScene = (worldId: WorldId, id: SceneId) =>
  useQuery({
    queryKey: ["scenes", worldId, id],
    queryFn: () => getScene(worldId, id),
    enabled: !!worldId && !!id,
  });

// ─── Scene mutations ─────────────────────────────────────────────────────────

export const useCreateScene = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chapterId, input }: { chapterId: ChapterId; input: CreateSceneInput }) =>
      createScene(worldId, chapterId, input),
    onSuccess: (_data, { chapterId }) =>
      qc.invalidateQueries({ queryKey: ["scenes", worldId, chapterId] }),
  });
};

export const useUpdateScene = (worldId: WorldId, chapterId: ChapterId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: SceneId; input: UpdateSceneInput }) =>
      updateScene(worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scenes", worldId, chapterId] }),
  });
};

export const useDeleteScene = (worldId: WorldId, chapterId: ChapterId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: SceneId) => deleteScene(worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scenes", worldId, chapterId] }),
  });
};

export const useReorderScenes = (worldId: WorldId, chapterId: ChapterId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sceneIds: SceneId[]) =>
      reorderScenes(worldId, chapterId, sceneIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scenes", worldId, chapterId] }),
  });
};
