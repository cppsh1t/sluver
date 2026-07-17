/**
 * Space IPC API.
 *
 * Spaces are the outer isolation tier above Worlds (see ADR-0008). They live
 * in `meta.db` and may optionally be protected by an argon2id password. This
 * surface never touches `password_hash` directly — `hasPassword` is the only
 * password-related bit exposed to the frontend, and password lifecycle goes
 * through {@link setSpacePassword}.
 */

import type {
  CreateSpaceInput,
  SetSpacePasswordInput,
  SpaceSummary,
  UpdateSpaceInput,
} from '@/types';
import { call } from './client';

// ─── Space CRUD ─────────────────────────────────────────────────────────────

export function createSpace(input: CreateSpaceInput): Promise<SpaceSummary> {
  return call<SpaceSummary>('create_space', { input });
}

export function listSpaces(): Promise<SpaceSummary[]> {
  return call<SpaceSummary[]>('list_spaces');
}

export function getSpace(id: string): Promise<SpaceSummary> {
  return call<SpaceSummary>('get_space', { id });
}

export function updateSpace(id: string, input: UpdateSpaceInput): Promise<SpaceSummary> {
  return call<SpaceSummary>('update_space', { id, input });
}

/**
 * Permanently delete a Space and all of its World databases.
 *
 * `password` is required when the Space is protected (verified server-side
 * via argon2id); omitted for unprotected Spaces.
 */
export function deleteSpace(id: string, password?: string): Promise<void> {
  return call<void>('delete_space', { id, password });
}

// ─── Password lifecycle ─────────────────────────────────────────────────────

/**
 * Add / change / remove a Space password in a single command.
 *
 * - add:    `currentPassword = undefined`, `newPassword = <some>`
 * - change: `currentPassword = <old>`,     `newPassword = <some>`
 * - remove: `currentPassword = <old>`,     `newPassword = undefined`
 */
export function setSpacePassword(id: string, input: SetSpacePasswordInput): Promise<void> {
  return call<void>('set_space_password', { id, input });
}
