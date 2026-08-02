/**
 * Pure byte / blob helpers for the image IPC pipeline.
 *
 * Backend stores image columns as base64-encoded TEXT (transport-friendly
 * across the Tauri IPC bridge). This module is the single source of truth for:
 *  - the MIME allow-list (must match the Rust-side validator exactly), and
 *  - the chunked base64 encoder (avoids `String.fromCharCode` call-stack
 *    overflow on large images — V8's argument limit is ~64k, so an ~1 MB
 *    image's full byte array would crash if passed in a single call).
 *
 * No `console.*`, no DOM writes — safe to call from anywhere.
 */

/**
 * MIME types accepted by the image pipeline.
 *
 * **Keep in sync with the Rust-side allow-list** (`image_mime_allow_list`
 * in `src-tauri/src/...`). The frontend uses this both for input validation
 * (dropzone `accept`) and as a TypeScript-level constant for `<img>` `src`
 * construction when reading bytes back.
 */
export const imageMimeAllowList: readonly string[] = [
  'image/webp',
  'image/jpeg',
  'image/png',
] as const;

/**
 * Chunk size used by {@link base64Encode}. 8 KB stays well below V8's
 * ~64 k function-argument limit while keeping the number of `fromCharCode`
 * calls reasonable (a 1 MB image = ~128 iterations).
 */
const BASE64_CHUNK_SIZE = 0x2000; // 8192

/**
 * Encode a `Uint8Array` as a base64 string.
 *
 * The naive `btoa(String.fromCharCode(...bytes))` blows the call stack for
 * arrays above a few tens of KB; this slices through the input in 8 KB
 * windows, concatenating the resulting strings before a single `btoa()`.
 *
 * Pure: no I/O, no global mutation. Safe to call from render bodies.
 */
export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    // 8 KB chunks stay well below V8's spread/apply argument limit (~64 k).
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Sniff the real image format from raw bytes via magic-byte signatures.
 *
 * Defense-in-depth against mismatches between stored `image_mime` metadata
 * and the actual byte content. The primary scenario: `canvas.toBlob(…,
 * "image/webp")` silently falls back to PNG on Safari/WebKitGTK (which lack
 * WebP encoding support), so the bytes may be PNG even when the write path
 * believed it was producing WebP. Sniffing 12 bytes is O(1) and more
 * trustworthy than any metadata field.
 *
 * Supported: JPEG, PNG, WebP. Falls back to `"image/webp"` (the default
 * output format of the crop dialog) for anything unrecognised.
 */
function sniffImageMime(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  // JPEG: FF D8 FF
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 (‰PNG)
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47)
    return "image/png";
  // WebP: RIFF….WEBP (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
  if (
    u[0] === 0x52 &&
    u[1] === 0x46 &&
    u[2] === 0x46 &&
    u[8] === 0x57 &&
    u[9] === 0x45 &&
    u[10] === 0x42 &&
    u[11] === 0x50
  )
    return "image/webp";
  return "image/webp";
}

/**
 * Wrap raw image bytes in a blob URL suitable for an `<img src=…>`.
 *
 * The MIME type is **sniffed from the bytes themselves** (see {@link
 * sniffImageMime}) rather than trusted from a caller-supplied value — this
 * keeps the function self-contained and immune to stale DB metadata or
 * incorrect write-path assumptions.
 *
 * Caller is responsible for revoking the URL via `URL.revokeObjectURL(url)`
 * once the image is no longer mounted (e.g. in a `useEffect` cleanup) —
 * failure to do so leaks the underlying blob until page reload.
 */
export function arrayBufferToBlobUrl(buf: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([buf], { type: sniffImageMime(buf) }));
}
