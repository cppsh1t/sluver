# web_search 工具相关性问题调查记录

> **日期**: 2026-08-19
> **状态**: 问题已定位，方案待定（本文档仅为调查记录，未来处理时以此为基础）
> **现象**: Agent 的 `web_search` 工具返回结果几乎全是无关内容

---

## 1. 现状实现（sluver 侧完整链路）

调用链：

```
src/lib/tools/websearch.ts          # web_search ToolDef（query + maxResults，consentLevel: "auto"）
  → src/api/search.ts               # searchWeb(query, locale, maxResults) → invoke("search_web")
  → src-tauri/src/commands/search.rs  # 真正的"搜索引擎"：Bing 公开 SERP HTML 爬虫（约 919 行）
  → src-tauri/src/lib.rs:319-324    # 命令注册
```

工具通过 `buildExplorerTools` / `buildWriterTools`（`src/lib/tools/worldbook/index.ts:96-100, 144-148`）无条件注册到两个角色，经 `buildToolSet`（`types.ts`）接入 AgentLoop → `streamText`。

Rust 侧关键事实：

- **没有接入任何搜索 API**（无 Tavily / Brave / Exa / SearXNG / DDG / Bing API key）——设计初衷是"无 key、无计费"的 scraping（见 search.rs 文件头注释）。
- 请求：`GET https://www.bing.com/search?q=<query>&adlt=moderate`，伪装 Chrome 131 UA + `Accept-Language`（来自 i18n locale），15s 超时；**刻意不带 `mkt` 参数**（市场由 IP 地理位置决定）。
- 解析（`parse_results`，search.rs:187-229）：CSS 选择器 `li.b_algo` → `h2 a`（title + href）、`.b_caption p`（snippet）；`decode_bing_url` 解开 Bing `/ck/a?...&u=a1<base64url>` 跟踪跳转。
- **search.rs 没有任何 `#[cfg(test)]` 测试**，解析质量对真实 Bing HTML 完全未验证。

## 2. 根因分析（按可疑度排序）

1. **Bing 对非浏览器客户端返回降级 SERP**。reqwest 的 TLS 指纹不是 Chrome（无 JA3 伪装、无 cookie、无 JS 执行）。Bing 经常对这类客户端返回空结果页、consent 中间页或 `cn.bing.com` 重定向（依 IP 而定）。解析器拿到什么就返回什么。
2. **零查询预处理**。LLM 原样输出的长自然语言查询（模型习惯如此）直接丢给 Bing 逐字匹配，效果天然很差。无关键词化、无改写、无长度约束。
3. **零结果后处理**。无相关性过滤、无打分/重排、无去重、无域名黑名单。`decode_bing_url` 失败时会把原始 `/ck/a` 跟踪链接原样传回给 LLM（后续 `web_fetch` 也打不开）；部分布局下 `.b_caption p` 抓到的其实是日期行/装饰元素而非摘要。
4. **单 provider、无回退、无重试**。

三层叠加（降级 SERP × 糟糕查询 × 无过滤）即为"几乎全是无关内容"的来源。

## 3. 参考项目 oh-my-openagent 的做法

源码位于本地 `D:\self\oh-my-openagent-dev`（Bun monorepo，OpenCode 插件形态）。

### 3.1 核心发现：它根本不实现搜索管道

`web_search` 是**远程 MCP 委托**，全部逻辑约 40 行配置（`packages/omo-opencode/src/mcp/websearch.ts`）：

```ts
// 默认: Exa 托管 MCP —— 无需 API key 即可用
return {
  type: "remote",
  url: "https://mcp.exa.ai/mcp?tools=web_search_exa",
  ...(process.env.EXA_API_KEY ? { headers: { Authorization: `Bearer ${key}` } } : {}),
}
// 可选: Tavily —— https://mcp.tavily.com/mcp/ + Bearer TAVILY_API_KEY（无 key 则静默不注册）
```

- 查询执行、排序、去重、snippet 提取**全部在 Exa / Tavily 服务端完成**，本地零后处理——相关性质量来自 Exa 的神经搜索，不是任何本地代码。
- 工具以 `websearch_web_search_exa(query, numResults)` 形态暴露（MCP 名前缀 + 服务端工具名）。
- 配置：`websearch.provider: "exa" | "tavily"`（zod schema，`config/schema/websearch.ts`），env：`EXA_API_KEY`（可选）/ `TAVILY_API_KEY`（必填）。
- 注入：`createBuiltinMcps()`（`mcp/index.ts`）→ `applyMcpConfig()`（`plugin-handlers/mcp-config-handler.ts`）合并进宿主 `config.mcp`；可用 `disabled_mcps: ["websearch"]` 关闭。

**结论：本地没有"结果处理管道"可抄。值得抄的是模式（委托专业搜索 API）和提示词层的查询纪律。**

### 3.2 查询优化在提示词层，不在代码层

librarian agent 提示词（`packages/omo-opencode/src/agents/librarian.ts`）：

- **时效纪律**：查询强制带当前年份（"NEVER search for {YYYY-1}"），过滤过期年份结果。
- **查询变体**：明确要求"vary queries, different angles"，附正反例。
- **`site:` 定向**：关键词意图先 `site:{domain} {keyword}` 再进具体 URL。
- **编排模式**：搜索只用来找入口（官方文档首页/sitemap），随后 `webfetch` sitemap → 精确抓取页面。搜的是 entry point，不是答案本身。

### 3.3 fetch 侧（与我们同级，无需改动）

- `packages/pi-webfetch`：真实 Chrome UA + 按 format 加权的 Accept 头；Cloudflare 403（`cf-mitigated: challenge`）单次换 UA 重试；5MB 流式硬上限；Turndown HTML→markdown；redirect 预解析 hook（`hooks/webfetch-redirect-guard/`）把最终 URL 回写进工具参数。
- 被墙页面的 3 级升级技能 `ultimate-browsing`（curl_cffi TLS 伪装网格 → 官方平台 API → Chrome stealth）——解决"取不到"，不解决"搜不准"。

我们的 `readabilityrs` + WebView2 浏览器回退（`webviewfetch.ts`）与它是同级设计，桌面场景下 WebView2 甚至更合理。**差距纯粹在搜索 provider。**

## 4. 对比总结

| 维度 | sluver（现状） | oh-my-openagent |
|---|---|---|
| 搜索提供方 | 自研 Bing SERP HTML 爬虫 | Exa 神经搜索（托管 MCP，默认免 key）/ Tavily |
| 客户端指纹 | reqwest（rust TLS 指纹，易被降级） | 宿主 MCP 真实客户端 |
| 查询预处理 | 无 | 提示词层强制（关键词化/年份/变体/`site:`） |
| 结果后处理 | 无 | 服务端完成 |
| 测试覆盖 | search.rs 解析零测试 | 服务端责任，无需本地测试 |

## 5. 未来处理时的备选方案（按建议优先级）

1. **接搜索 API，保留 Bing 爬虫作无 key 回退**（推荐首选）
   Rust 侧 `search_web` 改为优先调用搜索 API，无 key 时回退现有爬虫。TS 层（`websearch.ts` / `api/search.ts` / `SearchResult` DTO）完全不用动。
   - Tavily REST：最简单，免费额度 1000 次/月
   - Brave Search API：免费 2000 次/月
   - key 存放可循 ADR-0012（Space 级 AI 配置）或 ADR-0013（明文存储 + 升级路径）先例
2. **解析器加固 + fixture 测试**（无论是否换 provider 都值得做）
   `parse_results` 过滤垃圾行：丢弃 bing 内部链接、decode 失败的 `/ck/a` 链接、去重；存一份真实 Bing HTML fixture 写 `#[cfg(test)]` 锁死解析行为。
3. **提示词层查询纪律**（零成本，独立收益）
   在 agent 提示词中加入 3.2 节的规则：查询关键词化、限制长度、时效性查询带年份。
4. **Exa keyless MCP**（不推荐首选）
   理论上可在 Rust 实现极简 JSON-RPC 客户端调 `mcp.exa.ai` 免 key 端点，但为桌面应用引入 MCP 协议偏重。若未来 sluver 出于其他原因引入 MCP 基础设施，可重新评估。
   **限额补充**（查证自 exa-labs/exa-mcp-server 源码）：免 key 匿名模式按 IP 限流——**2 QPS + 50 次/天**（只限 `tools/call`），超限返回 429 并提示注册自己的 API key（`dashboard.exa.ai`）。这是 Exa 的 freemium 获客漏斗，不是慈善：匿名额度是广告费，重度用户 BYOK 付费。对 sluver 单用户桌面场景，50 次/天勉强可用但很紧（agent 一次研究任务可能连发 5-10 个查询）；只适合作为"零配置兜底"，正式方案仍应走方案 1。

## 6. 参考文件索引

**sluver**：

- `src/lib/tools/websearch.ts` / `webfetch.ts` / `webviewfetch.ts` — 工具定义
- `src/api/search.ts` — IPC 封装
- `src-tauri/src/commands/search.rs` — Bing 爬虫 + Readability 抓取（问题核心）
- `src/lib/tools/worldbook/index.ts` — 工具注册

**oh-my-openagent**（`D:\self\oh-my-openagent-dev`）：

- `packages/omo-opencode/src/mcp/websearch.ts` — 远程 MCP 委托核心（全文仅约 40 行）
- `packages/omo-opencode/src/config/schema/websearch.ts` — provider 配置 schema
- `packages/omo-opencode/src/agents/librarian.ts` — 提示词层查询纪律
- `packages/pi-webfetch/src/webfetch/{tool,fetcher,content}.ts` — fetch 工具参考实现
- `packages/shared-skills/skills/ultimate-browsing/` — 反爬升级技能（与搜索相关性无关）
