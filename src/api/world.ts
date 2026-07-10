/**
 * World + AppConfig IPC API.
 *
 * Worlds live in `meta.db` — no `worldId` scoping needed.
 */

import type { AppConfig, World } from '@/types';
import { call } from './client';
import type { CreateWorldInput, UpdateWorldInput } from './types';

// ─── World ──────────────────────────────────────────────────────────────────

export function createWorld(input: CreateWorldInput): Promise<World> {
  return call<World>('create_world', { input });
}

export function listWorlds(): Promise<World[]> {
  return call<World[]>('list_worlds');
}

export function getWorld(id: string): Promise<World> {
  return call<World>('get_world', { id });
}

export function updateWorld(id: string, input: UpdateWorldInput): Promise<World> {
  return call<World>('update_world', { id, input });
}

export function deleteWorld(id: string): Promise<void> {
  return call<void>('delete_world', { id });
}

// ─── App Config ─────────────────────────────────────────────────────────────

export function getAppConfig(): Promise<AppConfig> {
  return call<AppConfig>('get_app_config');
}

export function updateAppConfig(config: AppConfig): Promise<AppConfig> {
  return call<AppConfig>('update_app_config', { config });
}
