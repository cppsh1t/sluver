/// Generate a UUID v7 string (time-sortable).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Generate an ISO 8601 timestamp in UTC with millisecond precision and `Z` suffix.
/// Format: `2025-01-15T10:30:00.123Z`
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
