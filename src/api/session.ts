/**
 * Session IPC API.
 *
 * Session state (open tabs, active tab, locked tabs) persists in `meta.db`
 * across restarts and is mirrored on the frontend as a React Query cache
 * keyed `['session']`. Every mutating command returns the fresh
 * {@link SessionState} so callers can update the cache in a single hop.
 */

import type { SessionState } from '@/types';
import { call } from './client';

// ─── Tab lifecycle ──────────────────────────────────────────────────────────

/**
 * Open (or re-open) a Space tab.
 *
 * If the Space is protected and currently locked, `password` is verified
 * server-side via argon2id — a wrong password rejects with the
 * `INVALID_PASSWORD` business error. For unprotected or already-open
 * Spaces, `password` is ignored.
 */
export function openSpace(id: string, password?: string): Promise<SessionState> {
  return call<SessionState>('open_space', { id, password });
}

/**
 * Close a Space tab. Drops the cached `space.db` connection AND every
 * cached World connection for that Space (see `DbManager::close_space`).
 */
export function closeSpace(id: string): Promise<SessionState> {
  return call<SessionState>('close_space', { id });
}

/**
 * Lock a single protected Space tab without closing it. Content becomes
 * obscured by the password-gate overlay; `openSpace(id, password)` unlocks.
 */
export function lockSpace(id: string): Promise<SessionState> {
  return call<SessionState>('lock_space', { id });
}

/**
 * Lock every open protected Space at once. Invoked on hide-to-tray; the
 * backend also emits a `spaces-locked` Tauri event so other windows
 * invalidate their session cache.
 */
export function lockAllProtectedSpaces(): Promise<SessionState> {
  return call<SessionState>('lock_all_protected_spaces');
}

// ─── Query + focus ──────────────────────────────────────────────────────────

export function getSession(): Promise<SessionState> {
  return call<SessionState>('get_session');
}

/**
 * Switch the active (focused) tab. `id` must already be in `openSpaceIds`;
 * the backend rejects otherwise. Passing the current active id is a no-op.
 */
export function setActiveSpace(id: string): Promise<SessionState> {
  return call<SessionState>('set_active_space', { id });
}
