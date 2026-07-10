import { invoke } from '@tauri-apps/api/core';

/**
 * Thin typed wrapper around Tauri's `invoke()`.
 *
 * Centralizes the call site so that future cross-cutting concerns
 * (logging, error normalisation, retry) can be added in one place.
 *
 * The Rust `DbError` serializes to a plain string, so rejected
 * promises carry `string` as their rejection reason.
 */
export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}
