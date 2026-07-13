import { invoke } from '@tauri-apps/api/core';

/**
 * Structured error payload returned by every Rust command on rejection.
 *
 * The Rust `DbError` serializes itself into this shape (see
 * `src-tauri/src/db/error.rs`). Business errors carry a stable `code`
 * (e.g. `"WORLD_NOT_FOUND"`, `"NOT_FOUND"`) plus interpolation `args`
 * so the frontend can render a translated message via i18n. Infrastructure
 * errors collapse to `code = "INTERNAL_ERROR"` with the raw English
 * `message` as a fallback (rare, low translation value).
 */
export interface ErrorPayload {
  code: string;
  message: string;
  args: Record<string, string>;
}

/**
 * Thin typed wrapper around Tauri's `invoke()`.
 *
 * Rejected promises carry an {@link ErrorPayload} — use {@link toErrorPayload}
 * to normalize at catch sites. In rare cases (e.g. unregistered command) Tauri
 * may reject with a bare string; that helper coerces those into a synthetic
 * `INTERNAL_ERROR` payload so call sites only ever deal with one shape.
 */
export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

/**
 * Coerce an unknown rejection value into an {@link ErrorPayload}.
 *
 * Handles three shapes seen in practice:
 *  - Object with string `code` (the normal `DbError` case)
 *  - Bare string (Tauri framework-level rejections)
 *  - Anything else (defensive — stringified)
 */
export function toErrorPayload(e: unknown): ErrorPayload {
  if (typeof e === 'string') {
    return { code: 'INTERNAL_ERROR', message: e, args: {} };
  }
  if (e && typeof e === 'object' && 'code' in e) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.code === 'string') {
      const rawArgs = obj.args;
      return {
        code: obj.code,
        message: typeof obj.message === 'string' ? obj.message : '',
        args:
          rawArgs && typeof rawArgs === 'object'
            ? (rawArgs as Record<string, string>)
            : {},
      };
    }
  }
  return { code: 'INTERNAL_ERROR', message: String(e), args: {} };
}
