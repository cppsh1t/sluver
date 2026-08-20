/**
 * Worldbook tool barrel — composes domain tools into role-specific ToolSets.
 *
 * Explorer gets full worldbook CRUD + novel/chapter/scene query-only tools.
 * Writer gets full novel/chapter/scene CRUD + worldbook query-only tools.
 * Both get system tools (time), all 8 search_* tools, grep (match-centric
 * full-corpus retrieval — ADR-0035), and the six prompt-gated note tools
 * (ADR-0037 — shared section, never behind `queryOnly`).
 *
 * The `queryOnly` helper filters a domain's tools down to read operations
 * (list / get / count / search) by tool-name prefix, so domain files export
 * ONE set of tools and the role builders select subsets declaratively.
 *
 * Shell execution (`run_shell_command`, ADR-0041/0042) is registered on
 * both explorer and writer, each gated by that role's AgentConfig
 * `shellToolEnabled` flag. The namer role never carries it.
 *
 * The `look_at` vision tool (ADR-0045) is registered on both roles, gated
 * by the Space's dedicated seeded `vision` AgentConfig being bound
 * (`ctx.visionConfig != null` — same conditional-spread idea as the shell
 * gate). The namer role never carries it either.
 *
 * Agent Skills (`activate_skill` / `read_skill_file`, ADR-0043) are
 * registered on both roles, gated by `ctx.skills` being non-empty — no
 * enabled skills means no skill tools AND no `<available_skills>` catalog
 * (Anthropic client-implementation guidance; same conditional-spread idea
 * as the shell gate). The namer role never carries them either.
 */

import type { ToolSet } from "@/lib/ai";

import { grepTools } from "../grep";
import { lookAtTools } from "../look-at";
import { noteTools } from "../note";
import { shellTools } from "../shell";
import { skillTools } from "../skill";
import { systemTools } from "../system";
import type { ToolDef, ToolContext } from "../types";
import { buildToolSet } from "../types";
import { webFetchTools } from "../webfetch";
import { webSearchTools } from "../websearch";
import { webViewFetchTools } from "../webviewfetch";
import { characterTools } from "./character";
import { eventTools } from "./event";
import { itemTools, locationTools, loreTools } from "./element";
import { chapterTools, novelTools, sceneTools } from "./novel";
import { worldTools } from "./world";
import { timelineTools } from "../timeline";

// ─── Query-only filter ────────────────────────────────────────────────────

/**
 * Filter a tool record to read-only operations by tool-name prefix.
 * Recognizes: `list_*`, `get_*`, `count_*`, `search_*`.
 */
function queryOnly(tools: Record<string, ToolDef>): Record<string, ToolDef> {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) =>
        name.startsWith("list_") ||
        name.startsWith("get_") ||
        name.startsWith("count_") ||
        name.startsWith("search_"),
    ),
  );
}

// ─── Role builders ────────────────────────────────────────────────────────

/**
 * Explorer toolset: full worldbook CRUD + novel/chapter/scene query + system.
 * 61 tools (51 + 8 search + shell + look_at). The Explorer surveys and builds
 * the world (characters, locations, items, lore, events) and can read (but
 * not modify) the novel structure. It also carries the shell execution tool
 * (ADR-0041/0042) — registered only when `shellToolEnabled` is on (then
 * auto-executing) — and the `look_at` vision tool (ADR-0045), registered
 * only when the Space's `vision` agent config is bound.
 */
export function buildExplorerTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      // World cover image (configurable). No CRUD — world create/delete is
      // a Space-management UI concern, not an agent operation.
      ...worldTools(),
      // Full worldbook CRUD (includes search_*)
      ...characterTools(),
      ...locationTools(),
      ...itemTools(),
      ...loreTools(),
      ...eventTools(),
      // Timeline (read-only chronology — ADR-0033)
      ...timelineTools(),
      // Grep (cross-entity match-centric retrieval — ADR-0035)
      ...grepTools(),
      // Notes (prompt-gated per ADR-0037 — shared by both roles)
      ...noteTools(),
      // Novel/chapter/scene: query only (includes search_*)
      ...queryOnly(novelTools()),
      ...queryOnly(chapterTools()),
      ...queryOnly(sceneTools()),
      // System
      ...systemTools(),
      ...webSearchTools(),
      // Web fetch (read a specific URL's content via Readability)
      ...webFetchTools(),
      // WebView fetch (browser-engine fallback for 403/anti-bot sites)
      ...webViewFetchTools(),
      // Shell execution (ADR-0041/0042) — registered only when the
      // AgentConfig's `shellToolEnabled` is on, then consentLevel "auto"
      // (executes without per-call confirmation).
      ...(ctx.shellToolEnabled ? shellTools() : {}),
      // Agent Skills (ADR-0043) — progressive disclosure tools, registered
      // only when the role has ≥1 enabled skill (empty catalog = nothing).
      ...(ctx.skills.length > 0 ? skillTools(ctx) : {}),
      // Look-at vision (ADR-0045) — registered only when the Space's
      // dedicated `vision` agent config is bound; then consentLevel "auto".
      ...(ctx.visionConfig ? lookAtTools() : {}),
    },
    ctx,
  );
}

/**
 * Writer toolset: full novel/chapter/scene CRUD + worldbook query + system.
 * 53 tools (43 + 8 search + shell + look_at). The Writer drafts and refines
 * prose (novels, chapters, scenes) and can read (but not modify) the
 * worldbook for reference. It also carries the shell execution tool
 * (ADR-0041/0042) — registered only when `shellToolEnabled` is on (then
 * auto-executing) — and the `look_at` vision tool (ADR-0045), registered
 * only when the Space's `vision` agent config is bound.
 */
export function buildWriterTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      // World cover image (configurable). Writer may attach cover art for
      // the world it's writing in.
      ...worldTools(),
      // Full novel/chapter/scene CRUD (includes search_*)
      ...novelTools(),
      ...chapterTools(),
      ...sceneTools(),
      // Worldbook: query only (includes search_*)
      ...queryOnly(characterTools()),
      ...queryOnly(locationTools()),
      ...queryOnly(itemTools()),
      ...queryOnly(loreTools()),
      ...queryOnly(eventTools()),
      // Timeline (read-only chronology — ADR-0033)
      ...timelineTools(),
      // Grep (cross-entity match-centric retrieval — ADR-0035)
      ...grepTools(),
      // Notes (prompt-gated per ADR-0037 — shared by both roles)
      ...noteTools(),
      // System
      ...systemTools(),
      ...webSearchTools(),
      // Web fetch (read a specific URL's content via Readability)
      ...webFetchTools(),
      // WebView fetch (browser-engine fallback for 403/anti-bot sites)
      ...webViewFetchTools(),
      // Shell execution (ADR-0041/0042) — registered only when the
      // AgentConfig's `shellToolEnabled` is on, then consentLevel "auto"
      // (executes without per-call confirmation).
      ...(ctx.shellToolEnabled ? shellTools() : {}),
      // Agent Skills (ADR-0043) — progressive disclosure tools, registered
      // only when the role has ≥1 enabled skill (empty catalog = nothing).
      ...(ctx.skills.length > 0 ? skillTools(ctx) : {}),
      // Look-at vision (ADR-0045) — registered only when the Space's
      // dedicated `vision` agent config is bound; then consentLevel "auto".
      ...(ctx.visionConfig ? lookAtTools() : {}),
    },
    ctx,
  );
}
