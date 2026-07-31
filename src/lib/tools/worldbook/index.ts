/**
 * Worldbook tool barrel — composes domain tools into role-specific ToolSets.
 *
 * Explorer gets full worldbook CRUD + novel/chapter/scene query-only tools.
 * Writer gets full novel/chapter/scene CRUD + worldbook query-only tools.
 * Both get system tools (time).
 *
 * The `queryOnly` helper filters a domain's tools down to read operations
 * (list / get / count) by tool-name prefix, so domain files export ONE set of
 * tools and the role builders select subsets declaratively.
 */

import type { ToolSet } from "@/lib/ai";

import { systemTools } from "../system";
import type { ToolDef, ToolContext } from "../types";
import { buildToolSet } from "../types";
import { characterTools } from "./character";
import { eventTools } from "./event";
import { itemTools, locationTools, loreTools } from "./element";
import { chapterTools, novelTools, sceneTools } from "./novel";

// ─── Query-only filter ────────────────────────────────────────────────────

/**
 * Filter a tool record to read-only operations by tool-name prefix.
 * Recognizes: `list_*`, `get_*`, `count_*`.
 */
function queryOnly(tools: Record<string, ToolDef>): Record<string, ToolDef> {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) =>
        name.startsWith("list_") ||
        name.startsWith("get_") ||
        name.startsWith("count_"),
    ),
  );
}

// ─── Role builders ────────────────────────────────────────────────────────

/**
 * Explorer toolset: full worldbook CRUD + novel/chapter/scene query + system.
 * ~38 tools. The Explorer surveys and builds the world (characters, locations,
 * items, lore, events) and can read (but not modify) the novel structure.
 */
export function buildExplorerTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      // Full worldbook CRUD
      ...characterTools(),
      ...locationTools(),
      ...itemTools(),
      ...loreTools(),
      ...eventTools(),
      // Novel/chapter/scene: query only
      ...queryOnly(novelTools()),
      ...queryOnly(chapterTools()),
      ...queryOnly(sceneTools()),
      // System
      ...systemTools(),
    },
    ctx,
  );
}

/**
 * Writer toolset: full novel/chapter/scene CRUD + worldbook query + system.
 * ~26 tools. The Writer drafts and refines prose (novels, chapters, scenes)
 * and can read (but not modify) the worldbook for reference.
 */
export function buildWriterTools(ctx: ToolContext): ToolSet {
  return buildToolSet(
    {
      // Full novel/chapter/scene CRUD
      ...novelTools(),
      ...chapterTools(),
      ...sceneTools(),
      // Worldbook: query only
      ...queryOnly(characterTools()),
      ...queryOnly(locationTools()),
      ...queryOnly(itemTools()),
      ...queryOnly(eventTools()),
      // System
      ...systemTools(),
    },
    ctx,
  );
}
