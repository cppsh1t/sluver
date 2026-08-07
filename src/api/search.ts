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

/** A fetched web page's extracted content. */
export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  /** Page title (from `<title>` or Readability extraction). */
  title: string | null;
  /** Main content as plain text. Truncated to `maxLength` chars. */
  content: string;
  /** Author byline, if detected. */
  author: string | null;
  /** Short excerpt / meta description, if detected. */
  excerpt: string | null;
  /** Publication timestamp (ISO string), if detected. */
  publishedAt: string | null;
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
