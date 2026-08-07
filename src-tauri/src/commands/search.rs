// Web lookup commands — Bing search + URL fetch (no API key, no billing).
//
// Two commands live here:
//   - `search_web` — scrapes `https://www.bing.com/search` server-side
//     (browser context is CORS-blocked by Bing) into a list of
//     `{ title, url, snippet }` result objects.
//   - `fetch_url` — fetches a single URL and extracts its main readable
//     content via `readabilityrs` (Mozilla Readability port), returning
//     plain text + metadata for the LLM.
//
// ## Why Bing
//
// Bing is one of the few international search engines accessible from
// mainland China without VPN; chosen for that reason. DuckDuckGo is
// GFW-blocked (DNS pollution) since September 2014.
//
// ## Redaction
//
// Search queries and fetched URLs are potentially user creative content /
// research targets (⚠️ TRACE-only tier per AGENTS.md redaction policy). Both
// commands use `skip_all` and expose only length/count metadata as tracing
// fields — the query string, URL string, locale, and page content are NEVER
// logged at any level.
//
// ## Errors
//
// All failure paths collapse to `DbError::Internal(String)` — no new
// `DbError` variant is introduced (out of scope; the dynamic message is the
// only useful information for a network/parse failure).

use base64::Engine as _;
use readabilityrs::Readability;
use serde::Serialize;
use url::Url;

use crate::db::DbError;

/// Bing search endpoint (GET with `q` + `adlt` query params).
const BING_SEARCH_URL: &str = "https://www.bing.com/search";

/// Request timeout. 15s is a generous ceiling for both search and fetch.
const REQUEST_TIMEOUT_SECS: u64 = 15;

/// User-Agent sent on all web requests. A real recent browser UA is
/// mandatory — Bing (and most sites) instantly block non-browser UAs.
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ═══════════════════════════════════════════════════════════════════════════
// DTOs
// ═══════════════════════════════════════════════════════════════════════════

/// A single search result. Transient DTO (not a persisted entity), so it
/// lives here rather than under `models/`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// A fetched web page's extracted content. Transient DTO (not a persisted
/// entity), so it lives here rather than under `models/`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    /// Final URL after any redirects.
    pub url: String,
    /// Page title (from metadata, `<title>`, or Readability extraction).
    pub title: Option<String>,
    /// Main content as plain text (HTML tags stripped). Truncated to
    /// `max_length` chars.
    pub content: String,
    /// Author byline (Readability extraction; `None` if not detected).
    pub author: Option<String>,
    /// Short excerpt / meta description (Readability extraction; `None` if
    /// not detected).
    pub excerpt: Option<String>,
    /// Publication timestamp (Readability extraction; `None` if not detected).
    pub published_at: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// search_web
// ═══════════════════════════════════════════════════════════════════════════

/// Search the public web via Bing's HTML SERP.
///
/// `query` is percent-encoded into the query string. `locale` drives the
/// `Accept-Language` header (e.g. `"zh-CN"`, `"en"`); `None` or empty
/// defaults to `"en"`. `max_results` defaults to 5 and is capped at 20.
/// Returns up to that many results; an empty `Vec` (no parse error, just no
/// matches) is a legitimate outcome — it does NOT surface as an error.
#[tracing::instrument(skip_all, fields(query_length = query.len(), result_count))]
#[tauri::command]
pub async fn search_web(
    query: String,
    locale: Option<String>,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, DbError> {
    let limit = max_results.unwrap_or(5).min(20);
    let accept_language = locale
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("en");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| DbError::Internal(format!("web search request failed: {e}")))?;

    // Bing expects a GET with the query in the URL. `adlt=moderate` requests
    // moderate adult-content filtering. `mkt` is intentionally omitted — let
    // Bing decide the market from IP geolocation + Accept-Language so users
    // outside China don't get cn-routed results.
    let resp = client
        .get(BING_SEARCH_URL)
        .header(reqwest::header::USER_AGENT, CHROME_UA)
        .header("Accept-Language", accept_language)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .query(&[("q", query.as_str()), ("adlt", "moderate")])
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("web search request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "bing returned HTTP {}",
            resp.status()
        )));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("failed to read search response: {e}")))?;

    let results = parse_results(&text, limit)?;

    tracing::Span::current().record("result_count", results.len());
    tracing::debug!("web search completed");
    Ok(results)
}

/// Parse Bing's HTML SERP into a `Vec<SearchResult>`, truncated to `limit`.
///
/// Each result is a `<li class="b_algo">` (inside `<ol id="b_results">`).
/// The title+link is `h2 a` (text = title, `href` = URL — may be a direct
/// URL OR a Bing-wrapped `https://www.bing.com/ck/a?...` tracking redirect,
/// unwrapped by [`decode_bing_url`]). The snippet is `.b_caption p` (this
/// selector covers the `b_lineclamp2/3/4` variants which all live inside
/// `.b_caption`).
fn parse_results(html: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    if html.is_empty() {
        return Ok(Vec::new());
    }

    let document = scraper::Html::parse_document(html);

    let item_sel = parse_selector("li.b_algo")?;
    let link_sel = parse_selector("h2 a")?;
    let snippet_sel = parse_selector(".b_caption p")?;

    let mut results = Vec::new();
    for node in document.select(&item_sel) {
        if results.len() >= limit {
            break;
        }
        let Some(link_el) = node.select(&link_sel).next() else {
            continue;
        };
        let title = link_el
            .text()
            .collect::<String>()
            .trim()
            .to_string();
        let href = link_el.value().attr("href").unwrap_or_default();
        let url = decode_bing_url(href);
        let snippet = node
            .select(&snippet_sel)
            .next()
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        // Skip degenerate rows (no title AND no URL).
        if title.is_empty() && url.is_empty() {
            continue;
        }
        results.push(SearchResult {
            title,
            url,
            snippet,
        });
    }
    Ok(results)
}

/// Decode Bing's wrapped tracking-redirect URL.
///
/// Bing wraps the real destination as
/// `https://www.bing.com/ck/a?...&u=a1<base64url>&...`. The `u` query param
/// carries an `"a1"` literal prefix followed by the actual URL in
/// base64url encoding (padding often omitted). Pass through any href that
/// isn't a Bing redirect unchanged.
fn decode_bing_url(href: &str) -> String {
    // Pass through URLs that aren't Bing tracking redirects.
    if !href.starts_with("https://www.bing.com/ck/a?") {
        return href.to_string();
    }
    let Ok(parsed) = Url::parse(href) else {
        return href.to_string();
    };
    let Some(encoded) = parsed
        .query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.into_owned())
    else {
        return href.to_string();
    };
    // The 'u' param has an "a1" prefix before the actual base64url payload.
    let Some(b64) = encoded.strip_prefix("a1") else {
        return href.to_string();
    };
    // Bing's base64url may omit padding. Pad to a multiple of 4 so URL_SAFE
    // (which expects padding) decodes cleanly.
    let mut padded = b64.to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    base64::engine::general_purpose::URL_SAFE
        .decode(&padded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| href.to_string())
}

/// Parse a CSS selector, mapping the failure to `DbError::Internal`. The
/// selectors used here are static literals that always parse, but mapping
/// the error keeps the function total and avoids `expect` in production code.
fn parse_selector(selector: &'static str) -> Result<scraper::Selector, DbError> {
    scraper::Selector::parse(selector)
        .map_err(|e| DbError::Internal(format!("failed to parse search results: {e}")))
}

// ═══════════════════════════════════════════════════════════════════════════
// fetch_url
// ═══════════════════════════════════════════════════════════════════════════

/// Fetch a URL and extract its main readable content via Readability.
///
/// `url` is the absolute URL to fetch. `locale` drives the `Accept-Language`
/// header (consistent with `search_web`); `None`/empty defaults to `"en"`.
/// `max_length` caps the returned content size in CHARS (not bytes); default
/// 10_000, hard cap 50_000. The page is processed via `readabilityrs` (Mozilla
/// Readability port); if no article can be extracted, falls back to stripping
/// all HTML tags from the raw response as a best-effort plain-text dump.
#[tracing::instrument(skip_all, fields(url_length = url.len(), content_length))]
#[tauri::command]
pub async fn fetch_url(
    url: String,
    locale: Option<String>,
    max_length: Option<usize>,
) -> Result<FetchedPage, DbError> {
    let char_limit = max_length.unwrap_or(10_000).min(50_000);
    let accept_language = locale
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("en");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| DbError::Internal(format!("fetch_url client build: {e}")))?;

    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, CHROME_UA)
        .header("Accept-Language", accept_language)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("web fetch request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "fetch_url got HTTP {}",
            resp.status()
        )));
    }

    // `resp.url()` gives the final URL after redirects.
    let final_url = resp.url().to_string();
    let html = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("failed to read fetch response: {e}")))?;

    let page = extract_page(&html, &final_url)?;

    // Truncate by CHARS (UTF-8 safe — `chars()` yields `char`, not bytes).
    let truncated: String = page.content.chars().take(char_limit).collect();

    tracing::Span::current().record("content_length", truncated.len());
    tracing::debug!("web fetch completed");
    Ok(FetchedPage {
        url: final_url,
        title: page.title,
        content: truncated,
        author: page.author,
        excerpt: page.excerpt,
        published_at: page.published_at,
    })
}

/// Holds the extracted fields before truncation / serialization.
struct ExtractedPage {
    title: Option<String>,
    content: String,
    author: Option<String>,
    excerpt: Option<String>,
    published_at: Option<String>,
}

/// Run Readability extraction; on failure, fall back to a naive full-text dump.
///
/// The fallback handles pages Readability can't parse (e.g. plain text rendered
/// as `<pre>`, server error pages, non-article HTML). It strips ALL tags via
/// `scraper::Html::parse_document` + a root-element text walk and tries to
/// pull a title from `<title>`.
fn extract_page(html: &str, final_url: &str) -> Result<ExtractedPage, DbError> {
    // Primary path: Readability extraction.
    if let Ok(readability) = Readability::new(html, Some(final_url), None) {
        if let Some(parsed) = readability.parse() {
            // Prefer Readability's own `text_content` (plain text with all
            // HTML tags already stripped by the library — higher fidelity
            // than re-parsing via scraper). Fall back to flattening `content`
            // (clean HTML) via the already-dep'd `scraper` crate.
            let plain = match parsed.text_content.as_deref() {
                Some(t) if !t.trim().is_empty() => t.to_string(),
                _ => parsed
                    .content
                    .as_deref()
                    .map(html_to_text)
                    .unwrap_or_default(),
            };
            return Ok(ExtractedPage {
                title: parsed.title,
                content: plain,
                author: parsed.byline,
                excerpt: parsed.excerpt,
                published_at: parsed.published_time,
            });
        }
    }

    // Fallback: Readability couldn't extract an article (non-article HTML,
    // server error pages, `<pre>`-wrapped text, etc.). Strip ALL tags from
    // the raw HTML and try to pull a title from `<title>`.
    Ok(ExtractedPage {
        title: extract_title(html),
        content: html_to_text(html),
        author: None,
        excerpt: None,
        published_at: None,
    })
}

/// Flatten HTML to a single text string by walking all text nodes.
///
/// Uses the already-dep'd `scraper` crate (same one `parse_results` uses).
/// Whitespace is collapsed and trimmed.
fn html_to_text(html: &str) -> String {
    let doc = scraper::Html::parse_document(html);
    let raw: String = doc.root_element().text().collect::<Vec<_>>().join(" ");
    // Collapse runs of whitespace (newlines, tabs, multiple spaces) into a
    // single space. Trim leading/trailing.
    let mut out = String::with_capacity(raw.len());
    let mut prev_ws = true; // start true to trim leading ws
    for c in raw.chars() {
        if c.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(c);
            prev_ws = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Extract `<title>` tag content from raw HTML, as a last-resort title source
/// when Readability didn't find one.
fn extract_title(html: &str) -> Option<String> {
    let doc = scraper::Html::parse_document(html);
    let title_sel = scraper::Selector::parse("title").ok()?;
    let title = doc
        .select(&title_sel)
        .next()?
        .text()
        .collect::<String>()
        .trim()
        .to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}
