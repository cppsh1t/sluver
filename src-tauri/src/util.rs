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
mod attachment_validator_tests {
    use super::*;
    use base64::Engine as _;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Minimal PNG-magic-prefixed buffer for image fixtures (the validator
    /// checks MIME + size only — no magic-byte sniff server-side, plan D10).
    fn png_bytes(len: usize) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.resize(len, 0xAB);
        v
    }

    #[test]
    fn image_exactly_5mib_passes() {
        let bytes = png_bytes(MAX_ATTACHMENT_IMAGE_BYTES);
        let out = decode_and_validate_attachment(&b64(&bytes), "image/png", "image")
            .expect("exactly 5 MiB must pass");
        assert_eq!(out.len(), MAX_ATTACHMENT_IMAGE_BYTES);
    }

    #[test]
    fn image_one_byte_over_5mib_fails() {
        let bytes = png_bytes(MAX_ATTACHMENT_IMAGE_BYTES + 1);
        let err = decode_and_validate_attachment(&b64(&bytes), "image/png", "image")
            .expect_err("5 MiB + 1 must fail");
        assert!(matches!(
            err,
            crate::db::DbError::AttachmentTooLarge { kind, max_bytes }
                if kind == "image" && max_bytes == MAX_ATTACHMENT_IMAGE_BYTES
        ));
    }

    #[test]
    fn image_wrong_mime_fails() {
        let err = decode_and_validate_attachment(&b64(b"whatever"), "image/gif", "image")
            .expect_err("image/gif is not in the allowlist");
        assert!(matches!(
            err,
            crate::db::DbError::AttachmentInvalidMime(mime) if mime == "image/gif"
        ));
    }

    #[test]
    fn image_wrong_kind_mime_family_fails() {
        // An image MIME under kind "text" is rejected by the text allowlist.
        let err = decode_and_validate_attachment(&b64(b"hi"), "image/png", "text")
            .expect_err("image mime is not a text mime");
        assert!(matches!(
            err,
            crate::db::DbError::AttachmentInvalidMime(mime) if mime == "image/png"
        ));
    }

    #[test]
    fn text_valid_utf8_passes() {
        let bytes = b"# outline\n\xE4\xB8\x96\xE7\x95\x8C".to_vec(); // UTF-8 Chinese
        let out = decode_and_validate_attachment(&b64(&bytes), "text/markdown", "text")
            .expect("valid UTF-8 text must pass");
        assert_eq!(out, bytes);
    }

    #[test]
    fn text_non_utf8_fails() {
        // 0xFF is never valid UTF-8.
        let bytes = vec![0xFF, 0xFE, 0x00];
        let err = decode_and_validate_attachment(&b64(&bytes), "text/plain", "text")
            .expect_err("non-UTF-8 text must fail");
        assert!(matches!(err, crate::db::DbError::AttachmentInvalidText));
    }

    #[test]
    fn text_one_byte_over_1mib_fails() {
        let bytes = vec![b'x'; MAX_ATTACHMENT_TEXT_BYTES + 1];
        let err = decode_and_validate_attachment(&b64(&bytes), "text/csv", "text")
            .expect_err("1 MiB + 1 must fail");
        assert!(matches!(
            err,
            crate::db::DbError::AttachmentTooLarge { kind, max_bytes }
                if kind == "text" && max_bytes == MAX_ATTACHMENT_TEXT_BYTES
        ));
    }

    #[test]
    fn base64_full_alphabet_with_padding_round_trips() {
        // 0xFB 0xEF 0xBE 0xFF encode to a string containing '+' and '/'
        // (values 62/63); the 5th byte forces one '=' pad char. The
        // STANDARD engine must round-trip both.
        let bytes = vec![0xFB, 0xEF, 0xBE, 0xFF, 0x00];
        let encoded = b64(&bytes);
        assert!(encoded.contains('+') && encoded.contains('/'));
        assert!(encoded.ends_with('='));
        let out = decode_and_validate_attachment(&encoded, "image/webp", "image")
            .expect("full alphabet + padding must decode");
        assert_eq!(out, bytes);
    }

    #[test]
    fn malformed_base64_fails_as_invalid_input() {
        let err = decode_and_validate_attachment("!!not-base64!!", "image/png", "image")
            .expect_err("malformed base64 must fail");
        assert!(matches!(
            err,
            crate::db::DbError::InvalidInput(ref msg) if msg.contains("base64")
        ));
    }

    #[test]
    fn unknown_kind_fails_as_invalid_input() {
        let err = decode_and_validate_attachment(&b64(b"x"), "image/png", "video")
            .expect_err("unknown kind must fail");
        assert!(matches!(
            err,
            crate::db::DbError::InvalidInput(ref msg) if msg.contains("video")
        ));
    }
}
