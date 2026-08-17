//! Diagnostics commands — user-facing logging surface (ADR-0014 / ADR-0015).
//!
//! Five Tauri commands built on top of [`crate::logging`]:
//!
//! - [`frontend_log`] — bridge frontend log records into the same `tracing`
//!   subscriber that owns the JSON-lines file (replaces `tauri-plugin-log`).
//! - [`get_log_level`] / [`set_log_level`] — read + change the persisted
//!   verbosity tier (`app.logLevel` in the Settings KV). A successful change
//!   hot-reloads the `EnvFilter` and emits a `log-level-changed` event so the
//!   frontend can sync its local threshold.
//! - [`get_logs_dir`] — expose the on-disk logs directory (drives the
//!   "Reveal in file manager" action via `tauri-plugin-opener`).
//! - [`export_logs`] — produce a zip of (optionally Space-filtered, optionally
//!   date-bounded) log files plus a README with non-sensitive metadata.
//! - [`clear_logs`] — delete every log file EXCEPT today's active file.
//!
//! # Field-name convention (ADR-0016)
//!
//! All structured `tracing` field names emitted here are `snake_case`. The
//! frontend `frontend_log` payload ALREADY arrives with `snake_case` keys —
//! we stringify the object whole rather than rename/iterate, so the
//! structured `fields` tracing field reproduces the original verbatim in the
//! JSON-lines file (no silent renaming at the bridge — see ADR-0016).

use std::fs::{File, read_dir};
use std::io::{BufRead, BufReader, Read, Write};

use chrono::{Duration, Local, NaiveDate};
use rusqlite::params;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use zip::{CompressionMethod, ZipWriter};
use zip::write::SimpleFileOptions;

use crate::db::{DbError, DbManager};
use crate::logging::LoggingState;
use crate::util::now_iso;

// ─── constants ───────────────────────────────────────────────────────────────

/// Settings KV key holding the persisted verbosity tier
/// (`"standard" | "verbose" | "very_verbose"`).
const LOG_LEVEL_KEY: &str = "app.logLevel";

/// Default tier returned by [`get_log_level`] on first run (no row in
/// `settings` yet). Matches the `LoggingState` bootstrap default
/// (`DEFAULT_FILTER = "info,sluver=debug"`).
const DEFAULT_LOG_LEVEL: &str = "standard";

// ─── DateRange (frontend-supplied) ───────────────────────────────────────────

/// Date window for [`export_logs`]. Externally tagged (serde default) +
/// `camelCase` rename so the frontend sends `{ "all": null }`,
/// `{ "last24Hours": null }`, or `{ "lastNDays": { "days": 14 } }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateRange {
    All,
    Last24Hours,
    LastNDays { days: u32 },
}

// ─── log-level-changed event payload ─────────────────────────────────────────

/// Payload of the `log-level-changed` Tauri event. The frontend listens for
/// this to update its in-memory threshold without polling.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLevelChangedPayload {
    level: String,
    filter: String,
}

// ═══════════════════════════════════════════════════════════════════════════
// frontend_log
// ═══════════════════════════════════════════════════════════════════════════

/// Re-emit a frontend log record into the global `tracing` subscriber.
///
/// Fire-and-forget (returns `()`): `tracing` macros can't fail, and we
/// intentionally don't surface a `Result` so the TS callsite never has to
/// handle a rejection for a logging call. If `level` is unrecognized we
/// default to `info!` and attach `unknown_level` so the bad value isn't
/// silently swallowed.
///
/// Per ADR-0016 the `fields` JSON object already carries `snake_case` keys
/// — we stringify it whole rather than rename/iterate, so the structured
/// `fields` tracing field reproduces the original object verbatim in the
/// JSON-lines file.
#[tauri::command]
pub fn frontend_log(
    level: String,
    message: String,
    fields: serde_json::Value,
    window_label: String,
    timestamp: i64,
) {
    let fields_str = fields.to_string();
    match level.as_str() {
        "trace" => tracing::trace!(
            source = "frontend",
            window = %window_label,
            frontend_ts = timestamp,
            fields = %fields_str,
            "{message}"
        ),
        "debug" => tracing::debug!(
            source = "frontend",
            window = %window_label,
            frontend_ts = timestamp,
            fields = %fields_str,
            "{message}"
        ),
        "info" => tracing::info!(
            source = "frontend",
            window = %window_label,
            frontend_ts = timestamp,
            fields = %fields_str,
            "{message}"
        ),
        "warn" => tracing::warn!(
            source = "frontend",
            window = %window_label,
            frontend_ts = timestamp,
            fields = %fields_str,
            "{message}"
        ),
        "error" => tracing::error!(
            source = "frontend",
            window = %window_label,
            frontend_ts = timestamp,
            fields = %fields_str,
            "{message}"
        ),
        other => tracing::info!(
            source = "frontend",
            window = %window_label,
            frontend_ts = timestamp,
            fields = %fields_str,
            unknown_level = other,
            "{message}"
        ),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// get_log_level
// ═══════════════════════════════════════════════════════════════════════════

/// Read the persisted verbosity tier. Missing row (first run) → `"standard"`,
/// matching the bootstrap default of `LoggingState`.
#[tauri::command]
pub fn get_log_level(state: State<'_, DbManager>) -> Result<String, DbError> {
    state.with_meta(|conn| {
        // Any error (missing row, etc.) → default tier. We don't distinguish
        // "no row yet" from "table read failed" because both mean "user has
        // never picked a tier" in practice.
        let level: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![LOG_LEVEL_KEY],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| DEFAULT_LOG_LEVEL.to_string());
        Ok(level)
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// set_log_level
// ═══════════════════════════════════════════════════════════════════════════

/// Change the persisted verbosity tier, hot-reload the `EnvFilter`, and
/// broadcast the change so the frontend can sync.
///
/// Order:
///   1. Validate `level` (reject unknown tiers with
///      [`DbError::InvalidLogLevel`]).
///   2. Persist to the Settings KV so the choice survives restart.
///   3. Reload the subscriber's `EnvFilter`. On failure we DON'T roll back
///      the row — the user's intent is recorded, the still-healthy old
///      filter keeps running, and the rejection surfaces the cause.
///   4. Emit `log-level-changed` AFTER the reload succeeded so listeners
///      observe a consistent post-reload state.
///   5. Log the change itself.
#[tauri::command]
pub fn set_log_level(
    level: String,
    state: State<'_, DbManager>,
    logging_state: State<'_, LoggingState>,
    app: AppHandle,
) -> Result<(), DbError> {
    let filter_str: &'static str = crate::logging::tier_to_filter(level.as_str())
        .ok_or_else(|| DbError::InvalidLogLevel(level.clone()))?;

    state.with_meta(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![LOG_LEVEL_KEY, level],
        )?;
        Ok(())
    })?;

    logging_state.reload_filter_str(filter_str)?;

    // Best-effort emit — if no listener is attached (e.g. every window is
    // hidden), the event is a no-op. Failure here doesn't undo the change.
    let _ = app.emit(
        "log-level-changed",
        LogLevelChangedPayload {
            level: level.clone(),
            filter: filter_str.to_string(),
        },
    );

    tracing::info!(
        new_level = %level,
        filter = %filter_str,
        "log level changed"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// get_logs_dir
// ═══════════════════════════════════════════════════════════════════════════

/// Resolve and return the on-disk logs directory. The frontend uses this to
/// drive a "Reveal in file manager" action via `tauri-plugin-opener`.
#[tauri::command]
pub fn get_logs_dir(app: AppHandle) -> Result<String, DbError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| DbError::Internal(e.to_string()))?;
    let dir = crate::logging::logs_dir(&data_dir);
    Ok(dir.to_string_lossy().into_owned())
}

// ═══════════════════════════════════════════════════════════════════════════
// export_logs
// ═══════════════════════════════════════════════════════════════════════════

/// Produce a zip of log files at `output_path`.
///
/// Filtering (ADR-0015 export-time Space isolation):
///   - `space_id_filter = None` → every matching daily file is added as-is.
///   - `space_id_filter = Some(id)` → each line is parsed as JSON and kept
///     iff `space_id` is `null`/missing (cross-Space events per ADR-0015)
///     OR equals `id`. Unparseable lines are kept defensively —
///     over-inclusion beats silently dropping diagnostics when the JSON
///     shape drifts.
///   - `date_range` gates which daily files are considered at all.
///
/// A `README.txt` is always included with non-sensitive system metadata
/// (version / OS / range / filter — no PII, no API keys per ADR-0016
/// redaction policy).
#[tauri::command]
pub fn export_logs(
    output_path: String,
    space_id_filter: Option<String>,
    date_range: DateRange,
    app: AppHandle,
) -> Result<(), DbError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| DbError::LogExportFailed(e.to_string()))?;
    let logs_dir = crate::logging::logs_dir(&data_dir);

    // Resolve the date cutoff from the DateRange tier.
    let today = Local::now().date_naive();
    let (date_cutoff, range_description) = match date_range {
        DateRange::All => (None, "all".to_string()),
        DateRange::Last24Hours => (
            Some(today - Duration::days(1)),
            "last 24 hours".to_string(),
        ),
        DateRange::LastNDays { days } => {
            let d = days.max(1) as i64;
            (Some(today - Duration::days(d)), format!("last {d} days"))
        }
    };

    let file = File::create(&output_path)
        .map_err(|e| DbError::LogExportFailed(format!("create output: {e}")))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let entries = read_dir(&logs_dir)
        .map_err(|e| DbError::LogExportFailed(format!("read logs dir: {e}")))?;

    // Label for the README: "some" iff per-line filtering was applied.
    let lines_filtered_label = if space_id_filter.is_some() {
        "some"
    } else {
        "all"
    };

    let mut included_count: u32 = 0;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "export_logs: skipping unreadable dir entry");
                continue;
            }
        };

        let filename = entry.file_name();
        let Some(filename_str) = filename.to_str() else {
            continue;
        };

        // Match `sluver.YYYY-MM-DD.log` exactly — non-matching files are
        // ignored (consistent with `logging::cleanup_old_logs`).
        let Some(log_date) = parse_log_date(filename_str) else {
            continue;
        };

        if let Some(cutoff) = date_cutoff {
            if log_date < cutoff {
                continue;
            }
        }

        if let Some(filter) = &space_id_filter {
            let bytes = filter_log_file(entry.path(), filter)
                .map_err(|e| DbError::LogExportFailed(format!("filter {filename_str}: {e}")))?;
            zip.start_file(filename_str, options).map_err(|e| {
                DbError::LogExportFailed(format!("zip start {filename_str}: {e}"))
            })?;
            zip.write_all(&bytes).map_err(|e| {
                DbError::LogExportFailed(format!("zip write {filename_str}: {e}"))
            })?;
        } else {
            zip.start_file(filename_str, options).map_err(|e| {
                DbError::LogExportFailed(format!("zip start {filename_str}: {e}"))
            })?;
            let mut f = File::open(entry.path()).map_err(|e| {
                DbError::LogExportFailed(format!("open {filename_str}: {e}"))
            })?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| {
                DbError::LogExportFailed(format!("read {filename_str}: {e}"))
            })?;
            zip.write_all(&buf).map_err(|e| {
                DbError::LogExportFailed(format!("zip write {filename_str}: {e}"))
            })?;
        }

        included_count += 1;
    }

    // README.txt — included unconditionally so a recipient of the zip can
    // tell at a glance what was filtered and when. No PII per ADR-0016.
    let space_filter_label = space_id_filter.as_deref().unwrap_or("all");
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    let exported_at = now_iso();
    let readme = format!(
        "sluver log export\n\
         =================\n\
         App version:    {version}\n\
         Build profile:  {profile}\n\
         OS:             {os_str} {arch_str}\n\
         Exported at:    {exported_at}\n\
         Log level:      unknown\n\
         Space filter:   {space_filter_label}\n\
         Date range:     {range_description}\n\
         Lines filtered: {lines_filtered_label}\n\
         Files included: {included_count}\n",
        version = env!("CARGO_PKG_VERSION"),
        os_str = std::env::consts::OS,
        arch_str = std::env::consts::ARCH,
    );

    zip.start_file("README.txt", options)
        .map_err(|e| DbError::LogExportFailed(format!("zip start README: {e}")))?;
    zip.write_all(readme.as_bytes())
        .map_err(|e| DbError::LogExportFailed(format!("zip write README: {e}")))?;

    zip.finish()
        .map_err(|e| DbError::LogExportFailed(format!("zip finish: {e}")))?;

    tracing::info!(
        output_path = %output_path,
        included_count,
        space_filter = space_filter_label,
        range = %range_description,
        "logs exported"
    );

    Ok(())
}

/// Read `path` line by line and return the bytes of a file containing only
/// the lines that pass the Space filter (per [`line_matches_space`]).
/// Trailing blank lines are dropped. Each kept line is followed by `\n`.
fn filter_log_file<P: AsRef<std::path::Path>>(path: P, filter: &str) -> Result<Vec<u8>, std::io::Error> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut out: Vec<u8> = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if line_matches_space(&line, filter) {
            out.extend_from_slice(line.as_bytes());
            out.push(b'\n');
        }
    }
    Ok(out)
}

// ═══════════════════════════════════════════════════════════════════════════
// clear_logs
// ═══════════════════════════════════════════════════════════════════════════

/// Delete every `sluver.YYYY-MM-DD.log` file in the logs dir EXCEPT today's
/// active file. Returns the count of files deleted. Today's filename uses
/// local time, matching `tracing-appender`'s rotation clock.
#[tauri::command]
pub fn clear_logs(app: AppHandle) -> Result<u32, DbError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| DbError::Internal(e.to_string()))?;
    let logs_dir = crate::logging::logs_dir(&data_dir);

    let today_filename = format!("sluver.{}.log", Local::now().format("%Y-%m-%d"));

    let entries = read_dir(&logs_dir).map_err(|e| DbError::Internal(e.to_string()))?;

    let mut deleted: u32 = 0;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let filename = entry.file_name();
        let Some(filename_str) = filename.to_str() else {
            continue;
        };
        if filename_str == today_filename {
            continue;
        }
        // Only delete files matching our naming scheme — defensive against
        // a user dropping unrelated files into the logs dir.
        if parse_log_date(filename_str).is_none() {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => deleted += 1,
            Err(e) => {
                tracing::warn!(
                    path = %entry.path().display(),
                    error = %e,
                    "clear_logs: failed to delete file"
                );
            }
        }
    }

    tracing::info!(deleted_count = deleted, "logs cleared");
    Ok(deleted)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Parse a `sluver.YYYY-MM-DD.log` filename into a [`NaiveDate`]. Returns
/// `None` for any name that doesn't match the exact scheme — callers treat
/// that as "leave alone". This mirrors `logging::parse_log_date` (private)
/// because the foundation module is treated as immutable by this layer.
fn parse_log_date(filename: &str) -> Option<NaiveDate> {
    let parts: Vec<&str> = filename.split('.').collect();
    if parts.len() != 3 || parts[0] != "sluver" || parts[2] != "log" {
        return None;
    }
    // chrono's `%m`/`%d` are lenient (they accept `2026-7-5` too), but
    // tracing-appender only ever writes zero-padded `YYYY-MM-DD` — enforce
    // the canonical 10-char shape so lookalikes are left alone.
    // Mirrors `logging::parse_log_date` (kept in sync by contract).
    let b = parts[1].as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    NaiveDate::parse_from_str(parts[1], "%Y-%m-%d").ok()
}

/// Decide whether a JSON-lines log record belongs in the export. Rules:
///   - Empty `space_id` (null or missing) → keep (cross-Space event).
///   - String `space_id` == `filter` → keep.
///   - Anything else → drop.
///
/// Unparseable lines are KEPT defensively — over-inclusion beats silently
/// losing diagnostics when the JSON shape drifts.
fn line_matches_space(line: &str, filter: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return true;
    };
    let Some(obj) = v.as_object() else {
        return true;
    };
    match obj.get("space_id") {
        None | Some(serde_json::Value::Null) => true,
        Some(s) => s.as_str().is_some_and(|sid| sid == filter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── parse_log_date ────────────────────────────────────────────────────

    #[test]
    fn parse_log_date_accepts_canonical_name() {
        assert_eq!(
            parse_log_date("sluver.2026-07-25.log"),
            Some(NaiveDate::from_ymd_opt(2026, 7, 25).unwrap())
        );
    }

    #[test]
    fn parse_log_date_rejects_non_matching_names() {
        assert!(parse_log_date("sluver-2026-07-25.log").is_none()); // dash, not dot
        assert!(parse_log_date("sluver.log").is_none()); // no date
        assert!(parse_log_date("random.txt").is_none());
        assert!(parse_log_date("sluver.2026-7-5.log").is_none()); // not zero-padded
        assert!(parse_log_date("sluver.2026-07-25.log.bak").is_none()); // extra ext
    }

    // ─── line_matches_space ────────────────────────────────────────────────

    #[test]
    fn line_matches_space_null_or_missing_keeps_line() {
        // Missing space_id field → cross-Space event, kept.
        let no_field = r#"{"msg":"boot","level":"info"}"#;
        assert!(line_matches_space(no_field, "space-1"));
        // null space_id → explicitly cross-Space, kept.
        let null_field = r#"{"msg":"boot","space_id":null}"#;
        assert!(line_matches_space(null_field, "space-1"));
    }

    #[test]
    fn line_matches_space_matching_id_keeps_line() {
        let line = r#"{"msg":"open","space_id":"space-1"}"#;
        assert!(line_matches_space(line, "space-1"));
        assert!(!line_matches_space(line, "space-2"));
    }

    #[test]
    fn line_matches_space_unparseable_keeps_line() {
        // Garbage in → kept defensively (never silently drop diagnostics).
        assert!(line_matches_space("not json at all", "space-1"));
        assert!(line_matches_space("{broken", "space-1"));
    }

    #[test]
    fn line_matches_space_non_object_json_keeps_line() {
        // A bare JSON value (not an object) → kept defensively.
        assert!(line_matches_space("[1,2,3]", "space-1"));
        assert!(line_matches_space("\"string\"", "space-1"));
        assert!(line_matches_space("42", "space-1"));
    }

    // ─── DateRange deserialization ─────────────────────────────────────────

    #[test]
    fn date_range_all_deserializes() {
        let dr: DateRange = serde_json::from_str(r#"{"all":null}"#).expect("parse All");
        assert!(matches!(dr, DateRange::All));
    }

    #[test]
    fn date_range_last24_hours_deserializes() {
        let dr: DateRange =
            serde_json::from_str(r#"{"last24Hours":null}"#).expect("parse Last24Hours");
        assert!(matches!(dr, DateRange::Last24Hours));
    }

    #[test]
    fn date_range_last_n_days_deserializes() {
        let dr: DateRange =
            serde_json::from_str(r#"{"lastNDays":{"days":14}}"#).expect("parse LastNDays");
        match dr {
            DateRange::LastNDays { days } => assert_eq!(days, 14),
            other => panic!("expected LastNDays, got {other:?}"),
        }
    }
}
