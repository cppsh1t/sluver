/**
 * Worldbook tool barrel — composes domain tools into per-role ToolSets
 * (ADR-0050 D8).
 *
 * The old two-role surface (explorer/writer, each carrying the entire
 * worldbook + novel + notes + web bundle "just in case") is replaced by
 * nine lean role builders, each tuned to its job:
 *
 * | Role         | Surface                                                                       |
 * | ------------ | ----------------------------------------------------------------------------- |
 * | orchestrator | system tools + look_at + conditional skills/shell ONLY (D1 purity — no       |
 * |              | entity/web/notes tools; even trivial lookups are dispatched)                  |
 * | explorer     | universal + retrieval (grep, timeline_lookup) + web×3 + worldbook reads +    |
 * |              | queryOnly novel-side. NO notes (scribe owns notes now)                        |
 * | curator      | universal + FULL worldbook CRUD (characters/phases/locations/items/lores/     |
 * |              | events incl. images + reorder). No novel side, no retrieval, no web            |
 * | scribe       | universal + the six note tools                                                |
 * | historian    | universal + worldbook reads + retrieval + queryOnly novel-side reads.         |
 * |              | ZERO write tools (pure reader)                                                |
 * | editor       | universal + world/novel/chapter/scene FULL CRUD (images, reorder, gallery)   |
 * | plotter      | universal + chapter/scene CRUD + worldbook read trio                          |
 * | writer       | universal + scene reads + update_scene (consent override → "configurable",   |
 * |              | ADR-0050 D5). NO scene create/delete/reorder                                   |
 * | critic       | universal + chapter/scene reads + count_scene_words                           |
 *
 * "Universal" (every loop role): get_current_time, format_time, plan,
 * look_at (always registered — ADR-0050 D6 supersedes ADR-0045's
 * registration gate; an unbound vision config surfaces as a structured
 * `unconfigured` result at execute time), plus the conditional skills /
 * shell spreads. `context_read` is ORCHESTRATOR-ONLY (D8 — runs never
 * produce ADR-0031 stubs).
 *
 * The `queryOnly` helper filters a domain's tools down to read operations
 * by tool-name prefix (list / get / count / search), so domain files export
 * ONE set of tools and the role builders select subsets declaratively.
 * This keeps the mutation split declarative for the ADR-0048 image tools
 * too: `set_*_image_from_*` / `clear_*_image` / `add_scene_image_*` /
 * `delete_scene_image` all carry mutation prefixes and thus only ride
 * their primary domain's role, while `list_scene_images` rides every
 * queryOnly consumer.
 *
 * Shell execution (`run_shell_command`, ADR-0041/0042) is registered on
 * every loop role, each gated by that role's AgentConfig `shellToolEnabled`
 * flag. The namer/vision one-shots never carry it.
 *
 * Agent Skills (`activate_skill` / `read_skill_file`, ADR-0043) are
 * registered on every loop role, gated by `ctx.skills` being non-empty —
 * no enabled skills means no skill tools AND no `<available_skills>`
 * catalog (Anthropic client-implementation guidance).
 */

import type { ToolSet } from "@/lib/ai";

import { grepTools } from "../grep";
import { lookAtTools } from "../look-at";
import { noteTools } from "../note";
import { shellTools } from "../shell";
import { skillTools } from "../skill";
import { subagentTools } from "../subagent";
import { systemTools } from "../system";
import type { ConsentLevel, ToolDef, ToolContext } from "../types";
import { applyConsentOverrides, buildToolSet } from "../types";
import { webFetchTools } from "../webfetch";
import { webSearchTools } from "../websearch";
import { webViewFetchTools } from "../webviewfetch";
import { characterTools } from "./character";
import { eventTools } from "./event";
import { itemTools, locationTools, loreTools } from "./element";
import { chapterTools, novelTools, sceneTools } from "./novel";
import { worldTools } from "./world";
import { timelineTools } from "../timeline";

// ─── Selection helpers ─────────────────────────────────────────────────────

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

/** Drop the named tools from a record, returning a NEW record. */
function omitTools(
  tools: Record<string, ToolDef>,
  ...names: string[]
): Record<string, ToolDef> {
  const next = { ...tools };
  for (const name of names) {
    delete next[name];
  }
  return next;
}

/** Keep ONLY the named tools from a record (missing names are skipped). */
function pickTools(
  tools: Record<string, ToolDef>,
  ...names: string[]
): Record<string, ToolDef> {
  return Object.fromEntries(
    names.flatMap((name) => (tools[name] ? [[name, tools[name]] as const] : [])),
  );
}

// ─── Shared role surfaces ──────────────────────────────────────────────────

/**
 * Worldbook read trio: the `queryOnly` projection of all five worldbook
 * domains (characters incl. phases, locations, items, lores, events —
 * list/search/get/count_*). Shared by explorer, historian, and plotter.
 */
function worldbookReadTools(): Record<string, ToolDef> {
  return {
    ...queryOnly(characterTools()),
    ...queryOnly(locationTools()),
    ...queryOnly(itemTools()),
    ...queryOnly(loreTools()),
    ...queryOnly(eventTools()),
  };
}

/**
 * The subagent "universal" set (ADR-0050 D8): system tools MINUS
 * `context_read` (orchestrator-only — runs never produce ADR-0031 stubs),
 * the always-registered `look_at` (D6), plus the conditional shell /
 * skills spreads gated by the role's own AgentConfig flags.
 */
function universalSubagentTools(ctx: ToolContext): Record<string, ToolDef> {
  return {
    ...omitTools(systemTools(), "context_read"),
    ...lookAtTools(),
    ...(ctx.shellToolEnabled ? shellTools() : {}),
    ...(ctx.skills.length > 0 ? skillTools(ctx) : {}),
  };
}

// ─── Consent overrides (ADR-0050 D5) ───────────────────────────────────────

/**
 * The writer's `update_scene` is `configurable` (governed by the writer's
 * own `autoExecuteDangerousTools` flag) instead of `always`: without this,
 * every scene write would halt the unattended batch pipeline for manual
 * approval. Delete/reorder tools stay `always` for EVERY role. Declared
 * here (the composition layer) and re-exported through the role registry
 * so both stay in lockstep.
 */
export const WRITER_CONSENT_OVERRIDES = {
  update_scene: "configurable",
} as const satisfies Record<string, ConsentLevel>;

// ─── Role builders ─────────────────────────────────────────────────────────

/**
 * Orchestrator toolset (ADR-0050 D1 purity): system tools (time, format,
 * plan, context_read) + the always-registered look_at + conditional
 * skills/shell — NOTHING else. No entity, novel, notes, or web tools:
 * a coordinator that *can* query will query; forced delegation keeps the
 * Orchestrator's context permanently lean. Even trivial lookups ("how
 * many characters?") are dispatched to explorer.
 */
export function buildOrchestratorTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      // Full system surface: get_current_time, format_time, plan,
      // context_read (orchestrator-only per D8).
      ...systemTools(),
      // look_at is ALWAYS registered (D6) — an unbound vision config
      // surfaces as a structured `unconfigured` result at execute time.
      ...lookAtTools(),
      // Shell execution (ADR-0041/0042) — registered only when the
      // AgentConfig's `shellToolEnabled` is on, then consentLevel "auto".
      ...(ctx.shellToolEnabled ? shellTools() : {}),
      // Agent Skills (ADR-0043) — registered only when the role has ≥1
      // enabled skill (empty catalog = nothing).
      ...(ctx.skills.length > 0 ? skillTools(ctx) : {}),
      //
      // ── Dispatch surface (ADR-0050 D3 — Unit C) ────────────────────────
      // The single delegation tool: static 8-role enum, free-form task,
      // consentLevel "auto", execute blocking on
      // ctx.subagentRunner.run(...). Registered on the ORCHESTRATOR ONLY —
      // subagents never dispatch (D1's exactly-one delegation level; their
      // ToolContext carries a throwing stub instead of a live runner).
      ...subagentTools(),
    },
    ctx,
  );
}

/**
 * Explorer toolset: universal + retrieval + web + worldbook reads +
 * queryOnly novel-side reads. A pure reader — zero mutation tools, and NO
 * note tools (the scribe owns notes per ADR-0050).
 */
export function buildExplorerTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      // Match-centric cross-entity retrieval (ADR-0035) + read-only
      // chronology (ADR-0033).
      ...grepTools(),
      ...timelineTools(),
      // Web research surface.
      ...webSearchTools(),
      ...webFetchTools(),
      ...webViewFetchTools(),
      // Worldbook: read trio only (mutations belong to curator).
      ...worldbookReadTools(),
      // Novel/chapter/scene: query only (list/get/count/search incl.
      // get_chapter_overview + list_scene_images).
      ...queryOnly(novelTools()),
      ...queryOnly(chapterTools()),
      ...queryOnly(sceneTools()),
    },
    ctx,
  );
}

/**
 * Curator toolset: universal + FULL worldbook CRUD — characters (incl.
 * phases: add/update/delete/reorder) and the three element kinds + events,
 * with every image set/clear tool. No novel-side tools, no retrieval, no
 * web, no notes.
 */
export function buildCuratorTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      ...characterTools(),
      ...locationTools(),
      ...itemTools(),
      ...loreTools(),
      ...eventTools(),
    },
    ctx,
  );
}

/**
 * Scribe toolset: universal + the six note tools (ADR-0037 — now owned by
 * the scribe alone; the prompt-gating discipline lives in its system
 * prompt). Nothing else beyond the universal surface.
 */
export function buildScribeTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      ...noteTools(),
    },
    ctx,
  );
}

/**
 * Historian toolset: universal + worldbook reads + retrieval + novel-side
 * queryOnly reads. A PURE READER — zero write tools by design (ADR-0050
 * D8): a synthesis role must not hold delete keys; corrections route back
 * through the Orchestrator to the curator.
 */
export function buildHistorianTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      ...grepTools(),
      ...timelineTools(),
      ...worldbookReadTools(),
      ...queryOnly(novelTools()),
      ...queryOnly(chapterTools()),
      ...queryOnly(sceneTools()),
    },
    ctx,
  );
}

/**
 * Editor toolset: universal + FULL CRUD over the world cover, novels,
 * chapters, and scenes — including the image tools (novel cover, scene
 * gallery), reorder, and deletes. The structural counterpart to the
 * writer's prose surface.
 */
export function buildEditorTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      // World cover image (configurable/always). No world CRUD — world
      // create/delete is a Space-management UI concern.
      ...worldTools(),
      ...novelTools(),
      ...chapterTools(),
      ...sceneTools(),
    },
    ctx,
  );
}

/**
 * Plotter toolset: universal + chapter/scene CRUD + the worldbook read
 * trio for reference. No novel CRUD (the novel itself is structural
 * scaffolding the editor owns), no prose writes into scene content
 * beyond what structural edits entail.
 */
export function buildPlotterTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      ...chapterTools(),
      ...sceneTools(),
      ...worldbookReadTools(),
    },
    ctx,
  );
}

/**
 * Writer toolset: universal + scene READS (queryOnly incl.
 * count_scene_words + list_scene_images) + `update_scene` with the
 * ADR-0050 D5 consent override (`configurable`, governed by the writer's
 * own `autoExecuteDangerousTools`). NO scene create/delete/reorder —
 * structural changes belong to the plotter/editor.
 */
export function buildWriterTools(ctx: ToolContext): ToolSet {
  const scene = applyConsentOverrides(sceneTools(), WRITER_CONSENT_OVERRIDES);
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      ...queryOnly(scene),
      ...pickTools(scene, "update_scene"),
    },
    ctx,
  );
}

/**
 * Critic toolset: universal + chapter reads (incl. get_chapter_overview)
 * + scene reads (incl. count_scene_words). A pure reader — the critique
 * IS the deliverable, delivered in the final message.
 */
export function buildCriticTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      ...universalSubagentTools(ctx),
      ...queryOnly(chapterTools()),
      ...queryOnly(sceneTools()),
    },
    ctx,
  );
}
