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
use readabilityrs::{Readability, ReadabilityOptions};
use serde::Serialize;
use url::Url;

use crate::db::DbError;

// `tauri::Manager` provides `app.get_webview_window()` — only needed by the
// Windows path of `fetch_url_via_webview`.
#[cfg(target_os = "windows")]
use tauri::Manager;

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

/// Identifies the format of [`FetchedPage::content`] so the consumer (agent /
/// UI) knows how to render it.
///
/// Articles successfully extracted by Readability are returned as `Markdown`
/// with inline images preserved at their original document position as
/// `![alt](url)` — the agent can scan for these to pick the right image URL
/// for further processing (e.g. feeding to `set_character_image_from_url`).
/// The fallback path for non-article HTML (server error pages, `<pre>`-wrapped
/// text) returns `Text` (HTML-stripped plain text with no image information).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContentFormat {
    Markdown,
    Text,
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
    /// Main content. Format is identified by [`content_format`](#structfield.content_format).
    /// When Markdown, images are preserved inline as `![alt](url)` at their
    /// original document position. Truncated to `max_length` chars.
    pub content: String,
    /// Format of [`content`](#structfield.content) — `markdown` (Readability
    /// extracted an article and converted to Markdown, preserving images) or
    /// `text` (fallback plain-text dump, no images).
    pub content_format: ContentFormat,
    /// Author byline (Readability extraction; `None` if not detected).
    pub author: Option<String>,
    /// Short excerpt / meta description (Readability extraction; `None` if
    /// not detected).
    pub excerpt: Option<String>,
    /// Publication timestamp (Readability extraction; `None` if not detected).
    pub published_at: Option<String>,
    /// Best "hero" image URL extracted by Readability from JSON-LD /
    /// OpenGraph / Twitter Card meta tags (`og:image`, `twitter:image`,
    /// `link[rel="image_src"]`, etc.). Single absolute URL when present.
    ///
    /// Distinct from the inline images embedded in `content` (when Markdown):
    /// `main_image` is the page's designated cover/hero image, while inline
    /// `![](url)` entries are body illustrations. For entity image assignment
    /// both are valid candidates — `main_image` is typically the strongest
    /// signal for biographical / wiki-style pages.
    pub main_image: Option<String>,
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
        content_format: page.content_format,
        author: page.author,
        excerpt: page.excerpt,
        published_at: page.published_at,
        main_image: page.main_image,
    })
}

/// Holds the extracted fields before truncation / serialization.
struct ExtractedPage {
    title: Option<String>,
    content: String,
    content_format: ContentFormat,
    author: Option<String>,
    excerpt: Option<String>,
    published_at: Option<String>,
    main_image: Option<String>,
}

/// Run Readability extraction; on failure, fall back to a naive full-text dump.
///
/// Readability is invoked with `output_markdown = true`, which makes the
/// library return `markdown_content` — the cleaned article HTML converted to
/// Markdown, with inline images preserved at their original document position
/// as `![alt](url)`. The library's standardization pipeline (`elements::images
/// ::standardize_images`) transparently handles:
///
///   - **Lazy-load normalization**: `data-src` (and similar vendor attributes)
///     are promoted to `src` before Markdown conversion, so lazy-loaded images
///     from baike/zhihu/weibo aren't lost as placeholder GIFs.
///   - **srcset selection**: the largest source by width/density is picked
///     from responsive `<img srcset="...">`.
///   - **Tiny-image removal**: tracker pixels and UI icons (width AND height
///     both `< 100`) are dropped, leaving only content-bearing images.
///   - **Relative → absolute URL**: resolved against `final_url`.
///
/// The Markdown body preserves the image's position in the document flow, so
/// the agent can correlate each `![](url)` with its surrounding prose to judge
/// semantic role (portrait / illustration / diagram / etc.).
///
/// The fallback handles pages Readability can't parse (e.g. plain text rendered
/// as `<pre>`, server error pages, non-article HTML). It strips ALL tags via
/// `scraper::Html::parse_document` + a root-element text walk and tries to
/// pull a title from `<title>`. No image information is recoverable here.
fn extract_page(html: &str, final_url: &str) -> Result<ExtractedPage, DbError> {
    // Enable Markdown output so images are preserved inline. All other options
    // stay at library defaults.
    let options = ReadabilityOptions {
        output_markdown: true,
        ..Default::default()
    };

    let parsed = Readability::new(html, Some(final_url), Some(options))
        .ok()
        .and_then(|r| r.parse());

    if let Some(parsed) = parsed {
        // Prefer markdown_content (images preserved as `![alt](url)` inline).
        // Fall back to text_content (plain text, no images) — rare; only when
        // the library extracted an article but Markdown conversion yielded
        // nothing. Both being empty means Readability found no article at all
        // → drop to the fallback path below.
        let md = parsed
            .markdown_content
            .as_deref()
            .filter(|s| !s.trim().is_empty());
        let txt = parsed
            .text_content
            .as_deref()
            .filter(|s| !s.trim().is_empty());

        if let Some(content) = md.or(txt) {
            let content_format = if md.is_some() {
                ContentFormat::Markdown
            } else {
                ContentFormat::Text
            };
            return Ok(ExtractedPage {
                title: parsed.title,
                content: content.to_string(),
                content_format,
                author: parsed.byline,
                excerpt: parsed.excerpt,
                published_at: parsed.published_time,
                main_image: parsed.image,
            });
        }
    }

    // Fallback: Readability couldn't extract an article (non-article HTML,
    // server error pages, `<pre>`-wrapped text, etc.). Strip ALL tags from
    // the raw HTML and try to pull a title from `<title>`.
    Ok(ExtractedPage {
        title: extract_title(html),
        content: html_to_text(html),
        content_format: ContentFormat::Text,
        author: None,
        excerpt: None,
        published_at: None,
        main_image: None,
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

// ═══════════════════════════════════════════════════════════════════════════
// fetch_url_via_webview
// ═══════════════════════════════════════════════════════════════════════════

/// Fetch a URL using a hidden WebView2 browser engine, bypassing anti-bot
/// protections that block plain HTTP requests (403 Forbidden, Cloudflare JS
/// challenges, etc.). The fully rendered HTML is extracted via native
/// `ICoreWebView2::ExecuteScript` and processed through the same Readability
/// pipeline as [`fetch_url`].
///
/// **Windows-only.** On macOS/Linux, returns an "unsupported" error — the
/// WebView2 COM interop has no WKWebView/WebKitGTK equivalent wired up yet.
///
/// The agent gets both `fetch_url` (fast HTTP) and this command (slower
/// browser engine, ~3-5s per fetch). Use this when `fetch_url` returns an
/// error or when the page requires JavaScript rendering. Following Cherry
/// Studio's `@cherry/browser` model, this is an explicit peer tool — the
/// agent decides when the expensive browser path is warranted, not an
/// automatic fallback inside `fetch_url`.
///
/// **Flow:**
/// 1. Create hidden window (main thread — avoid WebView2 deadlock, same
///    pattern as `open_space_window`).
/// 2. Wait for `PageLoadEvent::Finished` (30s timeout for anti-bot JS).
/// 3. Extract HTML via `ExecuteScript`; retry up to 3× if the page looks
///    like an anti-bot challenge interstitial (Cloudflare, PerimeterX, etc.).
/// 4. Close window, run Readability extraction (reuse [`extract_page`]).
///
/// `locale` is accepted for API parity with [`fetch_url`] but not yet wired
/// to WebView2's `Accept-Language` (requires `WebResourceRequested`
/// interception — deferred for now).
#[cfg(target_os = "windows")]
#[tracing::instrument(skip_all, fields(url_length = url.len(), content_length))]
#[tauri::command]
pub async fn fetch_url_via_webview(
    app: tauri::AppHandle,
    url: String,
    locale: Option<String>,
    max_length: Option<usize>,
) -> Result<FetchedPage, DbError> {
    let _ = locale;
    let char_limit = max_length.unwrap_or(10_000).min(50_000);
    let target: Url = Url::parse(&url)
        .map_err(|e| DbError::Internal(format!("invalid URL: {e}")))?;

    // Restrict to http(s) — WebView2 will happily load file:/// and data:
    // URLs, which could expose local file contents to the agent.
    if !matches!(target.scheme(), "http" | "https") {
        return Err(DbError::Internal("only http(s) URLs are supported".into()));
    }

    let label = format!("webview-fetcher-{}", crate::util::new_id());
    let loaded = std::sync::Arc::new(tokio::sync::Notify::new());
    let loaded_cb = loaded.clone();

    // ── 1. Build hidden window on main thread (avoid WebView2 deadlock) ────
    //
    // Uses `tokio::sync::oneshot` (not `std::sync::mpsc`) so the build-wait
    // is a non-blocking `.await` on the tokio runtime, not a blocking `recv()`
    // that would park the worker thread.
    let (build_tx, build_rx) = tokio::sync::oneshot::channel::<Result<(), DbError>>();
    let app_for_main = app.clone();
    let label_for_main = label.clone();
    let target_for_build = target.clone();

    app.run_on_main_thread(move || {
        let result = tauri::WebviewWindowBuilder::new(
            &app_for_main,
            &label_for_main,
            tauri::WebviewUrl::External(target_for_build),
        )
        .visible(false)
        .skip_taskbar(true)
        .inner_size(100.0, 100.0)
        .decorations(false)
        .resizable(false)
        .on_page_load(move |_win, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                loaded_cb.notify_one();
            }
        })
        .build()
        .map(|_| ())
        .map_err(|e| DbError::Internal(format!("webview window build failed: {e}")));

        let _ = build_tx.send(result);
    })
    .map_err(|e| DbError::Internal(format!("run_on_main_thread failed: {e}")))?;

    build_rx.await.map_err(|_| {
        DbError::Internal("main thread dropped channel before build result".into())
    })??;

    // ── 2. Get window handle ──────────────────────────────────────────────
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| DbError::Internal("fetcher window not found after build".into()))?;

    // ── 3. Wait for page load (anti-bot challenges can take 10-15s) ───────
    let load_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        loaded.notified(),
    )
    .await;

    if load_result.is_err() {
        let _ = window.close();
        return Err(DbError::Internal("webview page load timed out (30s)".into()));
    }

    // ── 4. Extract HTML with retry for anti-bot challenge pages ───────────
    //
    // Anti-bot challenges (Cloudflare, PerimeterX, etc.) fire `Finished` for
    // the challenge interstitial FIRST, then redirect to the real page after
    // 5-10s. Instead of a blind fixed delay, we extract immediately and retry
    // if the result looks like a challenge page. Normal sites return on the
    // first attempt with zero added latency.
    let html = {
        let mut attempts = 0u8;
        loop {
            match eval_rendered_html(&window).await {
                Ok(h) if !looks_like_challenge(&h) => break h,
                Ok(_) if attempts < 3 => {
                    attempts += 1;
                    tracing::debug!(
                        attempt = attempts,
                        "anti-bot challenge page detected, retrying"
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
                Ok(h) => break h, // give up retrying, return what we have
                Err(e) => {
                    let _ = window.close();
                    return Err(e);
                }
            }
        }
    };

    // ── 5. Always close the window ────────────────────────────────────────
    let _ = window.close();

    // ── 6. Run Readability extraction (reuse extract_page) ────────────────
    let final_url = target.to_string();
    let page = extract_page(&html, &final_url)?;
    let truncated: String = page.content.chars().take(char_limit).collect();

    tracing::Span::current().record("content_length", truncated.len());
    tracing::debug!("webview fetch completed");

    Ok(FetchedPage {
        url: final_url,
        title: page.title,
        content: truncated,
        content_format: page.content_format,
        author: page.author,
        excerpt: page.excerpt,
        published_at: page.published_at,
        main_image: page.main_image,
    })
}

/// Extract rendered HTML from a WebView2 window via native `ExecuteScript`.
///
/// `WebviewWindow::eval` is fire-and-forget — it returns `Result<()>` and
/// discards the JS return value. To get HTML back to Rust, we drop down to
/// the platform webview via `with_webview` and invoke
/// `ICoreWebView2::ExecuteScript`, which provides the result via a completion
/// callback. The result arrives as a JSON-encoded string (double-quoted for a
/// string return), which we unwrap via `serde_json`.
///
/// The `with_webview` closure runs synchronously on the webview thread; we
/// bridge the `ExecuteScript` result back to the async caller via an
/// `mpsc` channel consumed inside `spawn_blocking` (avoiding tokio block).
#[cfg(target_os = "windows")]
async fn eval_rendered_html(window: &tauri::WebviewWindow) -> Result<String, DbError> {
    use std::sync::mpsc;
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    let (tx, rx) = mpsc::channel::<Result<String, String>>();

    window
        .with_webview(move |wv: tauri::webview::PlatformWebview| {
            let controller = wv.controller();
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(format!("CoreWebView2 access failed: {e}")));
                    return;
                }
            };

            let js = HSTRING::from("document.documentElement.outerHTML");
            let handler = ExecuteScriptCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>, json: String| {
                    let value = result
                        .map(|_| json)
                        .map_err(|e| format!("ExecuteScript error: {e}"));
                    let _ = tx.send(value);
                    Ok(())
                },
            ));

            let _ = unsafe { core.ExecuteScript(&js, Some(&handler)) };
        })
        .map_err(|e| DbError::Internal(format!("with_webview dispatch failed: {e}")))?;

    // Bridge sync mpsc → async (avoid blocking the tokio runtime).
    let raw_result = tokio::task::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|e| DbError::Internal(format!("ExecuteScript channel timed out: {e}")))
    })
    .await
    .map_err(|e| DbError::Internal(format!("spawn_blocking join error: {e}")))??;

    let json_string = raw_result.map_err(DbError::Internal)?;

    // WebView2 returns the JS result as a JSON-encoded string.
    // For `document.documentElement.outerHTML` (a string), the raw value is
    // "\"<html>...</html>\"" — unwrap one JSON string layer.
    if json_string.is_empty() {
        return Err(DbError::Internal("ExecuteScript returned empty result".into()));
    }

    match serde_json::from_str::<serde_json::Value>(&json_string) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        Ok(other) => Ok(other.to_string()),
        Err(_) => Ok(json_string), // best-effort fallback
    }
}

/// Heuristic check: does this HTML look like an anti-bot challenge page?
///
/// Returns `true` for common challenge interstitial markers (Cloudflare,
/// Turnstile, PerimeterX/HUMAN). Used by the retry loop in
/// [`fetch_url_via_webview`] to decide whether to wait and re-extract.
/// False positives are unlikely (these strings are specific to challenge
/// infrastructure); false negatives just mean we return the challenge page
/// as-is (the retry gives up after 3 attempts).
fn looks_like_challenge(html: &str) -> bool {
    html.contains("challenge-platform") // Cloudflare
    || html.contains("cf-turnstile")
    || html.contains("Just a moment...")
    || html.contains("Checking your browser") // Generic interstitials
    || html.contains("Verifying you are human")
    || html.contains("px-captcha") // PerimeterX / HUMAN
}

#[cfg(not(target_os = "windows"))]
#[tracing::instrument(skip_all, fields(url_length = url.len()))]
#[tauri::command]
pub async fn fetch_url_via_webview(
    _app: tauri::AppHandle,
    _url: String,
    _locale: Option<String>,
    _max_length: Option<usize>,
) -> Result<FetchedPage, DbError> {
    Err(DbError::Internal(
        "webview fetch is currently only supported on Windows".into(),
    ))
}

// ═══════════════════════════════════════════════════════════════════════════
// fetch_and_prepare_image
// ═══════════════════════════════════════════════════════════════════════════

/// Download an image from a URL, center-crop to a target aspect ratio, resize
/// to exact output dimensions, and re-encode as lossless WebP.
///
/// Used by the agent's `set_<entity>_image_from_url` tools so the agent can
/// attach portraits/covers found via `web_search` to entities. Mirrors the
/// user-side pick → crop → compress → submit flow (`ImageCropDialog`) with
/// one key difference: the user picks the crop rectangle interactively,
/// while this command uses **center-crop** (no face/saliency detection).
///
/// **Pipeline:**
/// 1. `reqwest` GET (reuses `CHROME_UA` + `REQUEST_TIMEOUT_SECS` from `fetch_url`)
/// 2. `image::load_from_memory` auto-detects format (JPEG / PNG / WebP)
/// 3. Center-crop to `aspect` — cuts the longer dimension in half from each
///    side so the source center stays in frame
/// 4. Lanczos3 resize to exactly `output_width × output_height`
/// 5. Lossless WebP encode via `image::codecs::webp::WebPEncoder` (pure Rust,
///    no libwebp C dependency — lossy encoding would require the separate
///    `webp` crate)
/// 6. Size ceiling check (`util::MAX_IMAGE_BYTES` = 1 MiB) — oversized output
///    surfaces as `INVALID_IMAGE` (the same code the user-upload path uses)
///
/// Output is returned as raw bytes via `tauri::ipc::Response` — bypasses
/// JSON serialization on the wire, mirroring `get_*_image`. Frontend reads
/// it as `ArrayBuffer` and feeds it to `update<Entity>Image(bytes, "image/webp")`.
///
/// **Why lossless WebP and not lossy:**
/// - `image` 0.25's built-in WebP encoder is lossless-only (pure Rust). Lossy
///   would require `webp = "0.3"` + libwebp-sys — a heavy native dep that
///   dirties cross-platform builds (project currently ships rustls-tls only).
/// - At 300×400 / 640×360 output sizes, lossless WebP is ~50-80 KB — well
///   below the 1 MiB ceiling.
///
/// **Redaction (ADR-0014 / ADR-0016):** URL is user creative content (a
/// research target). `skip_all` + length-only field, consistent with
/// `fetch_url`. The output bytes are creative content too — only the length
/// is recorded.
#[tracing::instrument(skip_all, fields(url_length = url.len(), output_bytes))]
#[tauri::command]
pub async fn fetch_and_prepare_image(
    url: String,
    aspect: f64,
    output_width: u32,
    output_height: u32,
) -> Result<tauri::ipc::Response, DbError> {
    use image::ImageEncoder;
    use std::io::Cursor;

    // ── 1. Validate URL + args ──────────────────────────────────────────
    let target = Url::parse(&url)
        .map_err(|e| DbError::Internal(format!("invalid URL: {e}")))?;
    // Restrict to http(s) — same guard as `fetch_url_via_webview`. The image
    // crate is happy to decode file:/// and data: URLs, which would expose
    // local file contents to the agent.
    if !matches!(target.scheme(), "http" | "https") {
        return Err(DbError::Internal("only http(s) URLs are supported".into()));
    }
    if !(aspect.is_finite() && aspect > 0.0) {
        return Err(DbError::Internal(format!("invalid aspect ratio: {aspect}")));
    }
    if output_width == 0 || output_height == 0 {
        return Err(DbError::Internal(
            "output_width and output_height must be positive".into(),
        ));
    }

    // ── 2. Download bytes (reuse the Chrome UA + timeout from fetch_url) ─
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| DbError::Internal(format!("fetch_image client build: {e}")))?;

    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, CHROME_UA)
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

    // ── 3. Decode (auto-detect format) ──────────────────────────────────
    let img = image::load_from_memory(&bytes)
        .map_err(|e| DbError::Internal(format!("image decode failed: {e}")))?;

    // ── 4. Center-crop to target aspect ─────────────────────────────────
    //
    // Cuts the longer dimension so the surviving frame exactly matches the
    // target aspect. Half the excess is removed from each side, keeping the
    // source image's center in the cropped frame. For portrait-orientation
    // sources with a centered subject (typical wiki/baike head-shots), this
    // keeps the subject intact. Landscape sources will have their sides cut,
    // which is acceptable for the use case (agent can pick a different URL).
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
        (iw, new_h, 0u32, y)
    };
    let cropped = img.crop_imm(crop_x, crop_y, crop_w, crop_h);

    // ── 5. Lanczos3 resize to exact output dimensions ───────────────────
    //
    // After center-crop the source aspect ≈ target aspect, so resize
    // introduces no further distortion — just smoothing/scaling. Lanczos3
    // is the highest-quality filter in `image`; slower than Catmull-Rom but
    // fine for one-shot 300×400 / 640×360 work (sub-10ms on modern CPUs).
    let resized = cropped.resize_exact(
        output_width,
        output_height,
        image::imageops::FilterType::Lanczos3,
    );

    // ── 6. Lossless WebP encode ─────────────────────────────────────────
    let mut buf = Cursor::new(Vec::new());
    image::codecs::webp::WebPEncoder::new_lossless(&mut buf)
        .write_image(
            resized.as_bytes(),
            output_width,
            output_height,
            resized.color().into(),
        )
        .map_err(|e| DbError::Internal(format!("webp encode failed: {e}")))?;
    let out_bytes = buf.into_inner();

    tracing::Span::current().record("output_bytes", out_bytes.len());

    // ── 7. Size ceiling (reuse util::MAX_IMAGE_BYTES = 1 MiB) ───────────
    // Output is always smaller than the source (downscaled + WebP-encoded),
    // but guard against pathological cases (huge source already at target
    // dimensions, lossless-encoded).
    if out_bytes.len() > crate::util::MAX_IMAGE_BYTES {
        return Err(DbError::InvalidImage);
    }

    tracing::debug!("fetch_and_prepare_image completed");
    Ok(tauri::ipc::Response::new(out_bytes))
}
