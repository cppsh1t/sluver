/**
 * TimeMapper public façade — types + entry functions.
 *
 * This module owns the public surface (`formatTime`, `TimeMapperError`,
 * `FormatResult`) and delegates all behavior to the singleton client in
 * `./client`. The client imports `TimeMapperError` back from here; that cycle
 * is safe because the client only constructs `TimeMapperError` at call time,
 * never during its own module evaluation.
 */

import type { SpaceId, WorldId } from "@/types";
import { timeMapperClient } from "./client";

export type TimeMapperErrorKind = "syntax" | "runtime" | "timeout";

/**
 * Error raised when a mapper fails to compile or a single timestamp fails to
 * render. `kind` lets callers (UI, agent tool) decide how to surface it.
 * The original ISO string is always still available as the fallback `display`
 * value in {@link FormatResult}, so a `TimeMapperError` is never fatal.
 */
export class TimeMapperError extends Error {
  readonly kind: TimeMapperErrorKind;

  constructor(kind: TimeMapperErrorKind, detail: string) {
    super(`Time mapper failed (${kind}): ${detail}`);
    this.name = "TimeMapperError";
    this.kind = kind;
  }
}

/**
 * Outcome of rendering one ISO string.
 *
 * - `ok: true`  → mapper (or passthrough) produced a display string.
 * - `ok: false` → something failed; `display` is the raw ISO fallback and
 *   `error` carries the structured failure for logging / agent feedback.
 */
export type FormatResult =
  | { ok: true; display: string }
  | { ok: false; display: string; error: TimeMapperError };

/**
 * Bind the singleton to a World. Called on World entry; resets all cached
 * state (mapper code, compiled module, per-ISO results) and recreates the
 * worker lazily on next use.
 */
export function initTimeMapperClient(spaceId: SpaceId, worldId: WorldId): void {
  timeMapperClient.init(spaceId, worldId);
}

/**
 * Force a re-fetch of mapper code on the next `formatTime` call. Call after
 * the user saves new mapper source (or deletes it) so stale output is purged.
 */
export function reloadTimeMapper(): void {
  timeMapperClient.reloadMapper();
}

/**
 * Render an ISO 8601 timestamp into the current World's time representation.
 * Never throws — failures surface as `{ ok: false, … }` with the raw ISO as
 * the fallback display value.
 */
export async function formatTime(iso: string): Promise<FormatResult> {
  return timeMapperClient.format(iso);
}
