use super::*;

// NOTE: no explicit `use base64::Engine as _;` needed here — the glob from
// the parent module brings the anonymous trait import into scope.

// No-network tests: every case drives the bytes source only. The URL source
// shares `parse_http_url` + `download_image_bytes` with
// `fetch_and_prepare_image`, whose network path is production-only — the
// same no-mock-runtime discipline as the rest of the crate.

/// Drive an async `do_prepare_image` call on a throwaway current-thread
/// tokio runtime (same pattern as tests/shell.rs). The bytes path never
/// actually awaits, but the fn is async for the URL source.
fn prepare(input: PrepareImageInput) -> Result<Vec<u8>, DbError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(do_prepare_image(input))
}

/// Deterministic splitmix32 noise image. Near-uniform noise is effectively
/// incompressible, which pins lossless-WebP output sizes to ≈ 3 bytes/pixel
/// — the property the progressive-halving test relies on.
fn noise_image(w: u32, h: u32) -> image::DynamicImage {
    let mut state: u32 = 0x1234_5678;
    let buf = image::RgbImage::from_fn(w, h, |_x, _y| {
        // splitmix32 — cheap high-quality mixer, no `rand` dep.
        state = state.wrapping_add(0x9E37_79B9);
        let mut z = state;
        z ^= z >> 16;
        z = z.wrapping_mul(0x21F0_AAAD);
        z ^= z >> 15;
        z = z.wrapping_mul(0x735A_2D97);
        z ^= z >> 15;
        image::Rgb([(z >> 24) as u8, (z >> 16) as u8, (z >> 8) as u8])
    });
    image::DynamicImage::ImageRgb8(buf)
}

/// Smooth 2-axis gradient — highly compressible, so FIT-mode outputs stay
/// far below the 1 MiB ceiling and never trigger the halving loop (the
/// aspect/cap math is then assertable in isolation).
fn gradient_image(w: u32, h: u32) -> image::DynamicImage {
    let buf = image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, 128])
    });
    image::DynamicImage::ImageRgb8(buf)
}

/// PNG-encode an in-memory image (same API as tests/export.rs uses).
fn png_bytes(img: &image::DynamicImage) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .expect("png encode");
    buf.into_inner()
}

/// Bytes-source input builder.
fn b64_input(
    png: &[u8],
    width: Option<u32>,
    height: Option<u32>,
    max_dimension: Option<u32>,
) -> PrepareImageInput {
    PrepareImageInput {
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(png)),
        url: None,
        width,
        height,
        max_dimension,
    }
}

// ── happy paths ────────────────────────────────────────────────────────────

/// CROP mode: 1200×900 noise PNG → (300, 400) crop spec → WebP output at
/// exactly 300×400, under the 1 MiB ceiling.
#[test]
fn crop_mode_resizes_to_exact_dimensions() {
    let png = png_bytes(&noise_image(1200, 900));
    let out = prepare(b64_input(&png, Some(300), Some(400), None)).expect("crop mode succeeds");

    assert!(out.len() <= crate::util::MAX_IMAGE_BYTES);
    assert!(matches!(
        image::guess_format(&out),
        Ok(image::ImageFormat::WebP)
    ));
    let decoded = image::load_from_memory(&out).expect("output decodes");
    assert_eq!((decoded.width(), decoded.height()), (300, 400));
}

/// FIT mode: 2000×1000 gradient → max_dimension 1600 → longest side capped
/// at 1600, aspect preserved (exact 2:1).
#[test]
fn fit_mode_caps_longest_side_and_keeps_aspect() {
    let png = png_bytes(&gradient_image(2000, 1000));
    let out = prepare(b64_input(&png, None, None, Some(1600))).expect("fit mode succeeds");

    assert!(out.len() <= crate::util::MAX_IMAGE_BYTES);
    let decoded = image::load_from_memory(&out).expect("output decodes");
    assert_eq!((decoded.width(), decoded.height()), (1600, 800));
    // Aspect preserved within rounding (2.0 exact for 2000×1000 → 1600×800).
    let ratio = decoded.width() as f64 / decoded.height() as f64;
    assert!((ratio - 2.0).abs() < 0.01, "aspect drifted: {ratio}");
}

/// FIT mode on an already-small image: dimensions unchanged (no upscale,
/// no downscale).
#[test]
fn fit_mode_leaves_small_images_untouched() {
    let png = png_bytes(&gradient_image(400, 300));
    let out = prepare(b64_input(&png, None, None, Some(1600))).expect("fit mode succeeds");
    let decoded = image::load_from_memory(&out).expect("output decodes");
    assert_eq!((decoded.width(), decoded.height()), (400, 300));
}

/// FIT mode progressive halving: 1280×1280 near-incompressible noise
/// encodes well over 1 MiB (≈ 4.9 MB, forcing the loop), 640×640 (≈ 1.2 MB)
/// still exceeds 1 MiB, 320×320 (≈ 307 KB) fits. The input PNG itself stays
/// under the 5 MiB attachment cap (≈ 4.9 MB) so the bytes source accepts it.
#[test]
fn fit_mode_progressively_halves_until_under_ceiling() {
    let png = png_bytes(&noise_image(1280, 1280));
    let out = prepare(b64_input(&png, None, None, Some(1280))).expect("fit mode succeeds");

    assert!(out.len() <= crate::util::MAX_IMAGE_BYTES);
    let decoded = image::load_from_memory(&out).expect("output decodes");
    assert_eq!((decoded.width(), decoded.height()), (320, 320));
}

// ── validation ─────────────────────────────────────────────────────────────

/// Source XOR: both sources or neither → `Internal` error.
#[test]
fn source_must_be_exactly_one() {
    // Both.
    let png = png_bytes(&gradient_image(8, 8));
    let mut input = b64_input(&png, None, None, Some(64));
    input.url = Some("https://example.com/a.png".into());
    let err = prepare(input).expect_err("both sources must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("not both")),
        "unexpected error: {err:?}"
    );

    // Neither.
    let err = prepare(PrepareImageInput {
        data_base64: None,
        url: None,
        width: Some(300),
        height: Some(400),
        max_dimension: None,
    })
    .expect_err("no source must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("no source")),
        "unexpected error: {err:?}"
    );
}

/// Mode XOR: both modes, neither mode, and a half crop spec all error.
#[test]
fn mode_must_be_exactly_one() {
    let png = png_bytes(&gradient_image(8, 8));

    // Both modes.
    let err = prepare(b64_input(&png, Some(300), Some(400), Some(64)))
        .expect_err("both modes must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("not both")),
        "unexpected error: {err:?}"
    );

    // Neither mode.
    let err = prepare(b64_input(&png, None, None, None)).expect_err("no mode must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("no mode")),
        "unexpected error: {err:?}"
    );

    // Width without height.
    let err = prepare(b64_input(&png, Some(300), None, None))
        .expect_err("half crop spec must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("both width and height")),
        "unexpected error: {err:?}"
    );
}

/// Non-positive dimensions are rejected.
#[test]
fn zero_dimensions_are_rejected() {
    let png = png_bytes(&gradient_image(8, 8));

    let err = prepare(b64_input(&png, Some(0), Some(400), None)).expect_err("zero width must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("positive")),
        "unexpected error: {err:?}"
    );

    let err =
        prepare(b64_input(&png, None, None, Some(0))).expect_err("zero max_dimension must fail");
    assert!(
        matches!(err, DbError::Internal(ref msg) if msg.contains("positive")),
        "unexpected error: {err:?}"
    );
}

/// A base64 payload decoding to > 5 MiB is rejected before any image work —
/// the decoded-length cap mirrors the attachment ingest path (the bytes
/// source IS a hydrated chat attachment).
#[test]
fn oversize_base64_input_is_rejected() {
    let raw = vec![0u8; crate::util::MAX_ATTACHMENT_IMAGE_BYTES + 1];
    let input = PrepareImageInput {
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(raw)),
        url: None,
        width: Some(300),
        height: Some(400),
        max_dimension: None,
    };
    let err = prepare(input).expect_err("oversize input must fail");
    assert!(
        matches!(err, DbError::AttachmentTooLarge { .. }),
        "unexpected error: {err:?}"
    );
}
