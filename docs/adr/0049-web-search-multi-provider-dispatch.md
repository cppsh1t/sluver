# ADR-0049: Web search multi-provider dispatch

**Status**: accepted.

## Context

The agent's `web_search` tool was a keyless Bing SERP HTML scraper (`commands/search.rs`). `docs/web-search-tool-relevance-investigation.md` (2026-08-19) diagnosed why it returned mostly irrelevant results: Bing serves degraded SERPs to non-browser TLS clients (reqwest has no JA3/JA4 masking), the parser had zero result post-processing, and there was no fallback. The Bing Search API no longer exists as an alternative (Microsoft retired it in 2025), and no other engine offers an unlimited keyless HTTP API.

Requirements that shaped this decision:

- zh-CN writers are the primary audience. Of the major engines, only Bing (`cn.bing.com` redirect) and Baidu are natively reachable from mainland networks without a proxy. Everything else (Tavily, Serper, Exa, Jina, Brave, DDG) requires the user's own proxy — that is explicitly the user's responsibility, not the app's.
- Baidu's anti-bot is TLS-fingerprint-based: plain reqwest is detected at handshake. But a real WebView2 presents a genuine Chrome TLS fingerprint, real cookie jar, and the user's residential IP — exactly what Baidu's defenses expect from a human.
- The codebase already ships a hidden-WebView2 fetch path (`fetch_url_via_webview`, ADR-era infrastructure for `web_fetch_via_browser`) whose window lifecycle is directly reusable for loading SERPs.

## Decision

### 1. `search_web` becomes a provider dispatcher; the tool surface is frozen

The TS layer (`websearch.ts` tool def, `src/api/search.ts`, `SearchResult` DTO) is untouched. `search_web(query, locale?, max_results?)` gains only Tauri-injected parameters (an `AppHandle` for the webview engines plus the `DbManager` state used to read settings — invisible to the frontend invoke) and routes to the configured provider. Providers are two keyless builtin engines plus five BYOK REST APIs:

| Provider id | Kind | Notes |
|---|---|---|
| `builtin-bing` (default) | keyless | WebView2 SERP; falls back to the legacy reqwest scrape |
| `builtin-baidu` | keyless | WebView2 SERP; Windows-only, no reqwest fallback |
| `tavily` / `serper` / `exa` / `jina` / `brave` | BYOK | Single-endpoint REST, reqwest + serde |

Failure semantics: `builtin-bing` degrades internally (webview → legacy scraper); keyed providers propagate errors (provider name + HTTP status) so a bad key is visible to the agent instead of silently masked; `builtin-baidu` without WebView2 is a hard error.

### 2. Builtin engines run SERPs through the hidden WebView2

The window lifecycle of `fetch_url_via_webview` (hidden window on the main thread, `PageLoadEvent::Finished` notification, `ICoreWebView2::ExecuteScript` COM bridge, unconditional close) is extracted into reusable helpers. Search adds one step fetch never needed: a render poll (`querySelectorAll(...).length` via the same JS bridge, 500 ms interval, ~8 s budget) because JS-rendered SERPs may not have results in the DOM when `Finished` fires. This is the fix for the root cause — the engine sees a real browser, so it serves a real SERP.

Baidu parsing (verified against a live-captured fixture): organic containers are `#content_left div.result` excluding `result-op` operational cards; the real target URL comes from the container's `mu` attribute (never the `/link?url=` redirect `href`); snippets from `content-right*`/`c-abstract` spans. `百度安全验证` is surfaced as an error immediately — no retry hammering.

### 3. Settings are app-global in meta.db, following the ADR-0046 precedent

`app.webSearch` key in the meta.db `settings` table holds `{provider, apiKeys}` (camelCase JSON, kebab-case provider ids). Global, not Space-scoped: search is a global utility today (`search_web` takes no Space/World argument), and a user's engine choice and Tavily key do not vary per World. API keys are stored as plaintext under the ADR-0013 threat model (same as LLM keys). `get_/set_web_search_settings` are full-replacement read-back commands; a missing or corrupt row yields defaults (`builtin-bing`), never an error.

### 4. Proxies are the user's, and we honor the OS setting

No proxy configuration exists in the app. WebView2 engine requests use the OS proxy natively; for the BYOK reqwest clients the `system-proxy` feature is enabled so Clash-style system proxies are honored with zero configuration. Users behind no proxy simply use the builtin engines. Live connectivity probing from a mainland direct connection (2026-09-12) also showed `api.exa.ai`, `mcp.exa.ai`, and `api.tavily.com` are reachable WITHOUT a proxy (Cloudflare-fronted), while `s.jina.ai`, `r.jina.ai`, and `api.search.brave.com` time out — the Settings copy marks the proxy-free options accordingly.

### 5. Exa is dual-tier: keyless MCP when no key, REST when keyed

The `exa` provider routes on key presence. Without a key it uses the hosted keyless MCP endpoint `mcp.exa.ai/mcp?tools=web_search_exa` (anonymous, IP-limited ~2 QPS + ~50 calls/day, no proxy needed) via a hand-rolled three-POST JSON-RPC sequence — initialize (capture `mcp-session-id`) → `notifications/initialized` → `tools/call` — unwrapping the SSE-framed responses and parsing the `Title:/URL:/Highlights:` text blob. With a key it uses the ordinary `api.exa.ai/search` REST call. This is deliberately NOT a general MCP client: one function for one endpoint, no session reuse across calls, HTTP 429 surfaces immediately as a "quota exceeded — add a key or switch provider" error.

## Consequences

- The legacy Bing scraper survives as the `builtin-bing` fallback (and the non-Windows path); its known quality limits are acceptable only in that degraded role. Parser behavior for both engines is pinned by fixture tests (`commands/tests/fixtures/*.html`, captured from live SERPs) — search code previously had zero tests.
- Baidu engine availability is Windows-only, matching the app's Windows-first platform posture (ADR-0036, WebView2 fetch precedent). `ie=utf-8` is requested; because extraction reads the browser-decoded DOM string, no gb18030 handling is needed on the webview path.
- Adding a future provider (e.g. SearXNG self-hosted endpoint, SerpAPI) is a ~100-line module plus one enum variant plus Settings UI copy; public SearXNG instances were evaluated and rejected (JSON API disabled + Anubis anti-bot on effectively all public instances, verified 2026-07).
- Free-tier facts baked into the Settings UI copy (Tavily 1,000/mo, Serper 2,500 one-time, Exa keyless ~50/day + $10/mo with key, Jina ~1,000 sign-up, Brave none) will drift; they are descriptive hints, not contracts.
- A smoke-test example bin (`examples/webview_search_smoke.rs`) exercises the builtin engines end-to-end against live engines — the webview path cannot be unit-tested under the crate's no-mock-runtime rule.

## Alternatives considered

- **App-provided pooled quota** (developer-hosted relay with shared keys) — rejected: real infrastructure cost and abuse exposure for a desktop app; per-IP keyless quotas (Jina `r.jina.ai` 20 RPM) were the only zero-cost variant and are fetch-oriented, mainland-proxy-blocked, and rate-capped.
- **Keyed-provider-only (no builtin engines)** — rejected: strands every mainland user without a proxy, and forfeits the only fix for the TLS-fingerprint root cause.
- **Plain-reqwest Baidu** — rejected: JA4 fingerprint detection makes it a guaranteed `百度安全验证`; no maintained Rust Baidu-scraping crate exists.
- **Exa keyless MCP delegation** (the reference project's approach) — initially rejected per the investigation report (MCP client machinery for a 50/day anonymous cap), then **adopted in narrowed form** as Decision §5 after live verification (2026-09-12) showed `mcp.exa.ai` is mainland-reachable without a proxy and the protocol reduces to three stateless JSON POSTs. A full MCP client integration remains rejected.
- **DuckDuckGo HTML endpoint as a keyless builtin** — rejected: blocked in mainland networks and increasingly CAPTCHA'd; adds a third engine to maintain for little marginal reach.

## References

- `docs/web-search-tool-relevance-investigation.md` — root-cause investigation that motivated this ADR
- ADR-0013 (API key plaintext storage), ADR-0046 (global-settings precedent in meta.db)
- ADR-0014/0016 (logging stack; dispatch logs metadata only — never query text)
