/**
 * World IPC API.
 *
 * Worlds live in a Space-scoped registry (`spaces/{spaceId}/space.db`), so
 * every command takes `spaceId` first (ADR-0008 / ADR-0009). They are NOT
 * scoped to a per-World DB — no `worldId` parameter here.
 */

import type { World } from '@/types';
import { call } from './client';
import type { CreateWorldInput, UpdateWorldInput } from './types';

// ─── World ──────────────────────────────────────────────────────────────────

export function createWorld(spaceId: string, input: CreateWorldInput): Promise<World> {
  return call<World>('create_world', { spaceId, input });
}

export function listWorlds(spaceId: string): Promise<World[]> {
  return call<World[]>('list_worlds', { spaceId });
}

export function getWorld(spaceId: string, id: string): Promise<World> {
  return call<World>('get_world', { spaceId, id });
}

export function updateWorld(spaceId: string, id: string, input: UpdateWorldInput): Promise<World> {
  return call<World>('update_world', { spaceId, id, input });
}

export function deleteWorld(spaceId: string, id: string): Promise<void> {
  return call<void>('delete_world', { spaceId, id });
}

// ─── Tray ───────────────────────────────────────────────────────────────────

/**
 * Push the resolved UI locale to the backend so the system tray menu labels
 * follow the active language. Pass a resolved BCP-47 tag (`"zh-CN"` / `"en"`),
 * NOT the `"auto"` sentinel — OS detection is resolved on the frontend side.
 */
export function setTrayLocale(locale: string): Promise<void> {
  return call<void>('set_tray_locale', { locale });
}
