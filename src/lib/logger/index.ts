/**
 * Frontend logger — TS counterpart to the Rust `tracing` stack (ADR-0014).
 *
 * Five methods (trace/debug/info/warn/error) all share the same pipeline:
 *
 *     threshold check (level.ts)
 *       → build LogEntry (+ window_label auto-injected)
 *       → bridge.isReady() ? bridge.send() : buffer.push()
 *       → invoke("frontend_log", …) on the Rust side
 *
 * Field names inside the `fields` argument MUST be snake_case per
 * ADR-0016 — the bridge does NOT rename them. This is the only module
 * in the codebase where snake_case is used at TS callsites; it keeps
 * the unified log file (ADR-0015) greppable with a single pattern per
 * field across both Rust and TS origins.
 *
 * This module is wired into actual call sites in a LATER task. For now
 * it just needs to be correct and importable.
 */

import { type LogLevel, getLevel, onLevelChange, precedence, setLevel } from './level';
import { getWindowLabel } from './window-label';
import * as bridge from './bridge';
import * as buffer from './buffer';

// Re-export the public level API so consumers only need `import … from "@/lib/logger"`.
export type { LogLevel };
export { getLevel, setLevel, onLevelChange };

/**
 * A single log event, in the exact shape the Rust `frontend_log` command
 * expects (after camelCase→snake_case conversion of the top-level IPC
 * args). The `fields` payload is forwarded verbatim — its keys must
 * already be snake_case (ADR-0016).
 */
export type LogEntry = {
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
  /** Snake_case here is intentional: matches the IPC arg name Rust expects. */
  window_label: string;
  /** Epoch milliseconds. Rust re-stamps with its own monotonic clock for span correlation, but this is the user-visible time. */
  timestamp: number;
};

/**
 * Core dispatcher shared by every public method.
 *
 * 1. Threshold check — drop silently if the message level is below the
 *    current threshold (precedence comparison, see level.ts).
 * 2. Build the entry with a fresh `fields` object (so callers cannot
 *    mutate the buffer's copy post-push) and the cached window label.
 * 3. If the bridge has already succeeded once, fire-and-forget the send;
 *    on rejection, fall back to the buffer so the entry isn't lost.
 * 4. Otherwise buffer the entry for a later flush (main.tsx integration).
 */
function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (precedence(level) < precedence(getLevel())) return;
  const entry: LogEntry = {
    level,
    message,
    fields: fields ?? {},
    window_label: getWindowLabel(),
    timestamp: Date.now(),
  };
  if (bridge.isReady()) {
    void bridge.send(entry).catch(() => {
      buffer.push(entry);
    });
    return;
  }
  buffer.push(entry);
}

export const logger = {
  /**
   * Log a trace-level event.
   *
   * Field names MUST be snake_case per ADR-0016 (matches Rust `tracing`
   * convention; keeps the unified log file greppable with one pattern
   * per field across both origins).
   *
   * @example
   *   logger.trace("router resolved", { route_id: id, params_count: n });
   */
  trace(message: string, fields?: Record<string, unknown>): void {
    emit('trace', message, fields);
  },

  /**
   * Log a debug-level event.
   *
   * Field names MUST be snake_case per ADR-0016 (matches Rust `tracing`
   * convention; keeps the unified log file greppable with one pattern
   * per field across both origins).
   *
   * @example
   *   logger.debug("query cache hit", { query_key: key });
   */
  debug(message: string, fields?: Record<string, unknown>): void {
    emit('debug', message, fields);
  },

  /**
   * Log an info-level event.
   *
   * Field names MUST be snake_case per ADR-0016 (matches Rust `tracing`
   * convention; ensures unified log file is greppable with one pattern
   * per field).
   *
   * @example
   *   logger.info("character saved", { character_id: id, world_id: wid });
   */
  info(message: string, fields?: Record<string, unknown>): void {
    emit('info', message, fields);
  },

  /**
   * Log a warn-level event.
   *
   * Field names MUST be snake_case per ADR-0016 (matches Rust `tracing`
   * convention; keeps the unified log file greppable with one pattern
   * per field across both origins).
   *
   * @example
   *   logger.warn("retrying ai call", { provider: "openai", attempt: 2 });
   */
  warn(message: string, fields?: Record<string, unknown>): void {
    emit('warn', message, fields);
  },

  /**
   * Log an error-level event.
   *
   * In addition to the normal pipeline, error-level events are also
   * forwarded to `console.error` unconditionally — this is a last-resort
   * fallback so devtools surfaces the failure even if the bridge silently
   * drops the entry (e.g. IPC channel torn down during shutdown).
   *
   * Field names MUST be snake_case per ADR-0016.
   *
   * @example
   *   logger.error("save failed", { entity: "character", entity_id: id, error_code: "DB_LOCKED" });
   */
  error(message: string, fields?: Record<string, unknown>): void {
    emit('error', message, fields);
    // Last-resort fallback: devtools should always surface errors even
    // if the bridge silently swallowed them.
    // oxlint-disable-next-line no-console
    console.error(message, fields);
  },
};
