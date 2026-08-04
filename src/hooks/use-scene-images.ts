import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addSceneImage,
  deleteSceneImage,
  getSceneImage,
  listSceneImageIds,
  reorderSceneImages,
} from "@/api";
import type { SceneId, SceneImageId, WorldId } from "@/types";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * List a scene's image metadata in display order. Keyed by the full
 * (spaceId, worldId, sceneId) tuple to match the `useScenes` convention.
 */
export const useSceneImages = (
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
) =>
  useQuery({
    queryKey: ["scene-images", spaceId, worldId, sceneId],
    queryFn: () => listSceneImageIds(spaceId, worldId, sceneId),
    enabled: !!spaceId && !!worldId && !!sceneId,
  });

/**
 * Fetch the raw bytes for a single scene image. Enabled only when `imageId`
 * is truthy. Returns `ArrayBuffer | null | undefined` (null = deleted,
 * undefined = not yet fetched).
 */
export const useSceneImageBytes = (
  spaceId: string,
  worldId: WorldId,
  imageId: SceneImageId | undefined,
) =>
  useQuery({
    queryKey: ["scene-image-bytes", spaceId, worldId, imageId],
    queryFn: () => getSceneImage(spaceId, worldId, imageId as SceneImageId),
    enabled: !!spaceId && !!worldId && !!imageId,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useAddSceneImage = (
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bytes, mime }: { bytes: Uint8Array; mime: string }) =>
      addSceneImage(spaceId, worldId, sceneId, bytes, mime),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scene-images", spaceId, worldId, sceneId] }),
  });
};

export const useDeleteSceneImage = (
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (imageId: SceneImageId) =>
      deleteSceneImage(spaceId, worldId, imageId),
    onSuccess: (_data, imageId) => {
      qc.invalidateQueries({ queryKey: ["scene-images", spaceId, worldId, sceneId] });
      // Evict the deleted image's bytes so the underlying ArrayBuffer is GC'd.
      qc.removeQueries({ queryKey: ["scene-image-bytes", spaceId, worldId, imageId] });
    },
  });
};

export const useReorderSceneImages = (
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (imageIds: SceneImageId[]) =>
      reorderSceneImages(spaceId, worldId, sceneId, imageIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["scene-images", spaceId, worldId, sceneId] }),
  });
};
