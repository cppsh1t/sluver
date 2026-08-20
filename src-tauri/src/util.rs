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

// ─── chat message attachment validators (ADR-0044 / plan D6) ────────────────
//
// Separate constants from the avatar set above — the caps are deliberately
// different (avatars: 1 MiB; chat attachments: images 5 MiB, text 1 MiB) and
// MUST NOT drift into each other. Like the avatar validator, the size check
// runs on the DECODED bytes (base64 inflation never reaches the ceiling
// check), and validation is authoritative server-side — the frontend
// pre-check is only for instant feedback (plan D10).

/// MIME allowlist for chat attachment images. Same three values as the
/// avatar set (webp/jpeg/png) but held independently so the two lists can
/// evolve separately.
pub const ALLOWED_ATTACHMENT_IMAGE_MIMES: [&str; 3] = ["image/webp", "image/jpeg", "image/png"];

/// MIME allowlist for chat attachment text files (plain text, Markdown,
/// CSV). All are UTF-8-decodable text formats.
pub const ALLOWED_ATTACHMENT_TEXT_MIMES: [&str; 3] =
    ["text/plain", "text/markdown", "text/csv"];

/// Hard ceiling on the DECODED image attachment payload (5 MiB, plan D6).
pub const MAX_ATTACHMENT_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// Hard ceiling on the DECODED text attachment payload (1 MiB, plan D6 —
/// 1 MiB UTF-8 is already far beyond any sane single-file context
/// injection; larger material belongs in Notes).
pub const MAX_ATTACHMENT_TEXT_BYTES: usize = 1024 * 1024;

/// Validate a chat message attachment: check the kind-specific MIME
/// allowlist, base64-decode the payload, and enforce the kind-specific
/// decoded-size ceiling (`kind = "image"`: ≤ [`MAX_ATTACHMENT_IMAGE_BYTES`];
/// `kind = "text"`: ≤ [`MAX_ATTACHMENT_TEXT_BYTES`] plus UTF-8 validity —
/// text attachments are inlined into the model input as sentinel
/// TextParts, so non-UTF-8 bytes can never be accepted). Returns the raw
/// bytes on success. Used by `append_messages` before bytes reach SQLite.
pub fn decode_and_validate_attachment(
    data_base64: &str,
    mime: &str,
    kind: &str,
) -> Result<Vec<u8>, crate::db::DbError> {
    use base64::Engine as _;

    let (allowed_mimes, max_bytes) = match kind {
        "image" => (&ALLOWED_ATTACHMENT_IMAGE_MIMES, MAX_ATTACHMENT_IMAGE_BYTES),
        "text" => (&ALLOWED_ATTACHMENT_TEXT_MIMES, MAX_ATTACHMENT_TEXT_BYTES),
        // Unknown kinds cannot reach the DB CHECK constraint — reject
        // before decoding anything.
        _ => {
            return Err(crate::db::DbError::InvalidInput(format!(
                "unknown attachment kind: {kind}"
            )))
        }
    };

    if !allowed_mimes.contains(&mime) {
        return Err(crate::db::DbError::AttachmentInvalidMime(mime.to_string()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| {
            crate::db::DbError::InvalidInput("attachment base64 decode failed".to_string())
        })?;
    if bytes.len() > max_bytes {
        return Err(crate::db::DbError::AttachmentTooLarge {
            kind: kind.to_string(),
            max_bytes,
        });
    }
    if kind == "text" && std::str::from_utf8(&bytes).is_err() {
        return Err(crate::db::DbError::AttachmentInvalidText);
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "tests/util.rs"]
mod attachment_validator_tests;
