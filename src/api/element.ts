/**
 * Location / Item / Lore IPC API.
 *
 * The three element types are structurally identical at v0.1.0.
 * Each provides full CRUD scoped to a world DB via `worldId`.
 */

import type {
  Item,
  ItemId,
  Location,
  LocationId,
  Lore,
  LoreId,
  WorldId,
} from '@/types';
import { call } from './client';
import type { CreateElementInput, UpdateElementInput } from './types';

// ─── Location ───────────────────────────────────────────────────────────────

export function createLocation(
  worldId: WorldId,
  input: CreateElementInput,
): Promise<Location> {
  return call<Location>('create_location', { worldId, input });
}

export function getLocation(worldId: WorldId, id: LocationId): Promise<Location> {
  return call<Location>('get_location', { worldId, id });
}

export function listLocations(worldId: WorldId): Promise<Location[]> {
  return call<Location[]>('list_locations', { worldId });
}

export function updateLocation(
  worldId: WorldId,
  id: LocationId,
  input: UpdateElementInput,
): Promise<Location> {
  return call<Location>('update_location', { worldId, id, input });
}

export function deleteLocation(worldId: WorldId, id: LocationId): Promise<void> {
  return call<void>('delete_location', { worldId, id });
}

// ─── Item ───────────────────────────────────────────────────────────────────

export function createItem(worldId: WorldId, input: CreateElementInput): Promise<Item> {
  return call<Item>('create_item', { worldId, input });
}

export function getItem(worldId: WorldId, id: ItemId): Promise<Item> {
  return call<Item>('get_item', { worldId, id });
}

export function listItems(worldId: WorldId): Promise<Item[]> {
  return call<Item[]>('list_items', { worldId });
}

export function updateItem(
  worldId: WorldId,
  id: ItemId,
  input: UpdateElementInput,
): Promise<Item> {
  return call<Item>('update_item', { worldId, id, input });
}

export function deleteItem(worldId: WorldId, id: ItemId): Promise<void> {
  return call<void>('delete_item', { worldId, id });
}

// ─── Lore ───────────────────────────────────────────────────────────────────

export function createLore(worldId: WorldId, input: CreateElementInput): Promise<Lore> {
  return call<Lore>('create_lore', { worldId, input });
}

export function getLore(worldId: WorldId, id: LoreId): Promise<Lore> {
  return call<Lore>('get_lore', { worldId, id });
}

export function listLores(worldId: WorldId): Promise<Lore[]> {
  return call<Lore[]>('list_lores', { worldId });
}

export function updateLore(
  worldId: WorldId,
  id: LoreId,
  input: UpdateElementInput,
): Promise<Lore> {
  return call<Lore>('update_lore', { worldId, id, input });
}

export function deleteLore(worldId: WorldId, id: LoreId): Promise<void> {
  return call<void>('delete_lore', { worldId, id });
}
