/**
 * Image IPC API — single-cover / portrait / illustration pipeline.
 *
 * 24 thin wrappers (3 ops × 8 entities) over the Rust `*_image` commands.
 * Image bytes are NOT part of the entity schema — they live in dedicated
 * sidecar columns and are read/written exclusively through this module.
 *
 * ## Wire format
 *
 * Writes (`update<Entity>Image`) take a `Uint8Array` + MIME, base64-encode the
 * bytes client-side, and send `{ imageBase64, imageMime }` over IPC. The
 * backend re-decodes and stores them as binary BLOBs (transport via base64
 * is required because Tauri's default JSON IPC cannot carry raw bytes).
 *
 * Reads (`get<Entity>Image`) return an `ArrayBuffer` directly — the backend
 * uses `tauri::ipc::Response` to bypass JSON serialization on the happy path.
 * When the entity has no image set the backend returns `NotFound`, which we
 * translate to `null` here so call sites can use a simple truthy check:
 *
 * ```ts
 * const bytes = await getCharacterImage(spaceId, worldId, characterId);
 * if (bytes) {
 *   const url = arrayBufferToBlobUrl(bytes, "image/webp");
 *   // <img src={url} />
 * }
 * ```
 *
 * ## Argument conventions
 *
 * - `spaceId: string` — unbranded, matches the rest of the API layer.
 * - `worldId: WorldId` — branded to prevent cross-entity ID mix-ups.
 * - For non-World entities, the entity's own ID is branded (`CharacterId`,
 *   `PhaseId`, `LocationId`, …) and passed as the `id` arg, except Phase
 *   which mirrors the existing `addPhase` / `updatePhase` convention and
 *   uses the `phaseId` arg key.
 * - For World, the entity id is passed under the `id` arg key (matching the
 *   existing `updateWorld` / `getWorld` convention) — World IS the entity,
 *   addressed by its own id.
 *
 * All arg keys are camelCase; `#[serde(rename_all = "camelCase")]` on the
 * Rust side auto-converts to the snake_case form the commands receive.
 */

import { call, toErrorPayload } from './client';
import { base64Encode } from '@/lib/image-bytes';
import type {
  CharacterId,
  EventId,
  ItemId,
  LocationId,
  LoreId,
  NovelId,
  PhaseId,
  WorldId,
} from '@/types';

// ─── World ───────────────────────────────────────────────────────────────────
// World lives in `space.db` (ADR-0001). Per the existing `updateWorld` /
// `getWorld` convention, the World's own id is passed under the `id` arg key
// (NOT `worldId`) — World IS the entity, addressed by its own id.

/**
 * Set / replace the World's cover image.
 *
 * @param spaceId  Space registry ID (selects `spaces/{spaceId}/space.db`).
 * @param id       The World's own ID.
 * @param bytes    Raw image bytes; will be base64-encoded for transport.
 * @param mime     One of {@link import("@/lib/image-bytes").imageMimeAllowList}.
 */
export function updateWorldImage(
  spaceId: string,
  id: WorldId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_world_image', {
    spaceId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/**
 * Remove the World's cover image. Idempotent — clearing an already-empty
 * slot is a no-op on the Rust side.
 */
export function clearWorldImage(spaceId: string, id: WorldId): Promise<void> {
  return call<void>('clear_world_image', { spaceId, id });
}

/**
 * Fetch the World's cover image as raw bytes.
 *
 * @returns `ArrayBuffer` when an image is set, `null` when the backend
 *          returns `NOT_FOUND` (no image for this World). All other errors
 *          propagate.
 */
export async function getWorldImage(spaceId: string, id: WorldId): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_world_image', { spaceId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Character ───────────────────────────────────────────────────────────────

/** Set / replace a Character's portrait. See {@link updateWorldImage} for arg semantics. */
export function updateCharacterImage(
  spaceId: string,
  worldId: WorldId,
  id: CharacterId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_character_image', {
    spaceId,
    worldId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove a Character's portrait. */
export function clearCharacterImage(
  spaceId: string,
  worldId: WorldId,
  id: CharacterId,
): Promise<void> {
  return call<void>('clear_character_image', { spaceId, worldId, id });
}

/**
 * Fetch a Character's portrait.
 * @returns `ArrayBuffer` if set, `null` if no image (`NOT_FOUND`). */
export async function getCharacterImage(
  spaceId: string,
  worldId: WorldId,
  id: CharacterId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_character_image', { spaceId, worldId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Phase ───────────────────────────────────────────────────────────────────
// Arg key is `phaseId` (not `id`) — matches `addPhase` / `updatePhase`.

/** Set / replace a CharacterPhase's portrait. */
export function updatePhaseImage(
  spaceId: string,
  worldId: WorldId,
  phaseId: PhaseId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_phase_image', {
    spaceId,
    worldId,
    phaseId,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove a CharacterPhase's portrait. */
export function clearPhaseImage(
  spaceId: string,
  worldId: WorldId,
  phaseId: PhaseId,
): Promise<void> {
  return call<void>('clear_phase_image', { spaceId, worldId, phaseId });
}

/** Fetch a CharacterPhase's portrait. @returns `ArrayBuffer` or `null` if unset. */
export async function getPhaseImage(
  spaceId: string,
  worldId: WorldId,
  phaseId: PhaseId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_phase_image', { spaceId, worldId, phaseId });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Location ────────────────────────────────────────────────────────────────

/** Set / replace a Location's image. */
export function updateLocationImage(
  spaceId: string,
  worldId: WorldId,
  id: LocationId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_location_image', {
    spaceId,
    worldId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove a Location's image. */
export function clearLocationImage(
  spaceId: string,
  worldId: WorldId,
  id: LocationId,
): Promise<void> {
  return call<void>('clear_location_image', { spaceId, worldId, id });
}

/** Fetch a Location's image. @returns `ArrayBuffer` or `null` if unset. */
export async function getLocationImage(
  spaceId: string,
  worldId: WorldId,
  id: LocationId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_location_image', { spaceId, worldId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Item ────────────────────────────────────────────────────────────────────

/** Set / replace an Item's image. */
export function updateItemImage(
  spaceId: string,
  worldId: WorldId,
  id: ItemId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_item_image', {
    spaceId,
    worldId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove an Item's image. */
export function clearItemImage(spaceId: string, worldId: WorldId, id: ItemId): Promise<void> {
  return call<void>('clear_item_image', { spaceId, worldId, id });
}

/** Fetch an Item's image. @returns `ArrayBuffer` or `null` if unset. */
export async function getItemImage(
  spaceId: string,
  worldId: WorldId,
  id: ItemId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_item_image', { spaceId, worldId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Lore ────────────────────────────────────────────────────────────────────

/** Set / replace a Lore entry's image. */
export function updateLoreImage(
  spaceId: string,
  worldId: WorldId,
  id: LoreId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_lore_image', {
    spaceId,
    worldId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove a Lore entry's image. */
export function clearLoreImage(spaceId: string, worldId: WorldId, id: LoreId): Promise<void> {
  return call<void>('clear_lore_image', { spaceId, worldId, id });
}

/** Fetch a Lore entry's image. @returns `ArrayBuffer` or `null` if unset. */
export async function getLoreImage(
  spaceId: string,
  worldId: WorldId,
  id: LoreId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_lore_image', { spaceId, worldId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Event ───────────────────────────────────────────────────────────────────

/** Set / replace an Event's image. */
export function updateEventImage(
  spaceId: string,
  worldId: WorldId,
  id: EventId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_event_image', {
    spaceId,
    worldId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove an Event's image. */
export function clearEventImage(spaceId: string, worldId: WorldId, id: EventId): Promise<void> {
  return call<void>('clear_event_image', { spaceId, worldId, id });
}

/** Fetch an Event's image. @returns `ArrayBuffer` or `null` if unset. */
export async function getEventImage(
  spaceId: string,
  worldId: WorldId,
  id: EventId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_event_image', { spaceId, worldId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

// ─── Novel ───────────────────────────────────────────────────────────────────

/** Set / replace a Novel's cover image. */
export function updateNovelImage(
  spaceId: string,
  worldId: WorldId,
  id: NovelId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  return call<void>('update_novel_image', {
    spaceId,
    worldId,
    id,
    imageBase64: base64Encode(bytes),
    imageMime: mime,
  });
}

/** Remove a Novel's cover image. */
export function clearNovelImage(spaceId: string, worldId: WorldId, id: NovelId): Promise<void> {
  return call<void>('clear_novel_image', { spaceId, worldId, id });
}

/** Fetch a Novel's cover image. @returns `ArrayBuffer` or `null` if unset. */
export async function getNovelImage(
  spaceId: string,
  worldId: WorldId,
  id: NovelId,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>('get_novel_image', { spaceId, worldId, id });
  } catch (e) {
    if (toErrorPayload(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}
