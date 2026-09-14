# ADR-0052: Image download WebView2 fallback

**Status**: accepted.

## Context

Every agent-driven image download goes through our own reqwest client. `set_<entity>_image_from_url` and `prepare_image`'s URL mode (ADR-0048) call `download_image_bytes`, which presents a Chrome UA string over a rustls TLS fingerprint and sends no Referer, cookies, or Sec-Fetch headers. To a CDN with hotlink protection or a Cloudflare-style JA3 checkpoint, that combination reads as a bot, and the answer is 403.

The asymmetry that forced the issue: `look_at` on the same URL succeeds. Its URL route passes the raw https string through to the provider inside a `FilePart`, and the provider fetches the image server-side (ADR-0045 §3). Same image, same moment: the provider's fetch lands, ours 403s. The bytes are plainly obtainable by ordinary browser means; our transport is the only thing failing, and the agent has no way to route around it.

Requirements that shaped this decision:

- The hidden-WebView2 machinery from ADR-0049 (`create_hidden_nav_window`, the `eval_js_string` COM bridge, unconditional window close) is directly reusable; image bytes are just one more payload it can carry out.
- ADR-0049 already established the fallback pattern in the other direction (`builtin-bing` degrades from webview SERP to the legacy reqwest scrape) as an invisible internal transport choice under a frozen tool surface. Its explicit-peer-tool philosophy governs model-visible semantics; nothing about this change may leak into the tool layer.
- ADR-0048's redaction line holds: URLs are user-adjacent creative content and are never logged at any level.

## Decision

### 1. One fallback at the download choke point

`commands/image.rs` gains `download_image_bytes_with_fallback(app, url)`, wrapping the existing `download_image_bytes` (the `pub(crate)` helper `fetch_and_prepare_image` and `prepare_image` already share). The reqwest path picks up one cheap first-line mitigation: it now also sends `Referer: {origin}/`, since plenty of hotlink protection is a bare origin check. The gate: when reqwest returns HTTP 401, 403, or 429, and only those, the wrapper retries the download via `commands/search.rs::download_image_bytes_via_webview`. 5xx statuses, timeouts, and transport errors do not trigger the fallback; server errors and slow origins are not anti-bot blocks, and replaying them down a slower transport would double latency for nothing.

### 2. The WebView2 byte fetch

A hidden window from the existing `create_hidden_nav_window` machinery (label `webview-image-{uuid}`) navigates DIRECTLY to the image URL, carrying a real Edge TLS and HTTP/2 fingerprint plus the app-wide shared WebView2 cookie profile: exactly what our reqwest handshake lacked. `ExecuteScript` cannot await promises, so an async IIFE kicks off a same-origin `fetch(location.href)` and stashes `{ok, b64}` into a `window.__sluverImg` global; Rust polls it via `eval_js_string` every 500 ms. The response content-type must be `image/*`; a `text/html` body is a challenge interstitial, and it runs the same 3-attempt, 3 s sleep retry loop `fetch_url_via_webview` already uses. The window is ALWAYS closed, on every path. The base64 decodes in Rust and feeds the existing `crop_resize_encode_webp` / `fit_resize_encode_webp` pipelines unchanged; the return path stays `tauri::ipc::Response`. Nothing downstream of the download knows which transport produced the bytes.

### 3. Failure semantics and logging

A failed fallback preserves the ORIGINAL HTTP error. The model keeps seeing `fetch_image got HTTP 403 Forbidden`: the root cause, not transport noise from a second, also-failed attempt. A successful fallback logs exactly one metadata-only warn, `image.download.webview_fallback`, with `snake_case` fields and no URL in the record (ADR-0016 naming, ADR-0048 redaction).

### 4. Platform and surface scope

Windows-only, behind a `cfg` with a stub elsewhere; non-Windows keeps reqwest-only behavior and the original error, matching the Windows-first posture of ADR-0036 and ADR-0049's `builtin-baidu`. The frontend is untouched: Tauri auto-injects the `AppHandle` parameter into `fetch_and_prepare_image` / `prepare_image`, so tool semantics, the TS wrappers, and every tool description stay byte-identical. The model neither knows about nor chooses the transport.

## Consequences

- Worst-case tool-call latency grows. A blocked reqwest download already burns up to 15 s, and the fallback adds up to 3 WebView2 attempts under a 30 s page-load budget each; the theoretical ceiling for one tool call sits near 90 s. The typical fallback lands at 5 to 15 s.
- The in-page `fetch` sends `Sec-Fetch-Dest: empty`, not `image`, because it is script-initiated rather than an image load. Rare CDNs gating on that header may still 403 through the fallback; either way the original error is what surfaces.
- The webview rides the app-wide shared WebView2 cookie profile, so a Cloudflare clearance earned on any earlier navigation persists app-wide. That is a feature (one human check covers later downloads) with mild tracking implications, the same profile ADR-0049's engines ride.
- Only the two image commands benefit today (`fetch_and_prepare_image`, `prepare_image`), but the fallback sits on the shared download helper's wrapper: any future `download_image_bytes` caller inherits it for free.

## Alternatives considered

- **Provider-mediated download**, fetching images through the vision provider the way `look_at` does: rejected, it spends a vision call per stored image and couples image writes to a configured `vision` agent (ADR-0045's opt-in gate), so unconfigured Spaces would lose image tools entirely.
- **Explicit peer tool or a `viaBrowser` parameter for the model**: rejected, ADR-0049's explicit-peer-tool philosophy governs model-visible semantics, and transport choice lives below the tool layer. The precedent for an invisible internal transport fallback is `dispatch_web_search`'s Bing webview-to-reqwest degradation, which likewise changed no tool surface.
- **`WebMessageReceived` push instead of polling**: rejected, it means new COM wiring for no gain at these payload sizes; the 500 ms poll is invisible next to the page-load budget it sits under.
- **Chunked base64 transfer**: rejected, unnecessary at the ≤ 5 MiB source sizes the attachment regime allows; a single `eval` read suffices.
- **Falling back on 5xx/timeouts**: rejected, server errors and slow origins are not anti-bot blocks, and it would double latency for nothing.

## References

- ADR-0049 (hidden-WebView2 machinery; invisible webview/reqwest transport-fallback precedent; explicit-peer-tool philosophy)
- ADR-0048 (the image pipelines this rides; URL redaction the new path must keep)
- ADR-0016 (`snake_case` log fields)
- ADR-0045 §3 (`look_at` URL passthrough: the provider fetches, which is why the same URL succeeds there and 403s here)
