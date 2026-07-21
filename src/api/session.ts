/**
 * Session IPC API — multi-window model (ADR-0011).
 *
 * Session state (`lastOpenedSpaceId` + `lockedSpaceIds`) persists in
 * `meta.db` across restarts and is mirrored on the frontend as a React
 * Query cache keyed `['session']`. Mutating commands that change session
 * state return the fresh {@link SessionState} so callers can update the
 * cache in a single hop.
 *
 * Window lifecycle (`openSpaceWindow`) is separate: it creates or focuses
 * an OS window for a Space, but does NOT change session state.
 */

import type { SessionState } from '@/types';
import { call } from './client';

// ─── Session state ───────────────────────────────────────────────────────────

/**
 * Open (or re-open) a Space: sets `lastOpenedSpaceId`, opens the DB
 * connection (with password handling per ADR-0008).
 *
 * If the Space is protected and currently locked, `password` is verified
 * server-side via argon2id — a wrong password rejects with the
 * `INVALID_PASSWORD` business error. For unprotected or already-open
 * Spaces, `password` is ignored.
 *
 * This does NOT create a window — call {@link openSpaceWindow} afterwards.
 */
export function openSpace(id: string, password?: string): Promise<SessionState> {
  return call<SessionState>('open_space', { id, password });
}

/**
 * Lock a single protected Space. Content becomes obscured by the
 * password-gate overlay; `openSpace(id, password)` unlocks.
 */
export function lockSpace(id: string): Promise<SessionState> {
  return call<SessionState>('lock_space', { id });
}

/**
 * Lock every protected Space at once. Invoked on hide-to-tray; the backend
 * also emits a `spaces-locked` Tauri event so all Space windows invalidate
 * their session cache and show the password-gate overlay.
 */
export function lockAllProtectedSpaces(): Promise<SessionState> {
  return call<SessionState>('lock_all_protected_spaces');
}

export function getSession(): Promise<SessionState> {
  return call<SessionState>('get_session');
}

// ─── Window lifecycle ────────────────────────────────────────────────────────

/**
 * Create or focus the OS window for a Space (ADR-0011).
 *
 * If a window with label `space-{spaceId}` already exists, brings it to
 * the front. Otherwise creates a new native window at URL
 * `/space/{spaceId}` with the Space name as its title.
 *
 * This is a fire-and-forget command — it does NOT return session state.
 * Call {@link openSpace} first if you need to update the session/DB layer.
 */
export function openSpaceWindow(spaceId: string): Promise<void> {
  return call<void>('open_space_window', { spaceId });
}
