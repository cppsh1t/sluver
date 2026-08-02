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

// ─── per-entity image upload helpers ─────────────────────────────────────────
//
// Shared by all 24 `*_image` IPC commands across `commands/{world,character,
// element,event,novel}.rs`. Centralizing the allowlist + size ceiling here
// keeps the validation rule single-sourced — the spec for these commands is
// intentionally strict (webp/jpeg/png only, ≤ 1 MiB after decode).

/// MIME allowlist for per-entity images. The frontend is expected to re-encode
/// user-selected files into one of these three formats before uploading;
/// anything else is rejected as `INVALID_IMAGE`.
pub const ALLOWED_IMAGE_MIMES: [&str; 3] = ["image/webp", "image/jpeg", "image/png"];

/// Hard ceiling on the decoded payload size (1 MiB). This is a defense-in-
/// depth upper bound — frontend pre-resize is the primary control. Anything
/// larger surfaces as `INVALID_IMAGE` (no distinct "too large" code, since
/// the user-visible remedy is the same: pick a smaller image).
pub const MAX_IMAGE_BYTES: usize = 1024 * 1024;

/// Validate the MIME allowlist, base64-decode the payload, and enforce the
/// 1 MiB decoded-size ceiling. Returns the raw bytes on success, or
/// [`DbError::InvalidImage`](crate::db::DbError::InvalidImage) on any failure
/// (bad MIME, malformed base64, oversize). Used by every `update_*_image`
/// command before the bytes reach SQLite.
pub fn decode_and_validate_image(
    image_base64: &str,
    image_mime: &str,
) -> Result<Vec<u8>, crate::db::DbError> {
    use base64::Engine as _;

    if !ALLOWED_IMAGE_MIMES.contains(&image_mime) {
        return Err(crate::db::DbError::InvalidImage);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|_| crate::db::DbError::InvalidImage)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(crate::db::DbError::InvalidImage);
    }
    Ok(bytes)
}
