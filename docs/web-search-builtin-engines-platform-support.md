# 内置搜索引擎(Bing / 百度)平台支持说明 — WebView2(Windows) 与 WebKitGTK(Linux)

> **日期**: 2026-09-12(初版,当时仅 Windows)· 2026-09-19 增补 Linux WebKitGTK 桥
> **状态**: 现状说明(解释设计约束,非遗留问题)
> **关联**: [ADR-0049](./adr/0049-web-search-multi-provider-dispatch.md) · [web_search 工具相关性问题调查记录](./web-search-tool-relevance-investigation.md)
> **现象**: 内置引擎(`builtin-bing` / `builtin-baidu`)在设置界面无平台标注;`fetch_url_via_webview` 仍是 Windows 专属

---

## 1. 结论(TL;DR)

无 key 内置引擎(默认的 `builtin-bing` 与 `builtin-baidu`)依赖**隐藏平台 webview 窗口加载真实 SERP** 来绕过搜索引擎的 TLS 指纹反爬。桥接层按平台实现:

- **Windows**:WebView2(`ICoreWebView2::ExecuteScript` COM 桥,拿回 JS 返回值)。
- **Linux**:WebKitGTK(`webkit_web_view_evaluate_javascript` + `jsc_value_to_json`,2026-09-19 落地,即初版文档 §7 预言的"未来解锁路径")。
- **macOS**:WKWebView 桥未实现 — Bing 回退 reqwest 降级爬虫,百度诚实报错。

引擎层面的失败语义不变:

- **Bing**:webview 任何失败(超时/挑战/零结果/macOS 无桥)**回退到旧 reqwest 爬虫**——reqwest 访问 Bing 拿到的是*降级但可解析*的结果页,聊胜于无。所有平台都有可用路径。
- **百度**:reqwest 访问百度**100% 触发安全验证**(百度对非浏览器指纹的拦截比 Bing 激进得多,调查阶段已实测)。没有平台 webview 就没有任何可用路径,于是 macOS 上诚实报错,而不是留一个永远失败的假选项。

一句话:**Windows 与 Linux 各有一条真浏览器路径;macOS 仍是"百度无路可走、Bing 靠兜底"。**

## 2. 背景:内置引擎的工作方式

`search_web` 命令按 `meta.db` 中的设置分发(`WebSearchSettings`,key `app.webSearch`)。两个内置引擎走同一条 `search_web_via_webview` 路径(`src-tauri/src/commands/search.rs`):

```
search_web(query, locale, max_results)          ← 命令签名与返回 DTO 不变
  └─ dispatch_web_search
       └─ search_web_via_webview(app, engine, ...)        [windows + linux]
            1. 构造引擎 URL
               - Bing:  https://www.bing.com/search?q=<q>&adlt=moderate
               - Baidu: https://www.baidu.com/s?wd=<q>&ie=utf-8
            2. 主线程创建隐藏窗口(run_on_main_thread + oneshot 防死锁)
               label = webview-searcher-{uuid7},100×100、不可见、无装饰
               (Windows 防 WebView2 死锁;Linux 上 gtk 部件创建同样必须在
                gtk 主线程 — 同一模式两个平台通用)
            3. 等 PageLoadEvent::Finished(30s 上限,反爬 JS 预算)
               (wry 在 Linux 把 WebKitGTK LoadEvent::Finished 映射到同一载荷)
            4. 渲染轮询(搜索特有):每 500ms 查
               querySelectorAll(引擎选择器).length,直到 ≥1 或 ~8s 超时
               - Bing 选择器:  li.b_algo
               - Baidu 选择器: #content_left div.result
            5. JS 桥提取 outerHTML(平台分叉,见 §3)
            6. 无条件关窗;challenge 检测(looks_like_challenge)
            7. scraper crate 解析(引擎各自 parser,fixture 测试锁定)
```

原理:真 webview 呈现**真浏览器 TLS 栈 + 真 cookie jar + 用户住宅 IP**,满足反爬检查的核心预期。cookie 跨调用持久(共享平台 webview profile)。代理天然跟随系统设置。

## 3. JS 返回值桥:两个平台实现,同一契约

第 5 步的 DOM 提取需要**拿回 JS 表达式的返回值**。**不能用 Tauri 自带的 `eval()`**——它在所有平台都是 fire-and-forget,拿不到返回值(参见 AGENTS.md "Web search & fetch" 一节记录的原因)。`eval_js_string` 因此按平台编译,两个实现对上层暴露完全相同的契约(返回 JSON 编码的 JS 结果,由共享的 `unwrap_js_json_result` 解一层 JSON):

| | Windows | Linux |
|---|---|---|
| 入口 | `with_webview` → `PlatformWebview::controller()` → `ICoreWebView2` | `with_webview` → `PlatformWebview::inner()` → `webkit2gtk::WebView` |
| 执行 API | `ExecuteScript`(COM,完成回调) | `evaluate_javascript`(WebKitGTK ≥ 2.40,GLib 异步回调) |
| 结果序列化 | WebView2 原生返回 JSON 编码值 | `javascriptcore::ValueExt::to_json(0)` — 与 ExecuteScript 同形(字符串返回带 `"..."` 引号层) |
| 线程约束 | `with_webview` 闭包在 webview 线程同步执行 | 闭包在事件循环线程(GLib 主上下文持有者,`evaluate_javascript` 的 gtk-rs 封装断言这一点)执行 |
| 异步桥接 | `std::sync::mpsc` + `spawn_blocking`(防 tokio 阻塞) | 同左 — 两个实现刻意保持同构 |

依赖侧对应:`webview2-com` + `windows`(Windows target)/ `webkit2gtk =2.0.2`(与 wry 0.55 传递依赖严格同版,否则 `inner()` 返回的是另一个 crate 实例的类型)+ `javascriptcore-rs`(Linux target)。

**WebKitGTK 的反爬效果**:它是真 WebKit 引擎(GnuTLS TLS 栈、真 cookie、完整 JS 运行时),与 reqwest 的"裸 HTTP 客户端"有本质区别;虽然 TLS 指纹仍非 Chrome 的 BoringSSL,实测(2026-09-19,smoke 通道,WebKitGTK 2.52 / Linux)Bing 与百度 SERP 均正常返回、可解析,百度未触发安全验证。若未来某引擎收紧到连 WebKitGTK 也拦,失败语义仍是"立即报错,让上层换引擎",不会静默降级。

## 4. 根因二:为什么 Bing 有退路、百度没有

`dispatch_web_search` 中两个引擎 arm 的失败语义(`search.rs` `dispatch_web_search`):

```rust
// BuiltinBing:webview 任何失败(超时/挑战/零结果/macOS 无桥)
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

| 引擎 | Windows | Linux | macOS |
|---|---|---|---|
| `builtin-bing`(默认) | WebView2 SERP(主路径) | WebKitGTK SERP(主路径)✓ | reqwest 降级爬虫(兜底)✓ |
| `builtin-baidu` | WebView2 SERP ✓ | WebKitGTK SERP ✓ | 无桥 + reqwest 死路 → **报错,无可用路径** ❌ |
| 7 个 API 引擎(Tavily/Serper/Exa/Jina/Brave) | 纯 HTTP,平台无关(可用性取决于网络连通性,见 ADR-0049 §4) | 同左 | 同左 |

注:`fetch_url_via_webview`(网页抓取)与 `download_image_bytes_via_webview`(图片反爬兜底,ADR-0052)仍是 Windows-only 命令 — 它们与搜索引擎共享隐藏窗口机制,但 Linux 桥接本次只接通了搜索路径,两者属"机械套用同模式即可解锁"的后续项。

## 6. 为什么 macOS 仍未补桥

1. **需要为 WKWebView 重写执行桥**。macOS 的 `WKWebView`(`evaluateJavaScript`)能返回 JS 结果,但 COM/WebKitGTK 桥的等价物要另写一套,且各平台的反爬效果还得逐引擎重新实测。
2. **项目发布目标只有 Windows**(Linux 为开发平台)。原生通知 AUMID 自注册(ADR-0036)、Job Object 树杀(ADR-0041)均为 Windows 专属。
3. **架构上已预留分层**。窗口/执行机制是平台绑定的,但渲染轮询协议、SERP 解析器(`parse_baidu_results` 等)、设置与分发层全部平台无关——补 macOS 桥时无需动它们(本次 Linux 落地正是该分层的第一次验证:只新增了 `eval_js_string` 的平台实现 + 翻转 cfg 门)。

## 7. Linux 桥的落地记录(2026-09-19)

初版文档 §7 的解锁路径在 Linux 上按原样走完:

1. `eval_js_string` 的 webkitgtk 等价物:见 §3 表格;`evaluate_javascript` 要求调用线程持有 GLib 主上下文,`with_webview` 闭包天然满足(事件循环线程)。
2. `search_web_via_webview` 的平台实现从 `#[cfg(windows)]` 放宽为 `#[cfg(any(windows, linux))]`;共享机制(`create_hidden_nav_window` / `wait_for_page_load` / `eval_rendered_html` / `poll_until_selector`)同步放宽,桩收缩为 macOS-only。
3. 百度引擎的"仅 Windows"标注与 i18n 文案(`settings.json` 的 `webSearch.windowsOnlyHint`)已移除。
4. 渲染轮询与解析器零改动直接复用 — 平台无关分层的预期收益兑现。
5. Windows 侧唯一改动:`eval_js_string` 尾部的 JSON 解包提取为共享的 `unwrap_js_json_result`(逻辑原样搬移,新增单测锁定契约)。

## 8. 代码索引

| 关注点 | 位置(`src-tauri/src/commands/search.rs`) |
|---|---|
| 分发层 Bing 回退 / 百度直传 | `dispatch_web_search` |
| 搜索主流程(平台无关) | `search_web_via_webview`(windows + linux;macOS 为报错桩) |
| 隐藏窗口创建 / 加载等待 / 渲染轮询 | `create_hidden_nav_window` / `wait_for_page_load` / `poll_until_selector`(均 windows + linux) |
| Windows JS 桥(`ExecuteScript`) | `eval_js_string` `#[cfg(target_os = "windows")]` |
| Linux JS 桥(`evaluate_javascript`) | `eval_js_string` `#[cfg(target_os = "linux")]` |
| JS 结果 JSON 解包(共享,含单测) | `unwrap_js_json_result` |
| 百度解析器(`mu` 直链、排除 `result-op`) | `parse_baidu_results` |
| Bing 解析器(`/ck/a` 解包) | `parse_results` + `decode_bing_url` |
| challenge 检测 | `looks_like_challenge` |
| 解析行为 fixture 测试 | `commands/tests/search.rs` + `tests/fixtures/{bing,baidu}_serp.html` |
| 实测冒烟通道 | `src-tauri/examples/webview_search_smoke.rs`(`cargo run --example webview_search_smoke builtin-baidu "查询词"`) |
