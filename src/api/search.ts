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
