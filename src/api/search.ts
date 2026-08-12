/**
 * Web search IPC API.
 *
 * Backed by the `search_web` Rust command, which scrapes Bing's HTML SERP
 * server-side (CORS blocks browser-context requests). No Space / World
 * scope — this is a global read-only utility.
 */

import { call } from './client';

/** A single web search result. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search the public web via Bing. `locale` drives Bing's `Accept-Language`
 * header (e.g. `"zh-CN"`, `"en"`). Returns up to `maxResults` entries
 * (default 5, capped at 20) each with a title, URL, and short snippet.
 */
export function searchWeb(
  query: string,
  locale: string,
  maxResults?: number,
): Promise<SearchResult[]> {
  return call<SearchResult[]>('search_web', { query, locale, maxResults });
}

// ─── URL fetch ──────────────────────────────────────────────────────────────

/** Format of `FetchedPage.content`. See `FetchedPage` for details. */
export type ContentFormat = "markdown" | "text";

/** A fetched web page's extracted content. */
export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  /** Page title (from `<title>` or Readability extraction). */
  title: string | null;
  /**
   * Main content. Format is identified by `contentFormat`:
   *
   * - `"markdown"` — Readability extracted an article and converted it to
   *   Markdown. **Inline images are preserved at their original document
   *   position** as `![alt](url)`, so a biographical article might read
   *   `李白（701-762）... ![李白肖像](https://upload.wikimedia.org/.../Li_Bai.jpg) ...`.
   *   The agent can correlate each image with surrounding prose to pick the
   *   right URL for entity image assignment.
   * - `"text"` — Fallback plain-text dump (server error pages, `<pre>`-wrapped
   *   text, non-article HTML). No image information is present.
   *
   * Truncated to `maxLength` chars.
   */
  content: string;
  /** Format of `content` — `"markdown"` (Readability) or `"text"` (fallback). */
  contentFormat: ContentFormat;
  /** Author byline, if detected. */
  author: string | null;
  /** Short excerpt / meta description, if detected. */
  excerpt: string | null;
  /** Publication timestamp (ISO string), if detected. */
  publishedAt: string | null;
  /**
   * Best "hero" image URL extracted by Readability from JSON-LD / OpenGraph /
   * Twitter Card meta tags (`og:image`, `twitter:image`, etc.). Single
   * absolute URL when present.
   *
   * Distinct from inline `![](url)` entries in `content` (when Markdown):
   * `mainImage` is the page's designated cover/hero image, while inline
   * images are body illustrations. For entity image assignment both are
   * valid candidates — `mainImage` is typically the strongest signal for
   * biographical / wiki-style pages.
   */
  mainImage: string | null;
}

/**
 * Fetch a URL and extract its main readable content via Readability.
 * `locale` drives the `Accept-Language` header. Returns up to `maxLength`
 * chars of content (default 10_000, capped at 50_000).
 */
export function fetchUrl(
  url: string,
  locale: string,
  maxLength?: number,
): Promise<FetchedPage> {
  return call<FetchedPage>('fetch_url', { url, locale, maxLength });
}

/**
 * Fetch a URL using a hidden WebView2 browser engine. Slower than `fetchUrl`
 * (~3-5s) but bypasses anti-bot protections (403, Cloudflare JS challenges)
 * that block plain HTTP. Returns the same `FetchedPage` format.
 *
 * Windows-only — on other platforms the command returns an error.
 */
export function fetchUrlViaWebview(
  url: string,
  locale: string,
  maxLength?: number,
): Promise<FetchedPage> {
  return call<FetchedPage>('fetch_url_via_webview', { url, locale, maxLength });
}

// ─── Image-from-URL pipeline ────────────────────────────────────────────────

/**
 * Download an image from a URL, process it (center-crop + resize + WebP
 * encode), and return the prepared bytes ready for `update<Entity>Image`.
 *
 * Server-side pipeline (mirrors `ImageCropDialog`'s pick → crop → compress →
 * submit flow, minus the interactive crop rectangle):
 *   1. reqwest GET with Chrome UA (same client as `fetchUrl`)
 *   2. `image::load_from_memory` auto-detects JPEG / PNG / WebP
 *   3. Center-crop to `aspect` (longest-edge cut toward target)
 *   4. Lanczos3 resize to exactly `outputWidth × outputHeight`
 *   5. Lossless WebP encode (pure Rust — no libwebp C dep)
 *   6. 1 MiB ceiling check
 *
 * Returns raw bytes via Tauri's binary IPC channel (same path as
 * `getCharacterImage` etc.) — NOT base64. Feed the result to any
 * `update<Entity>Image` wrapper:
 *
 * ```ts
 * const buf = await fetchAndPrepareImage(url, 3/4, 300, 400);
 * await updateCharacterImage(spaceId, worldId, id, new Uint8Array(buf), "image/webp");
 * ```
 *
 * @throws `INVALID_IMAGE` if encoded output exceeds 1 MiB (extremely unlikely
 *         at the small target sizes the entity forms use).
 */
export function fetchAndPrepareImage(
  url: string,
  aspect: number,
  outputWidth: number,
  outputHeight: number,
): Promise<ArrayBuffer> {
  return call<ArrayBuffer>('fetch_and_prepare_image', {
    url,
    aspect,
    outputWidth,
    outputHeight,
  });
}
