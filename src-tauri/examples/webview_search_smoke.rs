//! Smoke test for the WebView2-based builtin search engines + keyless Exa
//! MCP search (ADR-0049).
//!
//! ```text
//! cargo run --example webview_search_smoke [builtin-bing|builtin-baidu|exa] [query]
//! ```
//!
//! Builds a minimal `tauri::Builder::default()` app (the configured `main`
//! window starts hidden, so nothing appears on screen), dispatches ONE
//! search through the same internal path the `search_web` command uses
//! (via `sluver_lib::smoke::run`), prints the results to stdout, then
//! exits. Defaults: provider `builtin-bing`, query `rust language`.
//!
//! `exa` exercises the KEYLESS hosted-MCP route (`mcp.exa.ai`, anonymous +
//! IP-rate-limited ~50 calls/day) — the smoke bin holds no API keys, so the
//! dispatcher falls back to keyless automatically. The keyed BYOK providers
//! (tavily/serper/jina/brave) are rejected; test those through the app.
//!
//! This binary exists so the orchestrator can verify real-engine behavior
//! (WebView2 boot, SERP hydration, parsing, MCP session handshake) without
//! launching the full app.

fn main() {
    let provider = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "builtin-bing".to_string());
    let query = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "rust language".to_string());

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let provider = provider.clone();
            let query = query.clone();
            tauri::async_runtime::spawn(async move {
                match sluver_lib::smoke::run(&handle, &provider, &query, 5).await {
                    Ok(results) => {
                        println!(
                            "provider '{provider}' returned {} result(s) for the smoke query:",
                            results.len()
                        );
                        for (i, r) in results.iter().enumerate() {
                            // Snippets omitted — keep the console output scan-able.
                            println!("{}. {}\n   {}", i + 1, r.title, r.url);
                        }
                    }
                    Err(e) => println!("smoke search failed: {e}"),
                }
                std::process::exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running smoke example");
}
