// Image preparation bridge — turns raw image bytes (chat attachments, ≤ 5 MiB)
// or a remote URL into the app's canonical entity-image format: lossless
// WebP, ≤ 1 MiB (`util::MAX_IMAGE_BYTES`).
//
// This bridges two size regimes: chat attachment images are ingested up to
// 5 MiB (`message_attachments` sidecar blobs, ADR-0044), while every entity
// `image_blob` column caps at 1 MiB and expects WebP. `prepare_image` is
// what lets the frontend move an attachment (or any web image) into an
// entity image slot without a client-side re-encode.
//
// Two mutually exclusive modes:
//   - CROP (`width` + `height`): center-crop to the target aspect +
//     Lanczos3 resize to the exact size — the exact pipeline of
//     `fetch_and_prepare_image` (commands/search.rs), shared via
//     [`crop_resize_encode_webp`]. Used by the 8 card entities (world /
//     character / phase / location / item / lore / event / novel) whose
//     image slots have fixed aspect specs supplied by the TS caller.
//   - FIT (`max_dimension`): downscale proportionally (aspect preserved) so
//     the longest side ≤ `max_dimension`, then progressively halve both
//     dimensions + re-encode until the output fits the 1 MiB ceiling. Used
//     by scene gallery images (`scene_images`), which have no crop spec.
//
// ## Shared helpers
//
// [`parse_http_url`], [`download_image_bytes`], and
// [`crop_resize_encode_webp`] are `pub(crate)` and also called by
// `fetch_and_prepare_image` — the two commands share one download + crop
// pipeline and cannot drift.
//
// ## Redaction
//
// Base64 payloads are user creative content; URLs are research targets
// (⚠️ TRACE-only tier per AGENTS.md redaction policy). `skip_all` +
// length-only fields, consistent with `fetch_and_prepare_image`. Image
// bytes, base64 payloads, and full URLs are NEVER logged at any level.
//
// ## Errors
//
// Argument violations (wrong source/mode combination, non-positive sizes)
// surface as `DbError::Internal(String)` — the same arg-error style as
// `fetch_and_prepare_image` (dynamic message, collapses to
// `INTERNAL_ERROR`). A > 5 MiB decoded payload reuses
// `DbError::AttachmentTooLarge` — the bytes source IS a hydrated chat
// attachment, so it gets the same stable code + translation as the ingest
// path. An output that cannot be squeezed under 1 MiB surfaces as
// `DbError::InvalidImage`, the same code the direct upload path uses.

use base64::Engine as _;
use serde::Deserialize;
use url::Url;

use crate::db::DbError;

// ═══════════════════════════════════════════════════════════════════════════
// DTOs
// ═══════════════════════════════════════════════════════════════════════════

/// Input for [`prepare_image`]. Exactly one source (`data_base64` XOR `url`)
/// and exactly one mode (`width`+`height` XOR `max_dimension`) must be
/// provided — violations surface as `INTERNAL_ERROR` with a clear message.
///
/// Transient DTO (not a persisted entity), so it lives here rather than
/// under `models/`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareImageInput {
    /// Base64-encoded source image (typically a hydrated chat attachment,
    /// ≤ 5 MiB decoded — `util::MAX_ATTACHMENT_IMAGE_BYTES`).
    pub data_base64: Option<String>,
    /// Remote http(s) image URL (same download path as
    /// `fetch_and_prepare_image`).
    pub url: Option<String>,
    /// CROP mode target width (must be paired with `height`).
    pub width: Option<u32>,
    /// CROP mode target height (must be paired with `width`).
    pub height: Option<u32>,
    /// FIT mode ceiling for the longest side (aspect preserved).
    pub max_dimension: Option<u32>,
}

/// Validated transformation mode (exactly one must be chosen by the caller).
enum PrepareMode {
    /// Center-crop to the `width`:`height` aspect + Lanczos3 resize to
    /// exactly that size. Used by the card entities whose image slots have
    /// fixed aspect specs.
    Crop { width: u32, height: u32 },
    /// Proportionally downscale so the longest side ≤ `max_dimension`
    /// (aspect preserved). Used by scene gallery images (arbitrary
    /// aspects).
    Fit { max_dimension: u32 },
}

// ═══════════════════════════════════════════════════════════════════════════
// prepare_image
// ═══════════════════════════════════════════════════════════════════════════

/// Transform raw image bytes or a remote URL into the canonical entity-image
/// format (lossless WebP, ≤ 1 MiB).
///
/// **Pipeline:**
/// 1. Validate: exactly one source (`data_base64` XOR `url`) and exactly one
///    mode (`width`+`height` XOR `max_dimension`); all provided sizes
///    positive
/// 2. Acquire bytes: base64-decode (≤ 5 MiB decoded, the chat-attachment
///    cap) or `reqwest` GET (shared helper, same Chrome UA + timeout as
///    `fetch_and_prepare_image`)
/// 3. `image::load_from_memory` auto-detects format (JPEG / PNG / WebP)
/// 4. CROP: shared center-crop + Lanczos3 `resize_exact` + lossless WebP
///    helper (identical to `fetch_and_prepare_image`); FIT: proportional
///    downscale + progressive-halving loop (see [`fit_resize_encode_webp`])
/// 5. Size ceiling (`util::MAX_IMAGE_BYTES` = 1 MiB) — an incompressible
///    output surfaces as `INVALID_IMAGE`
///
/// **Why the 5 MiB input cap is NOT the 1 MiB `MAX_IMAGE_BYTES`:** that
/// constant is the OUTPUT ceiling. This command exists precisely to compress
/// 5 MiB attachments down to it — enforcing 1 MiB on input would reject the
/// very payloads it is meant to bridge.
///
/// Output is returned as raw bytes via `tauri::ipc::Response` — bypasses
/// JSON serialization on the wire, mirroring `fetch_and_prepare_image` /
/// `get_*_image`. The frontend reads it as `ArrayBuffer` and feeds it to
/// `update<Entity>Image(bytes, "image/webp")`.
///
/// **Redaction:** `skip_all` + length-only fields (`source`, `input_bytes`
/// or `url_length`, `output_bytes`) — the base64 payload and URL string are
/// user creative content and are NEVER logged at any level.
#[tracing::instrument(skip_all, fields(source, input_bytes, url_length, output_bytes))]
#[tauri::command]
pub async fn prepare_image(input: PrepareImageInput) -> Result<tauri::ipc::Response, DbError> {
    let out_bytes = do_prepare_image(input).await?;
    tracing::debug!("prepare_image completed");
    Ok(tauri::ipc::Response::new(out_bytes))
}

/// Core pipeline behind [`prepare_image`] — everything except the
/// `tauri::ipc::Response` wrap, split out per the crate's `do_*` convention
/// (no mock runtime; tests drive this directly with the bytes source, so no
/// network is ever touched).
///
/// Span field recording (`source`, `input_bytes`/`url_length`,
/// `output_bytes`) happens here against `Span::current()`: in production
/// that is the `#[tracing::instrument]` span of the command wrapper (this
/// fn is awaited inside its body); in tests there is no active span and
/// recording is a no-op.
pub(crate) async fn do_prepare_image(input: PrepareImageInput) -> Result<Vec<u8>, DbError> {
    // ── 1. Validate: exactly one source, exactly one mode ──────────────
    //
    // Mirrors `fetch_and_prepare_image`'s arg-error style — a clear
    // `Internal` message per violation. All size fields are u32, so
    // "positive" is the only finiteness check needed (no f64 inputs).
    let (source_b64, source_url) = (input.data_base64, input.url);
    match (&source_b64, &source_url) {
        (Some(_), Some(_)) => {
            return Err(DbError::Internal(
                "conflicting sources: provide either data_base64 or url, not both".into(),
            ));
        }
        (None, None) => {
            return Err(DbError::Internal(
                "no source specified: provide either data_base64 or url".into(),
            ));
        }
        _ => {}
    }
    let mode = {
        let has_crop_spec = input.width.is_some() || input.height.is_some();
        let has_fit = input.max_dimension.is_some();
        if has_crop_spec && has_fit {
            return Err(DbError::Internal(
                "conflicting modes: provide either width+height (crop) or max_dimension (fit), not both"
                    .into(),
            ));
        }
        if !has_crop_spec && !has_fit {
            return Err(DbError::Internal(
                "no mode specified: provide either width+height (crop) or max_dimension (fit)"
                    .into(),
            ));
        }
        if let Some(max_dimension) = input.max_dimension {
            if max_dimension == 0 {
                return Err(DbError::Internal("max_dimension must be positive".into()));
            }
            PrepareMode::Fit { max_dimension }
        } else {
            let (Some(width), Some(height)) = (input.width, input.height) else {
                return Err(DbError::Internal(
                    "crop mode requires both width and height".into(),
                ));
            };
            if width == 0 || height == 0 {
                return Err(DbError::Internal("width and height must be positive".into()));
            }
            PrepareMode::Crop { width, height }
        }
    };

    // ── 2. Acquire the source bytes ────────────────────────────────────
    let bytes = if let Some(data_base64) = source_b64 {
        tracing::Span::current().record("source", "bytes");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&data_base64)
            .map_err(|_| DbError::Internal("image base64 decode failed".into()))?;
        // 5 MiB input ceiling — the chat-attachment cap (the bytes source
        // IS a hydrated attachment, ADR-0044). See the command doc for why
        // this is deliberately NOT the 1 MiB `MAX_IMAGE_BYTES`.
        if decoded.len() > crate::util::MAX_ATTACHMENT_IMAGE_BYTES {
            return Err(DbError::AttachmentTooLarge {
                kind: "image".to_string(),
                max_bytes: crate::util::MAX_ATTACHMENT_IMAGE_BYTES,
            });
        }
        tracing::Span::current().record("input_bytes", decoded.len());
        decoded
    } else {
        let url = source_url.expect("validated above: exactly one source");
        tracing::Span::current().record("source", "url");
        tracing::Span::current().record("url_length", url.len());
        let target = parse_http_url(&url)?;
        download_image_bytes(&target).await?
    };

    // ── 3. Decode (auto-detect format, same as fetch_and_prepare_image) ─
    let img = image::load_from_memory(&bytes)
        .map_err(|e| DbError::Internal(format!("image decode failed: {e}")))?;

    // ── 4. Transform per mode ──────────────────────────────────────────
    let out_bytes = match mode {
        PrepareMode::Crop { width, height } => {
            // The target aspect derives from the crop spec itself, so the
            // center-crop frame and the final resize dimensions agree (no
            // distortion). Both are positive u32 → the ratio is finite.
            let out = crop_resize_encode_webp(&img, width as f64 / height as f64, width, height)?;
            // Output ceiling — direct guard (crop mode has no fallback
            // loop): at the fixed card-image sizes (300×400 / 640×360)
            // lossless WebP is far below 1 MiB, but guard against
            // pathological inputs (same rationale as
            // `fetch_and_prepare_image`'s step 7).
            if out.len() > crate::util::MAX_IMAGE_BYTES {
                return Err(DbError::InvalidImage);
            }
            out
        }
        // Fit mode consumes `img` by value (it may downscale in place
        // through the halving loop); the crop arm only borrows — the arms
        // are mutually exclusive, so the borrow checker is satisfied.
        PrepareMode::Fit { max_dimension } => fit_resize_encode_webp(img, max_dimension)?,
    };

    tracing::Span::current().record("output_bytes", out_bytes.len());
    Ok(out_bytes)
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers (also used by search.rs::fetch_and_prepare_image)
// ═══════════════════════════════════════════════════════════════════════════

/// Parse a URL and enforce the http(s)-only scheme guard.
///
/// Extracted from `fetch_and_prepare_image` so its URL pipeline and the URL
/// source of [`do_prepare_image`] cannot drift. Same rationale as
/// `fetch_url_via_webview`: the `image` crate is happy to decode `file:///`
/// and `data:` URLs, which would expose local file contents to the agent /
/// frontend.
pub(crate) fn parse_http_url(url: &str) -> Result<Url, DbError> {
    let target = Url::parse(url)
        .map_err(|e| DbError::Internal(format!("invalid URL: {e}")))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(DbError::Internal("only http(s) URLs are supported".into()));
    }
    Ok(target)
}

/// Download the bytes behind an already-scheme-guarded http(s) image URL.
///
/// Extracted verbatim from `fetch_and_prepare_image` (commands/search.rs)
/// so both commands share one download path — same Chrome UA (mandatory:
/// most CDNs instantly block non-browser UAs), same 15s timeout
/// (`REQUEST_TIMEOUT_SECS`), same image-accept header. Callers run
/// [`parse_http_url`] BEFORE downloading; passing a `&Url` here (rather
/// than the raw string) guarantees the scheme guard cannot be skipped.
pub(crate) async fn download_image_bytes(target: &Url) -> Result<Vec<u8>, DbError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            crate::commands::search::REQUEST_TIMEOUT_SECS,
        ))
        .build()
        .map_err(|e| DbError::Internal(format!("fetch_image client build: {e}")))?;

    let resp = client
        // `IntoUrl` is not implemented for `&Url` — pass an owned clone
        // (semantically identical to the original `client.get(&url)`:
        // reqwest re-parses strings into the same Url anyway).
        .get(target.clone())
        .header(
            reqwest::header::USER_AGENT,
            crate::commands::search::CHROME_UA,
        )
        .header(
            reqwest::header::ACCEPT,
            "image/png,image/jpeg,image/webp,image/*;q=0.8,*/*;q=0.5",
        )
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("fetch_image request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "fetch_image got HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| DbError::Internal(format!("fetch_image read body failed: {e}")))?;
    Ok(bytes.to_vec())
}

/// Center-crop to `aspect`, Lanczos3-resize to exactly
/// `output_width × output_height`, lossless-WebP encode.
///
/// Extracted verbatim from `fetch_and_prepare_image` (its steps 4-6) so the
/// agent's URL pipeline and CROP mode share one crop pipeline. `aspect` is
/// a separate parameter (not derived from the output dims) because
/// `fetch_and_prepare_image`'s callers may legitimately supply an aspect
/// that differs from `output_width/output_height`.
pub(crate) fn crop_resize_encode_webp(
    img: &image::DynamicImage,
    aspect: f64,
    output_width: u32,
    output_height: u32,
) -> Result<Vec<u8>, DbError> {
    // ── Center-crop to target aspect ───────────────────────────────────
    //
    // Cuts the longer dimension so the surviving frame exactly matches the
    // target aspect. Half the excess is removed from each side, keeping the
    // source image's center in the cropped frame. For portrait-orientation
    // sources with a centered subject (typical wiki/baike head-shots), this
    // keeps the subject intact. Landscape sources will have their sides
    // cut, which is acceptable for the use case (agent can pick a
    // different URL).
    let (iw, ih) = (img.width(), img.height());
    let src_aspect = iw as f64 / ih as f64;
    let (crop_w, crop_h, crop_x, crop_y) = if src_aspect > aspect {
        // Source is wider than target → crop horizontally.
        let new_w = (((ih as f64) * aspect).round() as u32).min(iw).max(1);
        let x = (iw - new_w) / 2;
        (new_w, ih, x, 0u32)
    } else {
        // Source is taller than (or equal to) target → crop vertically.
        let new_h = (((iw as f64) / aspect).round() as u32).min(ih).max(1);
        let y = (ih - new_h) / 2;
        (iw, new_h, 0, y)
    };
    let cropped = img.crop_imm(crop_x, crop_y, crop_w, crop_h);

    // ── Lanczos3 resize to exact output dimensions ─────────────────────
    //
    // After center-crop the source aspect ≈ target aspect, so resize
    // introduces no further distortion — just smoothing/scaling. Lanczos3
    // is the highest-quality filter in `image`; slower than Catmull-Rom
    // but fine for one-shot 300×400 / 640×360 work (sub-10ms on modern
    // CPUs).
    let resized = cropped.resize_exact(
        output_width,
        output_height,
        image::imageops::FilterType::Lanczos3,
    );

    encode_lossless_webp(&resized)
}

/// FIT-mode pipeline: keep the aspect ratio, cap the longest side at
/// `max_dimension`, lossless-WebP encode, then progressively halve both
/// dimensions + re-encode until the output fits the 1 MiB
/// [`util::MAX_IMAGE_BYTES`](crate::util::MAX_IMAGE_BYTES) ceiling or the
/// longest side drops below 512px (beyond which further shrinking would
/// destroy the image without meaningfully reducing bytes — a 512² lossless
/// encode that still exceeds 1 MiB is pathological noise, not a photo).
/// If the ceiling still cannot be met, [`DbError::InvalidImage`] surfaces —
/// the same code the direct upload path uses.
fn fit_resize_encode_webp(
    img: image::DynamicImage,
    max_dimension: u32,
) -> Result<Vec<u8>, DbError> {
    // ── Proportional downscale to the max_dimension ceiling ────────────
    //
    // Only when the longest side exceeds the cap: the longest side maps to
    // exactly `max_dimension`, the other side scales by the same factor
    // (aspect preserved up to per-side rounding). `.max(1)` guards a
    // pathological 1px side rounding down to 0.
    let (iw, ih) = (img.width(), img.height());
    let mut current = if iw.max(ih) > max_dimension {
        let scale = max_dimension as f64 / iw.max(ih) as f64;
        let new_w = ((iw as f64 * scale).round() as u32).max(1);
        let new_h = ((ih as f64 * scale).round() as u32).max(1);
        img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // ── Progressive halving loop ───────────────────────────────────────
    //
    // Halving is the only lever the lossless-only encoder gives us against
    // a size-dense image (the `webp` crate + libwebp-sys needed for lossy
    // is deliberately NOT a dependency — see the Cargo.toml image note).
    // Each iteration quarters the pixel count, so the loop is bounded by
    // ~log4(pixels) iterations even in the worst case.
    loop {
        let out = encode_lossless_webp(&current)?;
        if out.len() <= crate::util::MAX_IMAGE_BYTES {
            return Ok(out);
        }
        if current.width().max(current.height()) < 512 {
            return Err(DbError::InvalidImage);
        }
        let (w, h) = (current.width(), current.height());
        current = current.resize_exact(
            (w / 2).max(1),
            (h / 2).max(1),
            image::imageops::FilterType::Lanczos3,
        );
    }
}

/// Lossless-WebP encode via `image::codecs::webp::WebPEncoder` (pure Rust,
/// no libwebp C dependency — lossy encoding would require the separate
/// `webp` crate). Shared by the CROP helper and the FIT halving loop.
fn encode_lossless_webp(img: &image::DynamicImage) -> Result<Vec<u8>, DbError> {
    use image::ImageEncoder;
    use std::io::Cursor;

    let mut buf = Cursor::new(Vec::new());
    image::codecs::webp::WebPEncoder::new_lossless(&mut buf)
        .write_image(
            img.as_bytes(),
            img.width(),
            img.height(),
            img.color().into(),
        )
        .map_err(|e| DbError::Internal(format!("webp encode failed: {e}")))?;
    Ok(buf.into_inner())
}

#[cfg(test)]
#[path = "tests/image.rs"]
mod image_tests;
