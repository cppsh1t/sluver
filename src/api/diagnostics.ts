/**
 * Diagnostics IPC API.
 *
 * User-facing logging surface (ADR-0014 / ADR-0015). Wraps the five
 * `commands::diagnostics` Tauri commands:
 *
 * - `getLogLevel` / `setLogLevel` — read + change the persisted verbosity tier
 *   (`app.logLevel` in the Settings KV). A successful `setLogLevel` hot-reloads
 *   the Rust `EnvFilter` AND emits a `log-level-changed` Tauri event so the
 *   frontend can sync its local threshold (see `src/lib/logger/level.ts`).
 * - `getLogsDir` — on-disk logs directory (for the "Reveal in file manager"
 *   action via `tauri-plugin-opener`).
 * - `exportLogs` — produce a zip of (optionally Space-filtered, optionally
 *   date-bounded) log files plus a README with system metadata.
 * - `clearLogs` — delete every `sluver.YYYY-MM-DD.log` file EXCEPT today's.
 *
 * The frontend-to-Rust log record bridge (`frontend_log`) is NOT exposed
 * here — it is an internal call used by `src/lib/logger/bridge.ts`.
 */

import { call } from './client';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Persisted verbosity tier. Values match the Rust-side string literals
 * stored under `settings.app.logLevel` (snake_case — protocol-level
 * identifier, not user-facing copy).
 */
export type VerbosityTier = 'standard' | 'verbose' | 'very_verbose';

/**
 * Date window for {@link exportLogs}. Mirrors the Rust-side `DateRange` enum
 * (externally tagged serde enum with `rename_all = "camelCase"`). Sent over
 * IPC as one of:
 *   - `{ all: null }`
 *   - `{ last24Hours: null }`
 *   - `{ lastNDays: { days: 14 } }`
 */
export type DateRange =
  | { all: null }
  | { last24Hours: null }
  | { lastNDays: { days: number } };

/**
 * Constructor helpers for {@link DateRange}. Use these at call sites instead
 * of hand-writing the discriminated union — keeps the serde wire format in
 * one place.
 *
 * @example
 *   exportLogs({ outputPath, dateRange: dateRange.lastNDays(14) });
 */
export const dateRange = {
  all: (): DateRange => ({ all: null }),
  last24Hours: (): DateRange => ({ last24Hours: null }),
  lastNDays: (days: number): DateRange => ({ lastNDays: { days } }),
};

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Read the persisted verbosity tier. Missing row (first run) → `"standard"`,
 * matching the bootstrap default of `LoggingState` (`info,sluver=debug`).
 */
export function getLogLevel(): Promise<VerbosityTier> {
  return call<VerbosityTier>('get_log_level');
}

/**
 * Persist a new verbosity tier, hot-reload the Rust `EnvFilter`, and emit
 * `log-level-changed` so other windows (and the frontend threshold in
 * `src/lib/logger/level.ts`) can sync.
 */
export function setLogLevel(level: VerbosityTier): Promise<void> {
  return call<void>('set_log_level', { level });
}

/**
 * Resolve the on-disk logs directory. Use with `tauri-plugin-opener`'s
 * `openPath()` to reveal the folder in the OS file manager.
 */
export function getLogsDir(): Promise<string> {
  return call<string>('get_logs_dir');
}

/**
 * Produce a zip of log files at `outputPath`.
 *
 * Filtering:
 *   - `spaceIdFilter = null` → every log file is added as-is.
 *   - `spaceIdFilter = "<id>"` → each line is parsed as JSON and only kept
 *     if `space_id` is null/missing (cross-Space events per ADR-0015) OR
 *     equals the provided id. Unparseable lines are kept defensively.
 *   - `dateRange` gates which daily files are considered.
 *
 * A `README.txt` is always included with non-sensitive system metadata.
 */
export function exportLogs(args: {
  outputPath: string;
  spaceIdFilter?: string | null;
  dateRange: DateRange;
}): Promise<void> {
  return call<void>('export_logs', {
    outputPath: args.outputPath,
    spaceIdFilter: args.spaceIdFilter ?? null,
    dateRange: args.dateRange,
  });
}

/**
 * Delete every `sluver.YYYY-MM-DD.log` file EXCEPT today's active file.
 * Returns the count of files deleted.
 */
export function clearLogs(): Promise<number> {
  return call<number>('clear_logs');
}
