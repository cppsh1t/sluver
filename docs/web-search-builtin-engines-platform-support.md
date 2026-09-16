# 内置搜索引擎(Bing / 百度)平台支持说明 — 为什么百度仅限 Windows

> **日期**: 2026-09-12
> **状态**: 现状说明(解释设计约束,非遗留问题)
> **关联**: [ADR-0049](./adr/0049-web-search-multi-provider-dispatch.md) · [web_search 工具相关性问题调查记录](./web-search-tool-relevance-investigation.md)
> **现象**: 设置界面中 `builtin-baidu` 引擎标注"仅 Windows",`builtin-bing` 无此标注

---

## 1. 结论(TL;DR)

无 key 内置引擎(默认的 `builtin-bing` 与 `builtin-baidu`)依赖**隐藏 WebView2 窗口加载真实 SERP** 来绕过搜索引擎的 TLS 指纹反爬。WebView2 是 Windows 专属组件,因此:

- **Bing**:WebView2 不可用时**回退到旧 reqwest 爬虫**——reqwest 访问 Bing 拿到的是*降级但可解析*的结果页,聊胜于无。所有平台都有可用路径。
- **百度**:reqwest 访问百度**100% 触发安全验证**(百度对非浏览器指纹的拦截比 Bing 激进得多,调查阶段已实测)。没有 WebView2 就没有任何可用路径,于是诚实报错 `"baidu search engine requires WebView2 (Windows only)"`,而不是留一个永远失败的假选项。

一句话:**不是"百度被人为限制在 Windows",而是"非 Windows 上百度的所有技术路径都是死路"。**

## 2. 背景:内置引擎的工作方式

`search_web` 命令按 `meta.db` 中的设置分发(`WebSearchSettings`,key `app.webSearch`)。两个内置引擎走同一条 `search_web_via_webview` 路径(`src-tauri/src/commands/search.rs`):

```
search_web(query, locale, max_results)          ← 命令签名与返回 DTO 不变
  └─ dispatch_web_search
       └─ search_web_via_webview(app, engine, ...)
            1. 构造引擎 URL
               - Bing:  https://www.bing.com/search?q=<q>&adlt=moderate
               - Baidu: https://www.baidu.com/s?wd=<q>&ie=utf-8
            2. 主线程创建隐藏窗口(run_on_main_thread + oneshot 防死锁)
               label = webview-searcher-{uuid7},100×100、不可见、无装饰
            3. 等 PageLoadEvent::Finished(30s 上限,反爬 JS 预算)
            4. 渲染轮询(搜索特有):每 500ms 查
               querySelectorAll(引擎选择器).length,直到 ≥1 或 ~8s 超时
               - Bing 选择器:  li.b_algo
               - Baidu 选择器: #content_left div.result
            5. ICoreWebView2::ExecuteScript 提取 outerHTML
            6. 无条件关窗;challenge 检测(looks_like_challenge)
            7. scraper crate 解析(引擎各自 parser,fixture 测试锁定)
```

原理:WebView2 呈现**真 Chrome TLS 指纹 + 真 Edge UA + 真 cookie jar + 用户住宅 IP**,满足反爬检查的全部预期。cookie 跨调用持久(共享 WebView2 profile)。代理天然跟随系统设置。

## 3. 根因一:WebView2 与 COM 桥是 Windows 专属

第 5 步的 DOM 提取依赖 `ICoreWebView2::ExecuteScript`(`webview2-com` + `windows` crate 的 COM 互操作)。**不能用 Tauri 自带的 `eval()`**——它是 fire-and-forget,拿不到 JS 返回值(参见 AGENTS.md "Web search & fetch" 一节记录的原因)。

`search_web_via_webview` 因此按平台编译:

```rust
// search.rs L1991(#[cfg(not(target_os = "windows"))] 桩)
match engine {
    SearchEngine::Bing  => Err(DbError::Internal(
        "bing webview search is only supported on Windows".into())),
    SearchEngine::Baidu => Err(DbError::Internal(
        "baidu search engine requires WebView2 (Windows only)".into())),
}
```

非 Windows 上,Bing 的这个错误会被分发层**捕获并回退**;百度的会**直接透传给用户**——差异在下一节。

## 4. 根因二:为什么 Bing 有退路、百度没有

`dispatch_web_search` 中两个引擎 arm 的失败语义(`search.rs` `dispatch_web_search`):

```rust
// BuiltinBing:webview 任何失败(超时/挑战/零结果/非 Windows)
//             → 回退旧 reqwest 爬虫 bing_search_reqwest
Err(e) => { tracing::warn!(...); bing_search_reqwest(query, ...).await? }

// BuiltinBaidu:错误直接传播,无 fallback
// No reqwest fallback — Baidu TLS-blocks non-browser clients.
// 安全验证 and other failures surface immediately (no retry loop).
search_web_via_webview(app, SearchEngine::Baidu, ...).await?
```

| | reqwest 访问 Bing | reqwest 访问百度 |
|---|---|---|
| 结果 | 降级 SERP(结果少但可解析) | **安全验证挑战页,100%**(实测,见调查报告) |
| 作为兜底的价值 | 聊胜于无 | 零——永远拿不到结果 |

百度 arm 同时刻意**不做重试**:安全验证是指纹级拦截,重试只是反复撞墙,还会加剧风控。错误立即上抛,让上层(用户/Agent)换引擎。

## 5. 平台支持矩阵

| 引擎 | Windows | macOS / Linux |
|---|---|---|
| `builtin-bing`(默认) | WebView2 SERP(主路径) | reqwest 降级爬虫(兜底)✓ |
| `builtin-baidu` | WebView2 SERP ✓ | webview 不可用 + reqwest 死路 → **报错,无可用路径** ❌ |
| 7 个 API 引擎(Tavily/Serper/Exa/Jina/Brave) | 纯 HTTP,平台无关(可用性取决于网络连通性,见 ADR-0049 §4) | 同左 |

## 6. 为什么暂不为 macOS / Linux 补桥

1. **需要逐平台重写执行桥**。macOS 的 WKWebView(`evaluateJavaScript`)与 Linux 的 webkitgtk(`run_javascript`)都能返回 JS 结果,但 COM 桥的等价物要各写一套(含隐藏窗口创建、页面加载事件、渲染轮询的平台适配),而各平台的反爬效果还得逐引擎重新实测。
2. **项目当前 Windows-first**。原生通知 AUMID 自注册(ADR-0036)、Job Object 树杀(ADR-0041)、WebView2 fetch 路径均为 Windows 专属;发布目标只有 Windows。
3. **架构上已预留分层**。窗口/执行机制是平台绑定的,但渲染轮询协议、SERP 解析器(`parse_baidu_results` 等)、设置与分发层全部平台无关——未来补平台桥时无需动它们。

## 7. 未来解锁路径(如果 sluver 上 macOS/Linux)

按依赖顺序:

1. 为 WKWebView / webkitgtk 实现 `eval_js_string` 等价物(Tauri `WebviewWindowBuilder` 在两平台均可创建隐藏窗口,缺口只在"取回 JS 返回值");
2. 将 `search_web_via_webview` 的 `#[cfg(not(windows))]` 桩替换为平台实现(渲染轮询与解析器直接复用);
3. 百度引擎的"仅 Windows"标注与 i18n 文案(`settings.json` 中 `webSearch.*` 相关键)随之移除。

## 8. 代码索引

| 关注点 | 位置(`src-tauri/src/commands/search.rs`,行号为本文写作时点) |
|---|---|
| 分发层 Bing 回退 / 百度直传 | `dispatch_web_search`,~L334-357 |
| 非 Windows 桩(报错文案出处) | `search_web_via_webview`,~L1991 |
| 隐藏窗口 + 渲染轮询 + COM 提取 | `search_web_via_webview` Windows 实现,~L1919 |
| 百度解析器(`mu` 直链、排除 `result-op`) | `parse_baidu_results` |
| Bing 解析器(`/ck/a` 解包) | `parse_results` + `decode_bing_url` |
| challenge 检测 | `looks_like_challenge` |
| 解析行为 fixture 测试 | `commands/tests/search.rs` + `tests/fixtures/{bing,baidu}_serp.html` |
| 实测冒烟通道 | `src-tauri/examples/webview_search_smoke.rs`(`cargo run --example webview_search_smoke builtin-baidu "查询词"`) |
