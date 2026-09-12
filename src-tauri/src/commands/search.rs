// Web lookup commands — multi-provider web search + URL fetch (ADR-0049).
//
// Commands living here:
//   - `search_web` — dispatches to the provider configured in
//     `app.webSearch` (meta.db settings KV):
//       - keyless builtin engines rendered in a hidden WebView2 window
//         (Bing SERP, with the original reqwest scrape as fallback; Baidu
//         SERP, webview-only — plain HTTP is TLS-blocked by Baidu),
//       - four BYOK REST providers (Tavily / Serper / Jina / Brave), and
//       - Exa, which routes on key presence: a configured key takes the
//         `api.exa.ai` REST path, NO key falls back to a keyless hosted
//         MCP search (`mcp.exa.ai`, anonymous + IP-rate-limited).
//   - `get_web_search_settings` / `set_web_search_settings` — persist the
//     provider choice + API keys (plaintext in meta.db, same threat model
//     as the space-scoped AI keys of ADR-0013).
//   - `fetch_url` — fetches a single URL and extracts its main readable
//     content via `readabilityrs` (Mozilla Readability port), returning
//     plain text + metadata for the LLM.
//   - `fetch_url_via_webview` — same extraction, but the page is rendered
//     in a hidden WebView2 first (anti-bot bypass). Shares its window
//     lifecycle machinery with the builtin search engines.
//
// ## Redaction
//
// Search queries, fetched URLs, and API keys are user content / secrets
// (⚠️ TRACE-only / NEVER tiers per AGENTS.md redaction policy). Commands
// use `skip_all` and expose only length/count metadata as tracing fields —
// the query string, URL string, locale, API keys, and page content are
// NEVER logged at any level.
//
// ## Errors
//
// All failure paths collapse to `DbError::Internal(String)` — no new
// `DbError` variant is introduced (out of scope; the dynamic message is the
// only useful information for a network/parse failure).

use base64::Engine as _;
use readabilityrs::{Readability, ReadabilityOptions};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::db::{DbError, DbManager};

// `tauri::Manager` provides `app.get_webview_window()` — only needed by the
// Windows paths (`fetch_url_via_webview` + the builtin search engines).
#[cfg(target_os = "windows")]
use tauri::Manager;

/// Bing search endpoint (GET with `q` + `adlt` query params).
const BING_SEARCH_URL: &str = "https://www.bing.com/search";

/// Baidu search endpoint (GET with `wd` + `ie` query params). WebView2-only —
/// Baidu TLS-fingerprints plain reqwest connections away.
const BAIDU_SEARCH_URL: &str = "https://www.baidu.com/s";

/// BYOK REST provider endpoints (ADR-0049).
const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const SERPER_SEARCH_URL: &str = "https://google.serper.dev/search";
const EXA_SEARCH_URL: &str = "https://api.exa.ai/search";
const JINA_SEARCH_URL: &str = "https://s.jina.ai/search";
const BRAVE_SEARCH_URL: &str = "https://api.search.brave.com/res/v1/web/search";

/// Hosted Exa MCP endpoint for KEYLESS search (no API key configured).
/// Anonymous access is IP-rate-limited (~2 QPS, ~50 calls/day) and — unlike
/// every other BYOK provider — reachable from mainland networks without a
/// proxy. The `tools=web_search_exa` query param pre-selects the single
/// tool this app calls.
const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp?tools=web_search_exa";

/// meta.db `settings` KV row holding the serialized [`WebSearchSettings`].
const WEB_SEARCH_SETTINGS_KEY: &str = "app.webSearch";

/// Request timeout. 15s is a generous ceiling for search, fetch, and image
/// download (`pub(crate)` — also used by `commands/image.rs::
/// download_image_bytes`, the shared image download helper).
pub(crate) const REQUEST_TIMEOUT_SECS: u64 = 15;

/// User-Agent sent on all web requests. A real recent browser UA is
/// mandatory — Bing (and most sites) instantly block non-browser UAs.
/// (`pub(crate)` — also used by `commands/image.rs::download_image_bytes`.)
pub(crate) const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
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
// Web search settings (meta.db `settings` KV, key `app.webSearch`)
// ═══════════════════════════════════════════════════════════════════════════

/// Which engine `search_web` dispatches to. Serialized kebab-case so the
/// value is readable in the raw `settings` row and stable across frontend
/// renames.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WebSearchProvider {
    #[default]
    BuiltinBing,
    BuiltinBaidu,
    Tavily,
    Serper,
    Exa,
    Jina,
    Brave,
}

impl WebSearchProvider {
    /// Lowercase slug for error messages and log fields (snake_case-safe —
    /// matches the kebab-case serde representation).
    fn slug(self) -> &'static str {
        match self {
            WebSearchProvider::BuiltinBing => "builtin-bing",
            WebSearchProvider::BuiltinBaidu => "builtin-baidu",
            WebSearchProvider::Tavily => "tavily",
            WebSearchProvider::Serper => "serper",
            WebSearchProvider::Exa => "exa",
            WebSearchProvider::Jina => "jina",
            WebSearchProvider::Brave => "brave",
        }
    }
}

/// Per-provider API keys for the BYOK REST providers. Stored as plaintext in
/// meta.db — same accepted threat model + upgrade path as the space-scoped
/// AI provider keys (ADR-0013). All keys are optional; the selected
/// provider's key is validated at dispatch time.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchApiKeys {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tavily: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serper: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exa: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jina: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brave: Option<String>,
}

/// Persisted web-search configuration (ADR-0049). Full-replacement semantics
/// like every other settings command.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSettings {
    pub provider: WebSearchProvider,
    #[serde(default)]
    pub api_keys: WebSearchApiKeys,
}

/// Read the persisted web-search settings. A missing row (first run) or a
/// corrupt/unparseable value yields DEFAULTS — never an error — so a bad row
/// can't take the whole `search_web` command down.
#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn get_web_search_settings(state: State<'_, DbManager>) -> Result<WebSearchSettings, DbError> {
    do_get_web_search_settings(&state)
}

pub(crate) fn do_get_web_search_settings(mgr: &DbManager) -> Result<WebSearchSettings, DbError> {
    mgr.with_meta(|conn| {
        let raw = conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![WEB_SEARCH_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        );
        match raw {
            // Corrupt JSON → defaults (do NOT error). Same for missing
            // required fields — `unwrap_or_default` covers both.
            Ok(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(WebSearchSettings::default()),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    })
}

/// Persist the web-search settings (full replacement) and read the row back.
#[tracing::instrument(skip(state, settings))]
#[tauri::command]
pub fn set_web_search_settings(
    settings: WebSearchSettings,
    state: State<'_, DbManager>,
) -> Result<WebSearchSettings, DbError> {
    do_set_web_search_settings(&state, settings)
}

pub(crate) fn do_set_web_search_settings(
    mgr: &DbManager,
    settings: WebSearchSettings,
) -> Result<WebSearchSettings, DbError> {
    let json = serde_json::to_string(&settings).map_err(DbError::Serde)?;
    mgr.with_meta(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![WEB_SEARCH_SETTINGS_KEY, json],
        )?;
        Ok(())
    })?;
    // Read back after write (command convention).
    do_get_web_search_settings(mgr)
}

// ═══════════════════════════════════════════════════════════════════════════
// search_web — multi-provider dispatch (ADR-0049)
// ═══════════════════════════════════════════════════════════════════════════

/// Search the public web via the configured provider.
///
/// `query` is percent-encoded into the engine's query string. `locale` drives
/// `Accept-Language`-style behavior per provider (e.g. Serper's `hl`/`gl`);
/// `None` or empty defaults to `"en"`. `max_results` defaults to 5 and is
/// capped at 20. Returns up to that many results; an empty `Vec` (no parse
/// error, just no matches) is a legitimate outcome for the reqwest/REST
/// paths — the builtin webview engines surface zero-parseable-results as an
/// error internally (Bing falls back, Baidu propagates).
///
/// Routing (see `app.webSearch` settings):
///   - `builtin-bing` — WebView2 Bing SERP; ANY webview failure (non-Windows,
///     timeout, challenge, zero results) falls back to the original reqwest
///     Bing scrape.
///   - `builtin-baidu` — WebView2 Baidu SERP; errors propagate (no fallback —
///     plain HTTP is TLS-blocked by Baidu).
///   - `exa` — keyed `api.exa.ai` REST when a key is configured; NO key
///     falls back to the keyless hosted MCP endpoint (`mcp.exa.ai`) instead
///     of erroring (anonymous, IP-rate-limited — see [`exa_search_keyless`]).
///   - other keyed providers — REST call; errors propagate (no silent
///     fallback).
#[tracing::instrument(skip_all, fields(query_length = query.len(), result_count))]
#[tauri::command]
pub async fn search_web(
    app: tauri::AppHandle,
    state: State<'_, DbManager>,
    query: String,
    locale: Option<String>,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, DbError> {
    // Read settings to an OWNED value before the first `.await` so no State
    // borrow is held across the await (same discipline as
    // `get_models_dev_catalog` in commands/ai.rs).
    let settings = do_get_web_search_settings(&state)?;
    let results =
        dispatch_web_search(&app, &settings, &query, locale.as_deref(), max_results).await?;

    tracing::Span::current().record("result_count", results.len());
    tracing::debug!("web search completed");
    Ok(results)
}

/// Provider-agnostic dispatch shared by the `search_web` command and the
/// `smoke` example bridge. `settings` is supplied by the caller so the smoke
/// path can inject a provider without a meta.db.
pub(crate) async fn dispatch_web_search(
    app: &tauri::AppHandle,
    settings: &WebSearchSettings,
    query: &str,
    locale: Option<&str>,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, DbError> {
    let limit = max_results.unwrap_or(5).min(20);
    let accept_language = locale.filter(|s| !s.is_empty()).unwrap_or("en");
    let provider = settings.provider;
    let started = std::time::Instant::now();
    // Dispatch-log provider label — `"exa-keyless"` distinguishes the
    // keyless MCP route from the keyed REST route (see the Exa arm below).
    let mut provider_label = provider.slug();

    let results = match provider {
        WebSearchProvider::BuiltinBing => {
            // Keyless Bing via hidden WebView2 SERP. ANY webview failure
            // falls back to the original reqwest scrape path below.
            match search_web_via_webview(app, SearchEngine::Bing, query, accept_language, limit)
                .await
            {
                Ok(results) => results,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        engine = "bing",
                        "webview search failed, falling back to reqwest scrape"
                    );
                    bing_search_reqwest(query, accept_language, limit).await?
                }
            }
        }
        WebSearchProvider::BuiltinBaidu => {
            // Keyless Baidu via hidden WebView2 SERP. No reqwest fallback —
            // Baidu TLS-blocks non-browser clients. 安全验证 and other
            // failures surface immediately (no retry loop).
            search_web_via_webview(app, SearchEngine::Baidu, query, accept_language, limit).await?
        }
        WebSearchProvider::Exa => {
            // Exa routes on key presence: a configured key takes the keyed
            // `api.exa.ai` REST path; key absent/empty falls back to the
            // KEYLESS hosted MCP endpoint instead of erroring (see
            // `exa_search_keyless`). This is the ONE keyed provider with a
            // keyless fallback — anonymous access is IP-rate-limited but
            // works, and is mainland-reachable without a proxy.
            let key = settings
                .api_keys
                .exa
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty());
            match key {
                Some(key) => {
                    let client = http_client()?;
                    exa_search(&client, key, query, accept_language, limit).await?
                }
                None => {
                    provider_label = "exa-keyless";
                    exa_search_keyless(query, limit).await?
                }
            }
        }
        keyed => keyed_provider_search(keyed, settings, query, accept_language, limit).await?,
    };

    // Metadata only — never the query text or result content (ADR-0016).
    tracing::debug!(
        provider = provider_label,
        query_len = query.len(),
        result_count = results.len(),
        latency_ms = started.elapsed().as_millis() as u64,
        "web_search.dispatch"
    );
    Ok(results)
}

/// Validate the selected provider's key, build the shared HTTP client, and
/// run the REST call. Keyed-provider errors PROPAGATE — no silent fallback.
/// Exa never reaches here: the dispatcher routes it on key presence
/// (keyless MCP fallback) before this fn is called.
async fn keyed_provider_search(
    provider: WebSearchProvider,
    settings: &WebSearchSettings,
    query: &str,
    locale: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let key = require_api_key(provider, &settings.api_keys)?;
    let client = http_client()?;
    match provider {
        WebSearchProvider::Tavily => tavily_search(&client, &key, query, locale, limit).await,
        WebSearchProvider::Serper => serper_search(&client, &key, query, locale, limit).await,
        WebSearchProvider::Jina => jina_search(&client, &key, query, locale, limit).await,
        WebSearchProvider::Brave => brave_search(&client, &key, query, locale, limit).await,
        // Exa is routed by the dispatcher (keyless MCP fallback when no
        // key); the builtin engines never take the keyed path. Unreachable
        // arms kept total.
        WebSearchProvider::Exa | WebSearchProvider::BuiltinBing | WebSearchProvider::BuiltinBaidu => {
            Err(DbError::Internal(
                "provider does not use the keyed search path".into(),
            ))
        }
    }
}

/// Resolve + validate the selected provider's API key. Missing/empty key →
/// error naming the provider so the UI can point the user at the settings.
/// Exa keeps its arm for totality (and direct tests) but is no longer
/// validated on the dispatch path — the dispatcher sends a keyless Exa
/// search instead when no key is configured.
fn require_api_key(
    provider: WebSearchProvider,
    keys: &WebSearchApiKeys,
) -> Result<String, DbError> {
    let key = match provider {
        WebSearchProvider::Tavily => keys.tavily.as_deref(),
        WebSearchProvider::Serper => keys.serper.as_deref(),
        WebSearchProvider::Exa => keys.exa.as_deref(),
        WebSearchProvider::Jina => keys.jina.as_deref(),
        WebSearchProvider::Brave => keys.brave.as_deref(),
        WebSearchProvider::BuiltinBing | WebSearchProvider::BuiltinBaidu => None,
    };
    key.map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            DbError::Internal(format!(
                "web search provider '{}' selected but no API key configured",
                provider.slug()
            ))
        })
}

/// Shared reqwest client for web-search requests (timeout only — provider
/// JSON APIs don't need a browser UA; the Bing scrape sets its own headers).
fn http_client() -> Result<reqwest::Client, DbError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| DbError::Internal(format!("web search request failed: {e}")))
}

/// The ORIGINAL server-side Bing scrape (pre-ADR-0049 `search_web` body),
/// kept verbatim as the fallback for when the WebView2 Bing engine fails
/// (non-Windows, timeout, challenge page, zero parseable results).
async fn bing_search_reqwest(
    query: &str,
    accept_language: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let client = http_client()?;

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
        .query(&[("q", query), ("adlt", "moderate")])
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

    parse_results(&text, limit)
}

// ═══════════════════════════════════════════════════════════════════════════
// BYOK REST providers (ADR-0049)
// ═══════════════════════════════════════════════════════════════════════════
//
// One flat section per provider: response structs (`#[serde(default)]`
// tolerance on every field so a shape drift yields empty results, not a
// panic), a pure `parse_*_response` fn (fixture/JSON-test surface), and the
// `*_search` HTTP fn. No trait objects — a match dispatcher is enough.

// ─── Tavily ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TavilyResponse {
    #[serde(default)]
    results: Vec<TavilyResult>,
}

#[derive(Deserialize)]
struct TavilyResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    content: String,
}

async fn tavily_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    _locale: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let body = serde_json::json!({
        "query": query,
        "max_results": limit,
        "search_depth": "basic",
    });
    let resp = client
        .post(TAVILY_SEARCH_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("tavily search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "tavily search failed: HTTP {}",
            resp.status()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("tavily search failed: {e}")))?;
    parse_tavily_response(&text, limit)
}

fn parse_tavily_response(body: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    let resp: TavilyResponse = serde_json::from_str(body)
        .map_err(|e| DbError::Internal(format!("tavily search failed: invalid response: {e}")))?;
    Ok(finalize_results(
        resp.results
            .into_iter()
            .map(|r| (r.title, r.url, r.content))
            .collect(),
        limit,
    ))
}

// ─── Serper ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SerperResponse {
    #[serde(default)]
    organic: Vec<SerperResult>,
}

#[derive(Deserialize)]
struct SerperResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    snippet: String,
}

/// Build the Serper request body. zh* locales get Chinese UI + CN geo so
/// Chinese-language worldbuilding queries return Chinese results.
fn serper_request_body(query: &str, locale: &str, limit: usize) -> serde_json::Value {
    if locale.starts_with("zh") {
        serde_json::json!({ "q": query, "num": limit, "hl": "zh-cn", "gl": "cn" })
    } else {
        serde_json::json!({ "q": query, "num": limit })
    }
}

async fn serper_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    locale: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let resp = client
        .post(SERPER_SEARCH_URL)
        .header("X-API-KEY", key)
        .json(&serper_request_body(query, locale, limit))
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("serper search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "serper search failed: HTTP {}",
            resp.status()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("serper search failed: {e}")))?;
    parse_serper_response(&text, limit)
}

fn parse_serper_response(body: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    let resp: SerperResponse = serde_json::from_str(body)
        .map_err(|e| DbError::Internal(format!("serper search failed: invalid response: {e}")))?;
    Ok(finalize_results(
        resp.organic
            .into_iter()
            .map(|r| (r.title, r.link, r.snippet))
            .collect(),
        limit,
    ))
}

// ─── Exa ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ExaResponse {
    #[serde(default)]
    results: Vec<ExaResult>,
}

#[derive(Deserialize)]
struct ExaResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    text: String,
}

async fn exa_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    _locale: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    // Request a short text extract per result (300 chars) so the snippet is
    // already summary-sized before our own 500-char truncation.
    let body = serde_json::json!({
        "query": query,
        "numResults": limit,
        "contents": { "text": { "maxCharacters": 300 } },
    });
    let resp = client
        .post(EXA_SEARCH_URL)
        .header("x-api-key", key)
        .json(&body)
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("exa search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "exa search failed: HTTP {}",
            resp.status()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("exa search failed: {e}")))?;
    parse_exa_response(&text, limit)
}

fn parse_exa_response(body: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    let resp: ExaResponse = serde_json::from_str(body)
        .map_err(|e| DbError::Internal(format!("exa search failed: invalid response: {e}")))?;
    Ok(finalize_results(
        resp.results
            .into_iter()
            .map(|r| (r.title, r.url, r.text))
            .collect(),
        limit,
    ))
}

// ─── Exa (keyless hosted-MCP fallback) ──────────────────────────────────────
//
// When NO Exa API key is configured, the dispatcher sends the search through
// Exa's hosted MCP endpoint (`mcp.exa.ai`) instead of erroring. Anonymous
// access is IP-rate-limited (~2 QPS, ~50 calls/day) and mainland-reachable
// without a proxy. This is a hand-rolled JSON-RPC-over-HTTP sequence for ONE
// endpoint — deliberately NOT a general MCP client abstraction (ADR-0049
// position; the 50/day cap doesn't justify MCP machinery).

/// Tolerant shape of an MCP JSON-RPC response. `initialize` parses into the
/// same struct (its `result` is ignored — only a JSON-RPC `error` object is
/// meaningful there). Missing `result`/`error` fields default to `None`, so
/// shape drift yields empty results, not a panic.
#[derive(Deserialize)]
struct McpResponse {
    #[serde(default)]
    result: Option<McpCallResult>,
    #[serde(default)]
    error: Option<McpJsonRpcError>,
}

#[derive(Deserialize)]
struct McpCallResult {
    #[serde(default)]
    content: Vec<McpContent>,
}

#[derive(Deserialize)]
struct McpContent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct McpJsonRpcError {
    code: i64,
    message: String,
}

/// Extract the JSON payload from an SSE-framed (or plain-JSON) MCP response
/// body. Verified wire format: lines of `event: message` followed by
/// `data: {JSON}` — the LAST `data: ` line carries the payload. A body with
/// no `data:` lines is returned unchanged (defensive plain-JSON acceptance).
fn unwrap_sse_json(body: &str) -> &str {
    body.lines()
        .rev()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap_or(body)
        .trim()
}

/// Map a non-2xx MCP step status to the keyless error. HTTP 429 at ANY step
/// is the anonymous IP-quota signal — surfaced with the fix hint instead of
/// a bare status (no retry loop; the 429 surfaces immediately by design).
fn exa_keyless_status_err(step: &str, status: reqwest::StatusCode) -> DbError {
    if status.as_u16() == 429 {
        DbError::Internal(
            "exa keyless quota exceeded (IP-limited ~50/day) — add an Exa API key in Settings \
             or switch search provider"
                .into(),
        )
    } else {
        DbError::Internal(format!(
            "exa keyless search failed: {step} returned HTTP {status}"
        ))
    }
}

/// Format a JSON-RPC `error` object from an MCP response as the keyless
/// error (code + server message).
fn exa_keyless_rpc_err(err: &McpJsonRpcError) -> DbError {
    DbError::Internal(format!(
        "exa keyless search failed: JSON-RPC error {}: {}",
        err.code, err.message
    ))
}

/// Start a POST to the MCP endpoint with the required headers: JSON body +
/// SSE-accepting `Accept`, plus the `mcp-session-id` header once the session
/// is initialized.
fn mcp_post(
    client: &reqwest::Client,
    session_id: Option<&str>,
    body: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let mut req = client
        .post(EXA_MCP_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .json(body);
    if let Some(sid) = session_id {
        req = req.header("mcp-session-id", sid);
    }
    req
}

/// Keyless Exa search via the hosted MCP endpoint (`mcp.exa.ai`).
///
/// Verified wire protocol (live-tested; follow exactly):
///   1. `initialize` → 200; the `mcp-session-id` RESPONSE header carries the
///      session uuid; body is SSE-framed (parsed only to surface a JSON-RPC
///      error — the result is ignored).
///   2. `notifications/initialized` → 200/204, body possibly empty — ignored.
///   3. `tools/call` (`web_search_exa`) → 200; the SSE-framed body's
///      `result.content[0].text` holds the plain-text result blob parsed by
///      [`parse_exa_mcp_text`].
///
/// Redaction: the query and response text are user content (NEVER tier) —
/// only the dispatch-level DEBUG log fires (metadata fields only, see
/// `dispatch_web_search`). The session id is likewise omitted from logs.
async fn exa_search_keyless(query: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    let client = http_client()?;

    // ── 1. initialize — capture the session id from the response header ──
    let init_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {
                "name": "sluver",
                "version": env!("CARGO_PKG_VERSION"),
            },
        },
    });
    let resp = mcp_post(&client, None, &init_body)
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("exa keyless search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(exa_keyless_status_err("initialize", resp.status()));
    }
    // Read the header BEFORE the body consumes the response.
    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| {
            DbError::Internal(
                "exa keyless search failed: initialize response missing mcp-session-id header"
                    .into(),
            )
        })?;
    let init_text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("exa keyless search failed: {e}")))?;
    if let Some(err) = serde_json::from_str::<McpResponse>(unwrap_sse_json(&init_text))
        .map_err(|e| {
            DbError::Internal(format!(
                "exa keyless search failed: invalid initialize response: {e}"
            ))
        })?
        .error
    {
        return Err(exa_keyless_rpc_err(&err));
    }

    // ── 2. initialized notification — response body may be empty, ignore ──
    let initialized_body =
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let resp = mcp_post(&client, Some(&session_id), &initialized_body)
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("exa keyless search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(exa_keyless_status_err(
            "notifications/initialized",
            resp.status(),
        ));
    }

    // ── 3. tools/call — the actual search ────────────────────────────────
    let call_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "web_search_exa",
            "arguments": { "query": query, "numResults": limit },
        },
    });
    let resp = mcp_post(&client, Some(&session_id), &call_body)
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("exa keyless search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(exa_keyless_status_err("tools/call", resp.status()));
    }
    let call_text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("exa keyless search failed: {e}")))?;
    let call: McpResponse = serde_json::from_str(unwrap_sse_json(&call_text)).map_err(|e| {
        DbError::Internal(format!(
            "exa keyless search failed: invalid tools/call response: {e}"
        ))
    })?;
    if let Some(err) = &call.error {
        return Err(exa_keyless_rpc_err(err));
    }
    // `result.content[0].text` (defensively: the first text-typed content
    // item). A missing result/content yields an empty blob → empty results,
    // consistent with the other REST providers' shape-drift tolerance.
    let text = call
        .result
        .map(|r| {
            r.content
                .into_iter()
                .find(|c| c.kind == "text")
                .map(|c| c.text)
                .unwrap_or_default()
        })
        .unwrap_or_default();

    Ok(parse_exa_mcp_text(&text, limit))
}

/// Parse the plain-text result blob of the Exa MCP `web_search_exa` tool
/// into a `Vec<SearchResult>`.
///
/// Verified format — entries separated by lines that are exactly `---`,
/// each entry:
///
/// ```text
/// Title: The Rust Programming Language
/// URL: https://doc.rust-lang.org/stable/book/
/// Published: N/A
/// Author: N/A
/// Highlights:
/// ...multi-line snippet...
/// ```
///
/// Line-based state machine: `Title: `/`URL: ` prefixed lines are collected
/// while NOT in highlights; everything after the `Highlights:` line until
/// the next `---` separator (or EOF) is the snippet (joined with a space,
/// whitespace collapsed). `Published:`/`Author:` lines are ignored. Entries
/// without an http(s) URL are skipped; dedup/snippet-truncation/limit capping
/// reuse [`finalize_results`].
fn parse_exa_mcp_text(text: &str, limit: usize) -> Vec<SearchResult> {
    /// One entry being accumulated by the line scanner.
    struct McpEntry {
        title: String,
        url: String,
        snippet_lines: Vec<String>,
    }

    /// Append a completed entry (if it has a usable http(s) URL), joining +
    /// collapsing its snippet lines.
    fn flush(entry: Option<McpEntry>, out: &mut Vec<(String, String, String)>) {
        let Some(e) = entry else { return };
        if !(e.url.starts_with("http://") || e.url.starts_with("https://")) {
            return;
        }
        let snippet = e.snippet_lines.join(" ");
        let collapsed = snippet.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push((e.title, e.url, collapsed));
    }

    let mut entries: Vec<(String, String, String)> = Vec::new();
    let mut current: Option<McpEntry> = None;
    let mut in_highlights = false;

    for raw_line in text.lines() {
        let line = raw_line.trim_end();
        if line.trim() == "---" {
            flush(current.take(), &mut entries);
            in_highlights = false;
            continue;
        }
        // Lazily start an entry at the entry's first field line.
        let entry = current.get_or_insert_with(|| McpEntry {
            title: String::new(),
            url: String::new(),
            snippet_lines: Vec::new(),
        });
        if in_highlights {
            entry.snippet_lines.push(line.to_string());
        } else if let Some(t) = line.strip_prefix("Title: ") {
            entry.title = t.trim().to_string();
        } else if let Some(u) = line.strip_prefix("URL: ") {
            entry.url = u.trim().to_string();
        } else if line.trim() == "Highlights:" {
            in_highlights = true;
        }
        // `Published:` / `Author:` / blank lines before `Highlights:` are
        // intentionally ignored.
    }
    flush(current.take(), &mut entries);

    finalize_results(entries, limit)
}

// ─── Jina ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct JinaResponse {
    #[serde(default)]
    data: Vec<JinaResult>,
}

#[derive(Deserialize)]
struct JinaResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    content: String,
}

async fn jina_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    _locale: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let resp = client
        .get(JINA_SEARCH_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .query(&[("q", query), ("count", &limit.to_string())])
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("jina search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "jina search failed: HTTP {}",
            resp.status()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("jina search failed: {e}")))?;
    parse_jina_response(&text, limit)
}

fn parse_jina_response(body: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    let resp: JinaResponse = serde_json::from_str(body)
        .map_err(|e| DbError::Internal(format!("jina search failed: invalid response: {e}")))?;
    Ok(finalize_results(
        resp.data
            .into_iter()
            .map(|r| {
                // Defensive: the `s.jina.ai/search` payload normally carries
                // `description`, but tolerate a `content`-only shape.
                let snippet = if r.description.trim().is_empty() {
                    r.content
                } else {
                    r.description
                };
                (r.title, r.url, snippet)
            })
            .collect(),
        limit,
    ))
}

// ─── Brave ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct BraveResponse {
    #[serde(default)]
    web: Option<BraveWeb>,
}

#[derive(Deserialize)]
struct BraveWeb {
    #[serde(default)]
    results: Vec<BraveResult>,
}

#[derive(Deserialize)]
struct BraveResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    description: String,
}

async fn brave_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    _locale: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let resp = client
        .get(BRAVE_SEARCH_URL)
        .header("X-Subscription-Token", key)
        .header(reqwest::header::ACCEPT, "application/json")
        .query(&[("q", query), ("count", &limit.to_string())])
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("brave search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "brave search failed: HTTP {}",
            resp.status()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("brave search failed: {e}")))?;
    parse_brave_response(&text, limit)
}

fn parse_brave_response(body: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    let resp: BraveResponse = serde_json::from_str(body)
        .map_err(|e| DbError::Internal(format!("brave search failed: invalid response: {e}")))?;
    Ok(finalize_results(
        resp.web
            .map(|w| w.results)
            .unwrap_or_default()
            .into_iter()
            .map(|r| (r.title, r.url, r.description))
            .collect(),
        limit,
    ))
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
        let title = link_el.text().collect::<String>().trim().to_string();
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

/// Shared post-mapping for every non-Bing result source (BYOK providers +
/// Baidu SERP): drop entries with a blank URL, dedup by URL, trim title,
/// truncate snippets to ~500 CHARS (UTF-8 safe), cap at `limit`.
fn finalize_results(entries: Vec<(String, String, String)>, limit: usize) -> Vec<SearchResult> {
    const MAX_SNIPPET_CHARS: usize = 500;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (title, url, snippet) in entries {
        if out.len() >= limit {
            break;
        }
        let url = url.trim();
        if url.is_empty() || !seen.insert(url.to_string()) {
            continue;
        }
        out.push(SearchResult {
            title: title.trim().to_string(),
            url: url.to_string(),
            snippet: snippet.chars().take(MAX_SNIPPET_CHARS).collect(),
        });
    }
    out
}

/// Parse Baidu's HTML SERP into a `Vec<SearchResult>`, truncated to `limit`.
///
/// Verified against a real `https://www.baidu.com/s?wd=...` fixture (see
/// `commands/tests/fixtures/baidu_serp.html`):
///   - Organic containers are `#content_left > div.result`. Cards that ALSO
///     carry the `result-op` class are operational/recommend widgets and are
///     excluded — their `mu` targets are fake hosts like
///     `http://28616.recommend_list.baidu.com`.
///   - The organic URL is the container's `mu` attribute. The `h3 a` href is
///     a `www.baidu.com/link?url=` redirect and is NEVER used — results
///     without a usable `mu` (missing, non-http, or a `*.baidu.com` host)
///     are skipped outright.
///   - Title = `h3 a` combined text (trimmed; `<em>` highlights flatten).
///   - Snippet = first `span[class*="content-right"]`, else `.c-abstract`,
///     else empty. Whitespace-trimmed.
///   - Dedup by URL + cap at `limit` via [`finalize_results`].
fn parse_baidu_results(html: &str, limit: usize) -> Result<Vec<SearchResult>, DbError> {
    if html.is_empty() {
        return Ok(Vec::new());
    }

    let document = scraper::Html::parse_document(html);

    let container_sel = parse_selector("#content_left > div.result")?;
    let title_sel = parse_selector("h3 a")?;
    let snippet_span_sel = parse_selector(r#"span[class*="content-right"]"#)?;
    let abstract_sel = parse_selector(".c-abstract")?;

    let mut entries = Vec::new();
    for node in document.select(&container_sel) {
        // Operational/recommend cards (`class="result result-op ..."`).
        if node.value().classes().any(|c| c == "result-op") {
            continue;
        }

        // The real destination URL. Skip anything without an external `mu`.
        let Some(mu) = node.value().attr("mu") else {
            continue;
        };
        if !mu.starts_with("http") {
            continue;
        }
        let Ok(parsed) = Url::parse(mu) else {
            continue;
        };
        let host = parsed.host_str().unwrap_or_default();
        if host == "baidu.com" || host.ends_with(".baidu.com") {
            continue;
        }

        let title = node
            .select(&title_sel)
            .next()
            .map(|a| a.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let snippet = node
            .select(&snippet_span_sel)
            .next()
            .or_else(|| node.select(&abstract_sel).next())
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        entries.push((title, mu.to_string(), snippet));
    }

    Ok(finalize_results(entries, limit))
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
    let accept_language = locale.as_deref().filter(|s| !s.is_empty()).unwrap_or("en");

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
// Hidden-WebView2 machinery (shared by fetch_url_via_webview + search)
// ═══════════════════════════════════════════════════════════════════════════
//
// Both the URL fetcher and the builtin search engines drive the same hidden
// window lifecycle; the steps below were extracted (behavior-identical) from
// the original inline `fetch_url_via_webview` body:
//   1. `create_hidden_nav_window` — build on the main thread (WebView2
//      deadlock avoidance), `on_page_load(Finished)` → `Notify`.
//   2. `wait_for_page_load` — await the notify with a timeout.
//   3. `eval_js_string` / `eval_rendered_html` / `poll_until_selector` —
//      extract rendered state via native `ICoreWebView2::ExecuteScript`.
// Callers own the close discipline: the window is ALWAYS closed, success or
// failure (see the `let outcome = { ... }.await; let _ = window.close();`
// pattern in both commands below).

/// Build a hidden, non-decorated `WebviewWindow` navigating to `target` on
/// the main thread (WebView2 window creation has main-thread affinity —
/// same pattern as `window_manager::ensure_space_window`).
///
/// `loaded` is notified when `PageLoadEvent::Finished` fires. Uses
/// `tokio::sync::oneshot` (not `std::sync::mpsc`) so the build-wait is a
/// non-blocking `.await` on the tokio runtime. Returns the built window
/// handle (re-resolved via `get_webview_window` after the build result).
#[cfg(target_os = "windows")]
async fn create_hidden_nav_window(
    app: &tauri::AppHandle,
    label: &str,
    target: &Url,
    loaded: &std::sync::Arc<tokio::sync::Notify>,
) -> Result<tauri::WebviewWindow, DbError> {
    let (build_tx, build_rx) = tokio::sync::oneshot::channel::<Result<(), DbError>>();
    let app_for_main = app.clone();
    let label_for_main = label.to_string();
    let target_for_build = target.clone();
    let loaded_cb = loaded.clone();

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

    app.get_webview_window(label)
        .ok_or_else(|| DbError::Internal("webview window not found after build".into()))
}

/// Await the `PageLoadEvent::Finished` notification with a timeout.
/// Anti-bot challenge pages can legitimately take 10-15s, so callers pass a
/// generous ceiling (30s).
#[cfg(target_os = "windows")]
async fn wait_for_page_load(
    loaded: &tokio::sync::Notify,
    timeout: std::time::Duration,
) -> Result<(), DbError> {
    tokio::time::timeout(timeout, loaded.notified())
        .await
        .map(|_| ())
        .map_err(|_| {
            DbError::Internal(format!(
                "webview page load timed out ({}s)",
                timeout.as_secs()
            ))
        })
}

/// Evaluate an arbitrary JS expression in a WebView2 window and return the
/// result as a string, via native `ICoreWebView2::ExecuteScript`.
///
/// `WebviewWindow::eval` is fire-and-forget — it returns `Result<()>` and
/// discards the JS return value. To get a value back to Rust, we drop down
/// to the platform webview via `with_webview` and invoke `ExecuteScript`,
/// which provides the result via a completion callback. The result arrives
/// as a JSON-encoded value (double-quoted for a string return), which we
/// unwrap via `serde_json` — non-string values (e.g. a number from a
/// `.length` count) stringify via `Value::to_string()`.
///
/// The `with_webview` closure runs synchronously on the webview thread; we
/// bridge the `ExecuteScript` result back to the async caller via an
/// `mpsc` channel consumed inside `spawn_blocking` (avoiding tokio block).
#[cfg(target_os = "windows")]
async fn eval_js_string(
    window: &tauri::WebviewWindow,
    js: &str,
    timeout: std::time::Duration,
) -> Result<String, DbError> {
    use std::sync::mpsc;
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    // The with_webview closure must be 'static — own the script text.
    let js = js.to_string();

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

            let js = HSTRING::from(js.as_str());
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
        rx.recv_timeout(timeout)
            .map_err(|e| DbError::Internal(format!("ExecuteScript channel timed out: {e}")))
    })
    .await
    .map_err(|e| DbError::Internal(format!("spawn_blocking join error: {e}")))??;

    let json_string = raw_result.map_err(DbError::Internal)?;

    // WebView2 returns the JS result as a JSON-encoded value. For a string
    // return the raw value is "\"<...>\"" — unwrap one JSON string layer.
    if json_string.is_empty() {
        return Err(DbError::Internal(
            "ExecuteScript returned empty result".into(),
        ));
    }

    match serde_json::from_str::<serde_json::Value>(&json_string) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        Ok(other) => Ok(other.to_string()),
        Err(_) => Ok(json_string), // best-effort fallback
    }
}

/// Extract the fully rendered HTML of a WebView2 window
/// (`document.documentElement.outerHTML`, 15s script timeout).
#[cfg(target_os = "windows")]
async fn eval_rendered_html(
    window: &tauri::WebviewWindow,
    timeout: std::time::Duration,
) -> Result<String, DbError> {
    eval_js_string(window, "document.documentElement.outerHTML", timeout).await
}

/// Poll a JS count expression (e.g. `document.querySelectorAll('...').length`)
/// every 500ms until it is `>= min_count` or `deadline` elapses.
///
/// SERPs hydrate client-side: `PageLoadEvent::Finished` fires before the
/// results container is populated. A deadline of ~8s covers slow Bing/Baidu
/// hydration without turning a dead page into a long hang (the page-load
/// wait already consumed the generous share of the budget).
#[cfg(target_os = "windows")]
async fn poll_until_selector(
    window: &tauri::WebviewWindow,
    selector_css_count_js: &str,
    min_count: usize,
    deadline: std::time::Duration,
) -> Result<(), DbError> {
    let started = std::time::Instant::now();
    loop {
        let raw = eval_js_string(
            window,
            selector_css_count_js,
            std::time::Duration::from_secs(5),
        )
        .await?;
        let count: f64 = raw.trim().parse().map_err(|_| {
            DbError::Internal(format!(
                "selector count JS returned a non-numeric result: {raw:.40}..."
            ))
        })?;
        if count >= min_count as f64 {
            return Ok(());
        }
        if started.elapsed() >= deadline {
            return Err(DbError::Internal(
                "timed out waiting for search results to render".into(),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
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
///    pattern as `open_space_window`) via [`create_hidden_nav_window`].
/// 2. Wait for `PageLoadEvent::Finished` (30s timeout for anti-bot JS).
/// 3. Extract HTML via `ExecuteScript`; retry up to 3× if the page looks
///    like an anti-bot challenge interstitial (Cloudflare, PerimeterX, etc.).
/// 4. Close window (always — success or failure), run Readability
///    extraction (reuse [`extract_page`]).
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
    let target: Url =
        Url::parse(&url).map_err(|e| DbError::Internal(format!("invalid URL: {e}")))?;

    // Restrict to http(s) — WebView2 will happily load file:/// and data:
    // URLs, which could expose local file contents to the agent.
    if !matches!(target.scheme(), "http" | "https") {
        return Err(DbError::Internal("only http(s) URLs are supported".into()));
    }

    let label = format!("webview-fetcher-{}", crate::util::new_id());
    let loaded = std::sync::Arc::new(tokio::sync::Notify::new());

    // ── 1. Build hidden window on main thread (avoid WebView2 deadlock) ────
    let window = create_hidden_nav_window(&app, &label, &target, &loaded).await?;

    // ── 2-3. Wait for load; extract HTML with anti-bot challenge retry ─────
    //
    // Anti-bot challenges (Cloudflare, PerimeterX, etc.) fire `Finished` for
    // the challenge interstitial FIRST, then redirect to the real page after
    // 5-10s. Instead of a blind fixed delay, we extract immediately and retry
    // if the result looks like a challenge page. Normal sites return on the
    // first attempt with zero added latency.
    let html = async {
        wait_for_page_load(&loaded, std::time::Duration::from_secs(30)).await?;
        let mut attempts = 0u8;
        loop {
            match eval_rendered_html(&window, std::time::Duration::from_secs(15)).await {
                Ok(h) if !looks_like_challenge(&h) => return Ok(h),
                Ok(_) if attempts < 3 => {
                    attempts += 1;
                    tracing::debug!(
                        attempt = attempts,
                        "anti-bot challenge page detected, retrying"
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
                Ok(h) => return Ok(h), // give up retrying, return what we have
                Err(e) => return Err(e),
            }
        }
    }
    .await;

    // ── 4. Always close the window ────────────────────────────────────────
    let _ = window.close();

    let html = html?;

    // ── 5. Run Readability extraction (reuse extract_page) ────────────────
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
// Builtin webview search engines (ADR-0049)
// ═══════════════════════════════════════════════════════════════════════════

/// Which keyless builtin SERP engine a webview search targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchEngine {
    /// `https://www.bing.com/search?q=...&adlt=moderate` (cn.bing.com
    /// redirect happens naturally). Parsed by [`parse_results`].
    Bing,
    /// `https://www.baidu.com/s?wd=...&ie=utf-8`. Parsed by
    /// [`parse_baidu_results`]. No reqwest fallback — Baidu TLS-blocks
    /// non-browser clients.
    Baidu,
}

/// Run a keyless SERP search in a hidden WebView2 window.
///
/// Flow: build engine URL → create hidden window (label prefix
/// `webview-searcher-`) → wait for page load (30s, anti-bot JS budget) →
/// poll until the engine's organic-result selector count is ≥ 1 (~8s
/// hydration budget) → extract outerHTML → parse with the engine parser →
/// ALWAYS close the window.
///
/// Failure semantics: an anti-bot challenge page, a hydration timeout, or
/// zero parseable results are ALL errors (the Bing caller falls back to the
/// reqwest scrape; the Baidu caller surfaces the error). Baidu 安全验证
/// pages surface immediately — no retry loop by design.
///
/// `locale` is accepted for parity with the dispatch signature but not yet
/// wired to WebView2's `Accept-Language` (same deferral as
/// [`fetch_url_via_webview`]).
#[cfg(target_os = "windows")]
async fn search_web_via_webview(
    app: &tauri::AppHandle,
    engine: SearchEngine,
    query: &str,
    locale: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, DbError> {
    let _ = locale;
    let (base_url, count_js): (&str, &str) = match engine {
        SearchEngine::Bing => (
            BING_SEARCH_URL,
            "document.querySelectorAll('li.b_algo').length",
        ),
        SearchEngine::Baidu => (
            BAIDU_SEARCH_URL,
            "document.querySelectorAll('#content_left div.result').length",
        ),
    };

    let mut target = Url::parse(base_url)
        .map_err(|e| DbError::Internal(format!("invalid search engine URL: {e}")))?;
    {
        let mut pairs = target.query_pairs_mut();
        match engine {
            SearchEngine::Bing => {
                pairs.append_pair("q", query);
                pairs.append_pair("adlt", "moderate");
            }
            SearchEngine::Baidu => {
                pairs.append_pair("wd", query);
                pairs.append_pair("ie", "utf-8");
            }
        }
    }

    let label = format!("webview-searcher-{}", crate::util::new_id());
    let loaded = std::sync::Arc::new(tokio::sync::Notify::new());

    let window = create_hidden_nav_window(app, &label, &target, &loaded).await?;

    // Inner flow: ANY failure still closes the window on the way out.
    let outcome = async {
        wait_for_page_load(&loaded, std::time::Duration::from_secs(30)).await?;
        poll_until_selector(&window, count_js, 1, std::time::Duration::from_secs(8)).await?;
        let html = eval_rendered_html(&window, std::time::Duration::from_secs(15)).await?;
        if looks_like_challenge(&html) {
            return Err(DbError::Internal(
                "search engine returned an anti-bot challenge page".into(),
            ));
        }
        let results = match engine {
            SearchEngine::Bing => parse_results(&html, max_results)?,
            SearchEngine::Baidu => parse_baidu_results(&html, max_results)?,
        };
        if results.is_empty() {
            return Err(DbError::Internal(
                "search engine returned no parseable results".into(),
            ));
        }
        Ok(results)
    }
    .await;

    // Always close the window (existing close discipline).
    let _ = window.close();
    outcome
}

/// Non-Windows stub — the SERP engines are WebView2-only. The Bing caller
/// treats this as just another webview failure and falls back to the
/// reqwest scrape; the Baidu caller surfaces the error to the user.
#[cfg(not(target_os = "windows"))]
async fn search_web_via_webview(
    _app: &tauri::AppHandle,
    engine: SearchEngine,
    _query: &str,
    _locale: &str,
    _max_results: usize,
) -> Result<Vec<SearchResult>, DbError> {
    match engine {
        SearchEngine::Bing => Err(DbError::Internal(
            "bing webview search is only supported on Windows".into(),
        )),
        SearchEngine::Baidu => Err(DbError::Internal(
            "baidu search engine requires WebView2 (Windows only)".into(),
        )),
    }
}

/// Heuristic check: does this HTML look like an anti-bot challenge page?
///
/// Returns `true` for common challenge interstitial markers (Cloudflare,
/// Turnstile, PerimeterX/HUMAN). Used by the retry loop in
/// [`fetch_url_via_webview`] and the failure check in
/// [`search_web_via_webview`] to decide whether to wait and re-extract.
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
/// Steps 1, 3-5 live in shared `pub(crate)` helpers in `commands/image.rs`
/// (`parse_http_url` + `download_image_bytes` + `crop_resize_encode_webp`),
/// which `prepare_image` also calls — one download + crop pipeline, no drift.
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
    // ── 1. Validate URL + args ──────────────────────────────────────────
    // URL parse + http(s) scheme guard live in the shared helper
    // (`commands::image::parse_http_url`) so this command and
    // `prepare_image` cannot drift. Same rationale as
    // `fetch_url_via_webview`: the image crate is happy to decode file:///
    // and data: URLs, which would expose local file contents to the agent.
    let target = crate::commands::image::parse_http_url(&url)?;
    if !(aspect.is_finite() && aspect > 0.0) {
        return Err(DbError::Internal(format!("invalid aspect ratio: {aspect}")));
    }
    if output_width == 0 || output_height == 0 {
        return Err(DbError::Internal(
            "output_width and output_height must be positive".into(),
        ));
    }

    // ── 2. Download bytes (reuse the Chrome UA + timeout from fetch_url) ─
    // Shared helper (`commands::image::download_image_bytes`) — identical
    // client builder, UA, accept header, and timeout as before the
    // extraction.
    let bytes = crate::commands::image::download_image_bytes(&target).await?;

    // ── 3. Decode (auto-detect format) ──────────────────────────────────
    let img = image::load_from_memory(&bytes)
        .map_err(|e| DbError::Internal(format!("image decode failed: {e}")))?;

    // ── 4-6. Center-crop + Lanczos3 resize + lossless WebP encode ──────
    // Shared helper (`commands::image::crop_resize_encode_webp`) — the
    // verbatim crop math + resize + encode this command has always used.
    let out_bytes =
        crate::commands::image::crop_resize_encode_webp(&img, aspect, output_width, output_height)?;

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

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "tests/search.rs"]
mod search_tests;
