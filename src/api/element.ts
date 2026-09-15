/**
 * Location / Item / Lore IPC API.
 *
 * The three element types are structurally identical at v0.1.0.
 * Each provides full CRUD scoped to a Space + World via `spaceId` + `worldId`.
 */

import type {
  Item,
  ItemId,
  ItemSummary,
  Location,
  LocationId,
  LocationSummary,
  Lore,
  LoreId,
  LoreSummary,
  SummaryPage,
  WorldId,
} from '@/types';
import { call } from './client';
import type { CreateElementInput, UpdateElementInput } from './types';

// ─── Location ───────────────────────────────────────────────────────────────

export function createLocation(
  spaceId: string,
  worldId: WorldId,
  input: CreateElementInput,
): Promise<Location> {
  return call<Location>('create_location', { spaceId, worldId, input });
}

export function getLocation(spaceId: string, worldId: WorldId, id: LocationId): Promise<Location> {
  return call<Location>('get_location', { spaceId, worldId, id });
}

export function listLocations(spaceId: string, worldId: WorldId): Promise<Location[]> {
  return call<Location[]>('list_locations', { spaceId, worldId });
}

/** Lightweight location list — `id`, `name`, `tags` only. */
export function listLocationSummaries(spaceId: string, worldId: WorldId): Promise<LocationSummary[]> {
  return call<LocationSummary[]>('list_location_summaries', { spaceId, worldId });
}

/**
 * Substring search across name, description, notes, and tags.
 * Returns one PAGE of matching summaries — 50 per page (`totalCount`
 * carries the full match count; `truncated` reports further pages).
 * Deterministic name ordering makes offset pages stable — walk `offset`
 * 0, 50, 100, … while `truncated` is true.
 *
 * @param spaceId The Space owning the World.
 * @param worldId The World to search.
 * @param query   Substring to search for (case-insensitive).
 * @param offset  Pagination offset in results (0-based); omit for 0.
 */
export function searchLocations(
  spaceId: string,
  worldId: WorldId,
  query: string,
  offset?: number,
): Promise<SummaryPage<LocationSummary>> {
  return call<SummaryPage<LocationSummary>>('search_locations', { spaceId, worldId, query, offset });
}

export function updateLocation(
  spaceId: string,
  worldId: WorldId,
  id: LocationId,
  input: UpdateElementInput,
): Promise<Location> {
  return call<Location>('update_location', { spaceId, worldId, id, input });
}

export function deleteLocation(spaceId: string, worldId: WorldId, id: LocationId): Promise<void> {
  return call<void>('delete_location', { spaceId, worldId, id });
}

// ─── Item ───────────────────────────────────────────────────────────────────

export function createItem(spaceId: string, worldId: WorldId, input: CreateElementInput): Promise<Item> {
  return call<Item>('create_item', { spaceId, worldId, input });
}

export function getItem(spaceId: string, worldId: WorldId, id: ItemId): Promise<Item> {
  return call<Item>('get_item', { spaceId, worldId, id });
}

export function listItems(spaceId: string, worldId: WorldId): Promise<Item[]> {
  return call<Item[]>('list_items', { spaceId, worldId });
}

/** Lightweight item list — `id`, `name`, `tags` only. */
export function listItemSummaries(spaceId: string, worldId: WorldId): Promise<ItemSummary[]> {
  return call<ItemSummary[]>('list_item_summaries', { spaceId, worldId });
}

/**
 * Substring search across name, description, notes, and tags.
 * Returns one PAGE of matching summaries — 50 per page (`totalCount`
 * carries the full match count; `truncated` reports further pages).
 * Deterministic name ordering makes offset pages stable — walk `offset`
 * 0, 50, 100, … while `truncated` is true.
 *
 * @param spaceId The Space owning the World.
 * @param worldId The World to search.
 * @param query   Substring to search for (case-insensitive).
 * @param offset  Pagination offset in results (0-based); omit for 0.
 */
export function searchItems(
  spaceId: string,
  worldId: WorldId,
  query: string,
  offset?: number,
): Promise<SummaryPage<ItemSummary>> {
  return call<SummaryPage<ItemSummary>>('search_items', { spaceId, worldId, query, offset });
}

export function updateItem(
  spaceId: string,
  worldId: WorldId,
  id: ItemId,
  input: UpdateElementInput,
): Promise<Item> {
  return call<Item>('update_item', { spaceId, worldId, id, input });
}

export function deleteItem(spaceId: string, worldId: WorldId, id: ItemId): Promise<void> {
  return call<void>('delete_item', { spaceId, worldId, id });
}

// ─── Lore ───────────────────────────────────────────────────────────────────

export function createLore(spaceId: string, worldId: WorldId, input: CreateElementInput): Promise<Lore> {
  return call<Lore>('create_lore', { spaceId, worldId, input });
}

export function getLore(spaceId: string, worldId: WorldId, id: LoreId): Promise<Lore> {
  return call<Lore>('get_lore', { spaceId, worldId, id });
}

export function listLores(spaceId: string, worldId: WorldId): Promise<Lore[]> {
  return call<Lore[]>('list_lores', { spaceId, worldId });
}

/** Lightweight lore list — `id`, `name`, `tags` only. */
export function listLoreSummaries(spaceId: string, worldId: WorldId): Promise<LoreSummary[]> {
  return call<LoreSummary[]>('list_lore_summaries', { spaceId, worldId });
}

/**
 * Substring search across name, description, notes, and tags.
 * Returns one PAGE of matching summaries — 50 per page (`totalCount`
 * carries the full match count; `truncated` reports further pages).
 * Deterministic name ordering makes offset pages stable — walk `offset`
 * 0, 50, 100, … while `truncated` is true.
 *
 * @param spaceId The Space owning the World.
 * @param worldId The World to search.
 * @param query   Substring to search for (case-insensitive).
 * @param offset  Pagination offset in results (0-based); omit for 0.
 */
export function searchLores(
  spaceId: string,
  worldId: WorldId,
  query: string,
  offset?: number,
): Promise<SummaryPage<LoreSummary>> {
  return call<SummaryPage<LoreSummary>>('search_lores', { spaceId, worldId, query, offset });
}

export function updateLore(
  spaceId: string,
  worldId: WorldId,
  id: LoreId,
  input: UpdateElementInput,
): Promise<Lore> {
  return call<Lore>('update_lore', { spaceId, worldId, id, input });
}

export function deleteLore(spaceId: string, worldId: WorldId, id: LoreId): Promise<void> {
  return call<void>('delete_lore', { spaceId, worldId, id });
}
