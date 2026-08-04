/**
 * Scene image IPC API — 1:N gallery pipeline for {@link Scene}.
 *
 * Unlike the single-cover pipeline in `./image.ts` (one image slot per
 * entity), a Scene owns an ordered list of images. They are stored in a
 * dedicated `scene_images` sidecar table and addressed by their own
 * {@link SceneImageId}; they are NOT part of {@link Scene} and are never
 * touched by `update_scene` / the autosave flow.
 *
 * ## Wire format
 *
 * Writes (`addSceneImage`) take a `Uint8Array` + MIME, base64-encode the
 * bytes client-side, and send `{ imageBase64, imageMime }` over IPC — same
 * convention as `./image.ts`. The backend re-decodes and stores them as
 * binary BLOBs (base64 transport is required because Tauri's default JSON
 * IPC cannot carry raw bytes).
 *
 * Reads (`getSceneImage`) return an `ArrayBuffer` directly via
 * `tauri::ipc::Response`. When the image has been deleted the backend
 * returns `NOT_FOUND`, which we translate to `null` here (mirrors
 * `getNovelImage`).
 *
 * All arg keys are camelCase; `#[serde(rename_all = "camelCase")]` on the
 * Rust side auto-converts to the snake_case command receives.
 */

import { call, toErrorPayload } from './client';
import { base64Encode } from '@/lib/image-bytes';
import type { SceneId, SceneImageId, SceneImageMeta, WorldId } from '@/types';

/**
 * Append a new image to the scene's gallery.
 *
 * The backend assigns the next `position` (tail of the current list) and
 * returns the freshly inserted {@link SceneImageMeta}.
 *
 * @param spaceId  Space registry ID (selects `spaces/{spaceId}/space.db`).
 * @param worldId  World that owns the scene.
 * @param sceneId  Scene the image attaches to.
 * @param bytes    Raw image bytes; will be base64-encoded for transport.
 * @param mime     One of {@link import("@/lib/image-bytes").imageMimeAllowList}.
 */
export function addSceneImage(
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
  bytes: Uint8Array,
  mime: string,
): Promise<SceneImageMeta> {
  return call<SceneImageMeta>('add_scene_image', {
    spaceId,
    worldId,
    sceneId,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/**
 * Delete a single scene image by its id. Cascading / re-positioning of the
 * remaining images is handled by the backend.
 */
export function deleteSceneImage(
  spaceId: string,
  worldId: WorldId,
  imageId: SceneImageId,
): Promise<void> {
  return call<void>('delete_scene_image', { spaceId, worldId, imageId });
}

/**
 * Reorder the scene's images by supplying the full desired id sequence.
 * The backend sets `position = index` for each id. Must contain every
 * current image id exactly once.
 */
export function reorderSceneImages(
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
  imageIds: SceneImageId[],
): Promise<void> {
  return call<void>('reorder_scene_images', {
    spaceId,
    worldId,
    sceneId,
    imageIds,
  });
}

/**
 * Fetch a single scene image's raw bytes.
 *
 * @returns `ArrayBuffer` when the image exists, `null` when the backend
 *          returns `NOT_FOUND` (image was deleted). All other errors
 *          propagate.
 */
export async function getSceneImage(
  spaceId: string,
  worldId: WorldId,
  imageId: SceneImageId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_scene_image', { spaceId, worldId, imageId });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

/**
 * List the scene's image metadata in display order (sorted by `position`).
 *
 * Returns an empty array when the scene has no images. Use {@link getSceneImage}
 * to resolve each entry's bytes.
 */
export function listSceneImageIds(
  spaceId: string,
  worldId: WorldId,
  sceneId: SceneId,
): Promise<SceneImageMeta[]> {
  return call<SceneImageMeta[]>('list_scene_image_ids', {
    spaceId,
    worldId,
    sceneId,
  });
}
