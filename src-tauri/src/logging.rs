//! Logging foundation for sluver (ADR-0014).
//!
//! Implements the layered `tracing` subscriber described in ADR-0014 /
//! ADR-0015 / ADR-0016:
//!
//! - **Layer 1 — file**: JSON-lines to a daily-rotating file under
//!   `data_dir/logs/sluver.YYYY-MM-DD.log` (see the deviation note below).
//!   Wrapped in `tracing_appender::non_blocking` so log writes never block
//!   command handlers.
//! - **Layer 2 — stderr**: `pretty()` formatter, always on. In a release
//!   build with `windows_subsystem = "windows"` (see `main.rs`) there is no
//!   stderr console attached, so this is effectively free; in dev it gives
//!   instant feedback in the terminal.
//! - **Filter layer (reloadable)**: `EnvFilter` driven by `RUST_LOG`, falling
//!   back to [`DEFAULT_FILTER`] (`info,sluver=debug`). The handle is stored
//!   in [`LoggingState`] so future commands can change verbosity at runtime
//!   without restarting the subscriber.
//!
//! The `log::*` facade is bridged in via `tracing_log::LogTracer::init()`
//! so dependency emits (tauri, rusqlite, reqwest, tokio, …) flow into the
//! same subscriber.
//!
//! # Naming deviation from ADR-0015
//!
//! ADR-0015 specifies `sluver-YYYY-MM-DD.log` (dash separator). The
//! `tracing-appender` `RollingFileAppender::builder` hardcodes a `.`
//! separator between `prefix`, `date`, and `suffix` — see its
//! `join_date` implementation:
//!
//! ```text
//! (_, Some(prefix), Some(suffix)) => format!("{}.{}.{}", prefix, date, suffix)
//! ```
//!
//! There is no escape hatch, so the closest achievable name is
//! `sluver.YYYY-MM-DD.log`. [`cleanup_old_logs`] matches this actual
//! format. ADR-0015's prose is the only consumer of the literal name; the
//! export-time filter (ADR-0015) keys off the `space_id` field, not the
//! filename, so the divergence is cosmetic.
//!
//! All structured field names are `snake_case` per ADR-0016.

use std::sync::Mutex;

use chrono::{Duration, Local, NaiveDate};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{EnvFilter, Registry, fmt, prelude::*, reload};

use crate::db::DbError;

/// Default `EnvFilter` directive when `RUST_LOG` is unset.
///
/// - `info` — capture INFO+ from every crate by default.
/// - `sluver=debug` — bump our own crate to DEBUG so early-development
///   context isn't lost. End users override via `RUST_LOG`.
pub const DEFAULT_FILTER: &str = "info,sluver=debug";

/// Maximum log retention enforced by [`cleanup_old_logs`] when the caller
/// doesn't pass an explicit value. Wired in from `lib.rs` as 14 days.
pub const DEFAULT_RETENTION_DAYS: u32 = 14;

// ─── verbosity tiers (settings.app.logLevel) ─────────────────────────────────

/// The three persisted verbosity tiers (values stored under
/// `settings.app.logLevel`). Kept in sync with the frontend `VerbosityTier`
/// type (`src/api/diagnostics.ts`).
pub const TIER_STANDARD: &str = "standard";
pub const TIER_VERBOSE: &str = "verbose";
pub const TIER_VERY_VERBOSE: &str = "very_verbose";

/// Canonical tier → `EnvFilter` directive mapping. Single source of truth
/// used by:
///   - `commands::diagnostics::set_log_level` (when the user changes
///     verbosity at runtime)
///   - `lib::setup` (when re-applying the persisted tier on startup)
///
/// Returns `None` for unrecognized tiers so callers can decide to skip
/// (startup, best-effort) or reject (`set_log_level` →
/// [`DbError::InvalidLogLevel`]).
///
/// The three tiers and their filters:
///   - [`TIER_STANDARD`]     → [`DEFAULT_FILTER`] (`info,sluver=debug`)
///   - [`TIER_VERBOSE`]      → `debug` (every crate at DEBUG+)
///   - [`TIER_VERY_VERBOSE`] → `trace` for our crate, but the noisiest
///     infrastructure crates pinned to `warn` so the file isn't drowned in
///     rusqlite/hyper/h2 chatter (`reqwest`/`hyper`/`h2` emit every HTTP
///     header + body chunk at `trace`).
pub fn tier_to_filter(tier: &str) -> Option<&'static str> {
    match tier {
        TIER_STANDARD => Some(DEFAULT_FILTER), // "info,sluver=debug"
        TIER_VERBOSE => Some("debug"),
        TIER_VERY_VERBOSE => Some("trace,rusqlite=warn,reqwest=warn,hyper=warn,h2=warn"),
        _ => None,
    }
}

/// Owned state for the global logging subscriber.
///
/// Must live for the entire process (it's managed via `app.manage(...)` in
/// `lib.rs::setup`). Dropping the [`WorkerGuard`] flushes the
/// non-blocking writer and joins its worker thread — if it dropped early,
/// pending log writes would be silently lost on shutdown.
///
/// `Send + Sync` so it can live in `tauri::State<Self>`; the guard is `Send`
/// but `!Sync`, so it sits behind a `Mutex`. The reload handle is `Clone +
/// Send + Sync` internally (it shares state through an `Arc`).
#[allow(dead_code)] // Field readers + reload methods are wired up in a
                    // downstream task (logging commands TBA per ADR-0014).
                    // The struct itself is consumed by `app.manage(...)` for
                    // its Drop semantics; the fields don't need to be read
                    // from outside this module until that task lands.
pub struct LoggingState {
    /// `!Sync` — wrapped so the whole struct can be `Sync`.
    guard: Mutex<WorkerGuard>,
    /// Allows runtime `EnvFilter` swaps without rebuilding the subscriber.
    /// Second type parameter pins the subscriber type (always `Registry`
    /// here — we build the cake off `Registry::default()`).
    reload_handle: reload::Handle<EnvFilter, Registry>,
}

impl LoggingState {
    /// Swap the active [`EnvFilter`] at runtime.
    ///
    /// Errors propagate as [`DbError::LoggingReload`] — the subscriber keeps
    /// running with the previous filter on failure, so logging is never
    /// lost; only the requested change is rejected.
    #[allow(dead_code)] // Wired up in a downstream task (logging commands
                        // TBA per ADR-0014).
    pub fn reload_filter(&self, new_filter: EnvFilter) -> Result<(), DbError> {
        self.reload_handle
            .reload(new_filter)
            .map_err(|e| DbError::LoggingReload(e.to_string()))
    }

    /// Convenience wrapper: parse a directive string and call
    /// [`Self::reload_filter`]. Accepts the same syntax as `RUST_LOG`
    /// (e.g. `"debug,sluver::commands=trace,reqwest=warn"`).
    #[allow(dead_code)] // Wired up in a downstream task (logging commands
                        // TBA per ADR-0014).
    pub fn reload_filter_str(&self, filter_str: &str) -> Result<(), DbError> {
        let new_filter = EnvFilter::try_new(filter_str)
            .map_err(|e| DbError::LoggingReload(e.to_string()))?;
        self.reload_filter(new_filter)
    }
}

/// Initialize the global logging stack.
///
/// Idempotent in spirit but not in fact: a second call will fail at
/// `set_global_default` because there's already a global subscriber.
/// Designed to be called exactly once, from `tauri::Builder::setup`.
///
/// Order matters and is documented inline below — particularly the
/// `tracing_log::LogTracer::init()` → `set_global_default(subscriber)`
/// sequence and the panic-hook install (which must happen AFTER tracing is
/// live so the hook's `tracing::error!` actually lands in the file).
pub fn init(data_dir: &std::path::Path) -> Result<LoggingState, DbError> {
    // ---- file writer (Layer 1) ----------------------------------------
    // `prefix.suffix` produces `sluver.YYYY-MM-DD.log` (see module docs for
    // why the separator is `.` not `-`).
    let file_writer = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("sluver")
        .filename_suffix("log")
        .build(logs_dir(data_dir))
        .map_err(|e| DbError::LoggingInit(e.to_string()))?;

    // `non_blocking` spawns a dedicated writer thread + gives back a guard
    // whose Drop flushes the queue. The guard MUST outlive the subscriber
    // — we stash it in LoggingState which Tauri manages for the app lifetime.
    let (non_blocking, guard) = tracing_appender::non_blocking(file_writer);

    // ---- reloadable EnvFilter ----------------------------------------
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let (filter_layer, reload_handle) = reload::Layer::new(filter);

    // ---- layer cake ---------------------------------------------------
    // Order: filter first so it gates what reaches both formatters.
    //   - file layer: JSON-lines, no ANSI escapes (would corrupt JSON).
    //   - stderr layer: pretty-printed; no-op in release builds with no
    //     console (see main.rs `windows_subsystem`).
    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .json();
    let stderr_layer = fmt::layer().with_writer(std::io::stderr).pretty();

    let subscriber = Registry::default()
        .with(filter_layer)
        .with(file_layer)
        .with(stderr_layer);

    // Bridge `log::*` from deps into our subscriber. Done BEFORE
    // `set_global_default` per the task spec — in practice the ordering
    // only matters if a `log::*` call fires in the window between these
    // two calls, which is essentially impossible here.
    tracing_log::LogTracer::init()
        .map_err(|e| DbError::LoggingInit(e.to_string()))?;

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| DbError::LoggingInit(e.to_string()))?;

    // ---- panic hook ---------------------------------------------------
    // Installed AFTER tracing is live so the hook's `error!` actually lands.
    // We capture the default hook first so dev-mode stderr output is
    // preserved (the default hook prints the panic to stderr).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // `info.location()` is `Option<&Location>` — flatten to a string
        // for structured logging. `<unknown>` is a safe sentinel for the
        // rare panic without a known source location.
        let location_str = info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "<unknown>".to_string());
        // `force_capture` always produces a backtrace (RUST_BACKTRACE
        // semantics are honored by the stdlib). Stringifying here keeps
        // the field flat for JSON consumers.
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(
            panic = %info,
            location = %location_str,
            backtrace = %backtrace,
            "panic captured"
        );
        // Delegate to the std default so dev console output is unchanged.
        default_hook(info);
    }));

    Ok(LoggingState {
        guard: Mutex::new(guard),
        reload_handle,
    })
}

/// Best-effort retention sweep — runs at startup, never blocks on errors.
///
/// Walks `data_dir/logs/`, parses the date suffix from each
/// `sluver.YYYY-MM-DD.log` filename, and deletes any file older than
/// `max_age_days` from today (local time, matching `tracing-appender`'s
/// rotation clock). Per-file failures are logged and skipped — the sweep
/// must not abort startup or panic the process.
///
/// The current day's active file is naturally excluded by the date check.
/// Non-matching filenames (e.g. anything a user dropped in the folder) are
/// left alone.
pub fn cleanup_old_logs(data_dir: &std::path::Path, max_age_days: u32) {
    let dir = logs_dir(data_dir);
    let today = Local::now().date_naive();
    let cutoff = today - Duration::days(max_age_days.max(1) as i64);

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            // Most likely the logs/ dir doesn't exist yet (init() creates
            // it, but a fresh install before setup runs could hit this).
            // Warn-and-return — not an error worth surfacing.
            tracing::warn!(
                dir = %dir.display(),
                error = %e,
                "cleanup_old_logs: could not read logs dir"
            );
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "cleanup_old_logs: skipping unreadable dir entry"
                );
                continue;
            }
        };

        let filename = entry.file_name();
        let Some(filename_str) = filename.to_str() else {
            // Non-UTF-8 name — almost certainly not one of ours. Ignore.
            continue;
        };

        let Some(log_date) = parse_log_date(filename_str) else {
            // Doesn't match our naming scheme — leave it alone.
            continue;
        };

        if log_date >= cutoff {
            continue;
        }

        let path = entry.path();
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "cleanup_old_logs: failed to delete stale log file"
            );
        } else {
            tracing::info!(
                path = %path.display(),
                log_date = %log_date,
                "deleted stale log file"
            );
        }
    }
}

/// Where log files live: `data_dir/logs/`.
pub fn logs_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("logs")
}

/// Parse the date from a `sluver.YYYY-MM-DD.log` filename.
///
/// Returns `None` for any name that doesn't match the exact scheme —
/// callers treat that as "leave it alone". Kept private: this is an
/// implementation detail of [`cleanup_old_logs`] and only knows the
/// actual on-disk format (see the module-level deviation note).
fn parse_log_date(filename: &str) -> Option<NaiveDate> {
    // Format: `sluver.YYYY-MM-DD.log` → 3 dot-separated parts.
    // Reject anything with a different shape so we never mis-parse a
    // user-dropped file.
    let parts: Vec<&str> = filename.split('.').collect();
    if parts.len() != 3 || parts[0] != "sluver" || parts[2] != "log" {
        return None;
    }
    // chrono's `%m`/`%d` are lenient (they accept `2026-7-5` too), but
    // tracing-appender only ever writes zero-padded `YYYY-MM-DD` — enforce
    // the canonical 10-char shape so lookalikes are left alone.
    let b = parts[1].as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    NaiveDate::parse_from_str(parts[1], "%Y-%m-%d").ok()
}

#[cfg(test)]
#[path = "tests/logging.rs"]
mod tests;
