/**
 * Tauri `invoke()` wrapper that forwards log entries to the Rust
 * `frontend_log` command (ADR-0014). The Rust side re-emits each entry
 * into the shared `tracing` subscriber, so frontend and backend events
 * interleave in the unified log file (ADR-0015).
 *
 * IPC readiness is detected lazily: the first successful {@link send}
 * flips the internal flag. Before that, the bootstrap buffer
 * (see `./buffer.ts`) holds entries that arrive during very early
 * webview init, when `invoke()` would reject because the IPC channel
 * isn't wired up yet.
 */

import { invoke } from '@tauri-apps/api/core';

import type { LogEntry } from './index';

let ready = false;

/**
 * True once the first {@link send} has succeeded.
 *
 * Deliberately NOT detected via `window.isTauri` or similar feature flags:
 * the only reliable signal that `invoke()` will actually work is "did the
 * last call work". Once true, the flag is never reset — a transient
 * failure on a ready channel is handled by the per-call `.catch()` in
 * `index.ts`, which re-buffers the entry.
 */
export function isReady(): boolean {
  return ready;
}

/**
 * Forward a single entry to the Rust `frontend_log` command.
 *
 * The top-level IPC argument names are camelCase (`windowLabel`,
 * `timestamp`); Tauri auto-converts these to the Rust handler's
 * snake_case parameter names via serde. The `fields` object's KEYS must
 * already be snake_case per ADR-0016 — the bridge does NOT rename them,
 * because recursive key-conversion is bug-prone and would turn the
 * bridge into a silent renaming layer.
 *
 * On success: flips the internal ready flag (idempotent).
 * On rejection: throws so the caller (`index.ts` or `buffer.ts`) can
 * re-buffer the entry.
 */
export async function send(entry: LogEntry): Promise<void> {
  await invoke('frontend_log', {
    level: entry.level,
    message: entry.message,
    fields: entry.fields,
    windowLabel: entry.window_label,
    timestamp: entry.timestamp,
  });
  ready = true;
}
