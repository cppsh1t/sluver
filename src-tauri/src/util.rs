/// Password hashing utilities (argon2id). See `password` module.
pub mod password;

/// Generate a UUID v7 string (time-sortable).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Generate an ISO 8601 timestamp in UTC with millisecond precision and `Z` suffix.
/// Format: `2025-01-15T10:30:00.123Z`
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Normalize an optional timestamp to canonical ISO 8601 (UTC, ms, `Z`).
/// Returns `None` for `None` input or any value that fails to parse as RFC 3339,
/// so non-ISO strings (e.g. narrative text like "午夜") can never reach the
/// `start_at`/`end_at` columns. Output format matches `now_iso`. See ADR-0026.
pub fn normalize_iso(opt: &Option<String>) -> Option<String> {
    opt.as_ref().and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| {
            dt.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
    })
}
