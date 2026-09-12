use super::*;

// Real SERP fixtures captured from live engines (see the fixtures/ dir).
// The Bing fixture holds 10 `li.b_algo` results; the Baidu fixture holds
// 9 organic `#content_left > div.result` cards plus recommend/op modules.
const BING_SERP_HTML: &str = include_str!("fixtures/bing_serp.html");
const BAIDU_SERP_HTML: &str = include_str!("fixtures/baidu_serp.html");

// ─── Bing SERP parser (existing parse_results) ──────────────────────────────

#[test]
fn parse_results_extracts_bing_fixture() {
    let results = parse_results(BING_SERP_HTML, 20).unwrap();
    assert!(
        results.len() >= 5,
        "expected >= 5 bing results, got {}",
        results.len()
    );
    for r in &results {
        assert!(
            r.url.starts_with("http"),
            "url must start with http: {}",
            r.url
        );
        assert!(!r.title.trim().is_empty(), "title must be non-empty");
    }
}

// ─── Baidu SERP parser (parse_baidu_results) ────────────────────────────────

#[test]
fn parse_baidu_results_extracts_organic_results_only() {
    let results = parse_baidu_results(BAIDU_SERP_HTML, 20).unwrap();
    assert!(
        results.len() >= 5,
        "expected >= 5 organic baidu results, got {}",
        results.len()
    );
    for r in &results {
        assert!(
            !r.url.contains("baidu.com/link"),
            "baidu /link redirect leaked into results: {}",
            r.url
        );
        assert!(
            !r.url.contains("recommend_list"),
            "recommend module leaked into results: {}",
            r.url
        );
        assert!(
            r.url.starts_with("http"),
            "url must start with http: {}",
            r.url
        );
        assert!(!r.title.trim().is_empty(), "title must be non-empty");
    }
}

#[test]
fn parse_baidu_results_dedups_by_url() {
    let results = parse_baidu_results(BAIDU_SERP_HTML, 20).unwrap();
    let mut urls: Vec<&str> = results.iter().map(|r| r.url.as_str()).collect();
    let before = urls.len();
    urls.sort_unstable();
    urls.dedup();
    assert_eq!(before, urls.len(), "duplicate urls in results");
}

#[test]
fn parse_baidu_results_caps_at_limit() {
    let all = parse_baidu_results(BAIDU_SERP_HTML, 20).unwrap();
    let capped = parse_baidu_results(BAIDU_SERP_HTML, 2).unwrap();
    assert_eq!(capped.len(), 2);
    assert_eq!(capped[0].url, all[0].url);
    assert_eq!(capped[1].url, all[1].url);
}

#[test]
fn parse_baidu_results_empty_html_yields_empty() {
    assert!(parse_baidu_results("", 10).unwrap().is_empty());
}

// ─── BYOK provider response parsers ────────────────────────────────────────

#[test]
fn tavily_response_maps_title_url_content() {
    let body = r#"{"results":[
        {"title":"Rust","url":"https://rust-lang.org","content":"empowering everyone"},
        {"title":"No URL","url":"","content":"dropped"}
    ],"query":"rust"}"#;
    let out = parse_tavily_response(body, 5).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].title, "Rust");
    assert_eq!(out[0].url, "https://rust-lang.org");
    assert_eq!(out[0].snippet, "empowering everyone");
}

#[test]
fn serper_response_maps_organic_link_snippet() {
    let body = r#"{"organic":[
        {"title":"T","link":"https://a.example","snippet":"s"},
        {"title":"No snippet","link":"https://b.example"}
    ],"credits":1}"#;
    let out = parse_serper_response(body, 5).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].url, "https://a.example");
    assert_eq!(out[0].snippet, "s");
    assert_eq!(out[1].snippet, "", "missing snippet must default to empty");
}

#[test]
fn exa_response_maps_text_to_snippet() {
    let body = r#"{"results":[
        {"title":"E","url":"https://e.example","text":"extracted text","publishedDate":"2026-01-01"}
    ]}"#;
    let out = parse_exa_response(body, 5).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].title, "E");
    assert_eq!(out[0].snippet, "extracted text");
}

#[test]
fn jina_response_prefers_description_over_content() {
    let body = r#"{"data":[
        {"title":"A","url":"https://a.example","description":"desc","content":"cont"},
        {"title":"B","url":"https://b.example","content":"fallback"}
    ]}"#;
    let out = parse_jina_response(body, 5).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].snippet, "desc");
    assert_eq!(out[1].snippet, "fallback");
}

#[test]
fn brave_response_maps_nested_web_results() {
    let body = r#"{"web":{"results":[
        {"title":"Br","url":"https://br.example","description":"d"}
    ]},"query":{"original":"q"}}"#;
    let out = parse_brave_response(body, 5).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].title, "Br");
    assert_eq!(out[0].url, "https://br.example");
    assert_eq!(out[0].snippet, "d");
}

#[test]
fn provider_responses_tolerate_missing_arrays() {
    // A missing top-level results array yields EMPTY results, not an error
    // (`#[serde(default)]` tolerance — a shape drift must never panic the
    // command).
    assert!(parse_tavily_response(r#"{"query":"x"}"#, 5)
        .unwrap()
        .is_empty());
    assert!(parse_serper_response(r#"{"credits":1}"#, 5)
        .unwrap()
        .is_empty());
    assert!(parse_exa_response(r#"{"requestId":"x"}"#, 5)
        .unwrap()
        .is_empty());
    assert!(parse_jina_response("{}", 5).unwrap().is_empty());
    assert!(parse_brave_response(r#"{"query":{"original":"x"}}"#, 5)
        .unwrap()
        .is_empty());
}

#[test]
fn serper_request_body_adds_zh_locale_params() {
    let zh = serper_request_body("q", "zh-CN", 5);
    assert_eq!(zh["hl"], "zh-cn");
    assert_eq!(zh["gl"], "cn");
    assert_eq!(zh["q"], "q");
    assert_eq!(zh["num"], 5);

    let en = serper_request_body("q", "en", 5);
    assert!(en.get("hl").is_none());
    assert!(en.get("gl").is_none());
}

// ─── shared result post-mapping (finalize_results) ──────────────────────────

#[test]
fn finalize_results_dedups_truncates_and_caps() {
    let long_snippet = "x".repeat(600);
    let entries = vec![
        ("a".into(), "https://a.example".into(), long_snippet),
        // Duplicate URL → dropped.
        ("a2".into(), "https://a.example".into(), "dup".into()),
        // Blank URL → dropped.
        ("b".into(), "   ".into(), "no url".into()),
        ("c".into(), " https://c.example ".into(), "keep".into()),
        (
            "d".into(),
            "https://d.example".into(),
            "cut by limit".into(),
        ),
    ];
    let out = finalize_results(entries, 2);
    assert_eq!(out.len(), 2, "limit must cap the output");
    assert_eq!(out[0].url, "https://a.example");
    assert_eq!(
        out[0].snippet.chars().count(),
        500,
        "snippet must truncate to 500 chars"
    );
    assert_eq!(out[1].url, "https://c.example");
    assert_eq!(out[1].snippet, "keep");
}

// ─── WebSearchSettings serde ────────────────────────────────────────────────

#[test]
fn web_search_settings_serde_round_trip() {
    // Every provider variant round-trips through its kebab-case literal.
    let variants = [
        (WebSearchProvider::BuiltinBing, "builtin-bing"),
        (WebSearchProvider::BuiltinBaidu, "builtin-baidu"),
        (WebSearchProvider::Tavily, "tavily"),
        (WebSearchProvider::Serper, "serper"),
        (WebSearchProvider::Exa, "exa"),
        (WebSearchProvider::Jina, "jina"),
        (WebSearchProvider::Brave, "brave"),
    ];
    for (variant, literal) in variants {
        let ser = serde_json::to_string(&WebSearchSettings {
            provider: variant,
            api_keys: WebSearchApiKeys::default(),
        })
        .unwrap();
        assert!(
            ser.contains(&format!("\"{literal}\"")),
            "{ser} must embed provider literal {literal}"
        );
        let de: WebSearchSettings = serde_json::from_str(&ser).unwrap();
        assert_eq!(de.provider, variant);
    }

    // camelCase `apiKeys` key + field mapping.
    let s: WebSearchSettings =
        serde_json::from_str(r#"{"provider":"tavily","apiKeys":{"tavily":"k1","brave":"k2"}}"#)
            .unwrap();
    assert_eq!(s.provider, WebSearchProvider::Tavily);
    assert_eq!(s.api_keys.tavily.as_deref(), Some("k1"));
    assert_eq!(s.api_keys.brave.as_deref(), Some("k2"));

    // Missing `apiKeys` field deserializes to the default (all keys None).
    let s: WebSearchSettings = serde_json::from_str(r#"{"provider":"builtin-baidu"}"#).unwrap();
    assert_eq!(s.provider, WebSearchProvider::BuiltinBaidu);
    assert!(s.api_keys.tavily.is_none());
    assert!(s.api_keys.serper.is_none());
    assert!(s.api_keys.exa.is_none());
    assert!(s.api_keys.jina.is_none());
    assert!(s.api_keys.brave.is_none());
}

// ─── WebSearchSettings persistence (meta.db `settings` KV) ─────────────────

#[test]
fn web_search_settings_persist_round_trip_and_corrupt_defaults() {
    let fx = crate::testutil::make_space_with_world();

    // No row yet → defaults (builtin-bing, no keys), NOT an error.
    let d = do_get_web_search_settings(&fx.mgr).unwrap();
    assert_eq!(d.provider, WebSearchProvider::BuiltinBing);
    assert!(d.api_keys.tavily.is_none());

    // set → read-back (do_set returns the persisted row).
    let settings = WebSearchSettings {
        provider: WebSearchProvider::Brave,
        api_keys: WebSearchApiKeys {
            tavily: Some("tvly-test".into()),
            brave: Some("BSA-test".into()),
            ..Default::default()
        },
    };
    let back = do_set_web_search_settings(&fx.mgr, settings).unwrap();
    assert_eq!(back.provider, WebSearchProvider::Brave);
    assert_eq!(back.api_keys.tavily.as_deref(), Some("tvly-test"));
    assert_eq!(back.api_keys.brave.as_deref(), Some("BSA-test"));

    // Fresh read sees the same row.
    let got = do_get_web_search_settings(&fx.mgr).unwrap();
    assert_eq!(got.provider, WebSearchProvider::Brave);
    assert_eq!(got.api_keys.brave.as_deref(), Some("BSA-test"));

    // Full replacement: an update without keys clears them.
    do_set_web_search_settings(
        &fx.mgr,
        WebSearchSettings {
            provider: WebSearchProvider::Serper,
            api_keys: WebSearchApiKeys::default(),
        },
    )
    .unwrap();
    let got = do_get_web_search_settings(&fx.mgr).unwrap();
    assert_eq!(got.provider, WebSearchProvider::Serper);
    assert!(got.api_keys.brave.is_none());

    // Corrupt JSON row → defaults, NOT an error.
    fx.mgr
        .with_meta(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('app.webSearch', '{not json')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let d = do_get_web_search_settings(&fx.mgr).unwrap();
    assert_eq!(d.provider, WebSearchProvider::BuiltinBing);
    assert!(d.api_keys.brave.is_none());
}

// ─── API key validation ─────────────────────────────────────────────────────

#[test]
fn require_api_key_errors_on_missing_or_blank_key() {
    let empty_keys = WebSearchApiKeys::default();

    let err = require_api_key(WebSearchProvider::Tavily, &empty_keys).unwrap_err();
    assert!(
        err.to_string()
            .contains("web search provider 'tavily' selected but no API key configured"),
        "unexpected error: {err}"
    );

    // Blank/whitespace key counts as missing.
    let blank = WebSearchApiKeys {
        serper: Some("   ".into()),
        ..Default::default()
    };
    assert!(require_api_key(WebSearchProvider::Serper, &blank).is_err());

    // Present key is returned trimmed.
    let keys = WebSearchApiKeys {
        exa: Some("  exa-key  ".into()),
        ..Default::default()
    };
    assert_eq!(
        require_api_key(WebSearchProvider::Exa, &keys).unwrap(),
        "exa-key"
    );
}

// ─── Exa keyless hosted-MCP path ────────────────────────────────────────────

#[test]
fn parse_exa_mcp_text_parses_title_url_highlights() {
    // Shape captured from the verified `web_search_exa` MCP tool output:
    // `---`-separated entries, `Title:`/`URL:` field lines, multi-line
    // `Highlights:` snippet, `Published:`/`Author:` ignored.
    let blob = "\
Title: The Rust Programming Language
URL: https://doc.rust-lang.org/stable/book/
Published: N/A
Author: N/A
Highlights:
A gentle introduction
to Rust systems programming.
---
Title: Learn Rust
URL: https://rust-lang.org/learn/
Published: 2024-01-01
Author: Rust Team
Highlights:
Guided learning paths for Rust.
---
Title: Entry Without URL
Highlights:
must be skipped (no URL line)
";
    let out = parse_exa_mcp_text(blob, 10);
    assert_eq!(out.len(), 2, "entry without URL must be skipped");
    assert_eq!(out[0].title, "The Rust Programming Language");
    assert_eq!(out[0].url, "https://doc.rust-lang.org/stable/book/");
    assert_eq!(
        out[0].snippet, "A gentle introduction to Rust systems programming.",
        "multi-line highlights must join + collapse into one line"
    );
    assert_eq!(out[1].title, "Learn Rust");
    assert_eq!(out[1].url, "https://rust-lang.org/learn/");
    assert_eq!(out[1].snippet, "Guided learning paths for Rust.");

    // Limit respected.
    let capped = parse_exa_mcp_text(blob, 1);
    assert_eq!(capped.len(), 1);
    assert_eq!(capped[0].url, "https://doc.rust-lang.org/stable/book/");
}

#[test]
fn unwrap_sse_json_extracts_last_data_line() {
    // SSE framing: `event: message` + `data: {JSON}` — payload is the LAST
    // `data: ` line, parseable straight into McpResponse.
    let payload = r#"{"result":{"content":[{"type":"text","text":"Title: T\nURL: https://t.example"}]}}"#;
    let body = format!("event: message\ndata: {payload}\n\n");
    let resp: McpResponse = serde_json::from_str(unwrap_sse_json(&body)).unwrap();
    assert_eq!(
        resp.result.unwrap().content[0].text,
        "Title: T\nURL: https://t.example"
    );

    // Multiple data lines → the LAST one wins.
    let multi = "event: message\ndata: {\"id\":1}\nevent: message\ndata: {\"id\":2}\n";
    assert_eq!(unwrap_sse_json(multi), r#"{"id":2}"#);

    // Plain-JSON body (no `data:` lines) passes through unchanged.
    let plain = r#"{"result":{}}"#;
    assert_eq!(unwrap_sse_json(plain), plain);
}

#[test]
fn mcp_response_tolerates_sparse_and_error_shapes() {
    // `{"result":{}}` — missing content array defaults to empty.
    let resp: McpResponse = serde_json::from_str(r#"{"result":{}}"#).unwrap();
    assert!(resp.result.unwrap().content.is_empty());
    assert!(resp.error.is_none());

    // JSON-RPC error shape parses, and the server message surfaces through
    // the keyless error formatting.
    let resp: McpResponse =
        serde_json::from_str(r#"{"error":{"code":-32601,"message":"nope"}}"#).unwrap();
    assert!(resp.result.is_none());
    let msg = exa_keyless_rpc_err(resp.error.as_ref().unwrap()).to_string();
    assert!(msg.contains("exa keyless search failed"), "unexpected: {msg}");
    assert!(msg.contains("-32601"), "unexpected: {msg}");
    assert!(msg.contains("nope"), "unexpected: {msg}");
}

#[test]
fn exa_keyless_status_err_maps_429_to_quota_hint() {
    // 429 at ANY step is the anonymous IP-quota signal → quota message with
    // the fix hint, not a bare status.
    let err = exa_keyless_status_err("tools/call", reqwest::StatusCode::TOO_MANY_REQUESTS);
    let msg = err.to_string();
    assert!(
        msg.contains("exa keyless quota exceeded (IP-limited ~50/day)"),
        "unexpected: {msg}"
    );
    assert!(
        msg.contains("add an Exa API key in Settings"),
        "unexpected: {msg}"
    );

    // Any other non-2xx keeps the generic detail format.
    let err = exa_keyless_status_err("initialize", reqwest::StatusCode::BAD_GATEWAY);
    assert_eq!(
        err.to_string(),
        "exa keyless search failed: initialize returned HTTP 502 Bad Gateway"
    );
}
