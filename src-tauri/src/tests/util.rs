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
