/**
 * Per-role behavior bundle for the AI Chat feature.
 *
 * A {@link RoleBehavior} is the role-specific subset of
 * {@link AgentLoopOptions} — everything *except* `model`, which the runtime
 * resolves live from the Space-scoped `AgentConfig` per session (ADR-0023).
 * The runtime merges a `RoleBehavior` with a bound model + tool context to
 * construct an `AgentLoop`.
 *
 * Two roles (`explorer`, `writer`) are hardcoded. Each binds a tool **factory**
 * (`buildTools`) that receives a {@link ToolContext} (spaceId, worldId,
 * approval gate, consent config) and returns a fully-wired SDK `ToolSet`.
 *
 * This module is framework-agnostic logic: no React, no IPC, no logger.
 */

import type { ToolSet } from "@/lib/ai";
import type { ToolContext } from "@/lib/tools/types";
import { buildExplorerTools, buildWriterTools } from "@/lib/tools/worldbook";

// ─── Type ─────────────────────────────────────────────────────────────────

/**
 * The role-specific subset of {@link AgentLoopOptions} (everything except
 * `model` and `tools` — those are resolved per-session). The runtime supplies
 * the model from the Space's AgentConfig and the tools from `buildTools(ctx)`.
 */
export interface RoleBehavior {
  /** The `agentConfigName` this behavior is bound to (e.g. "explorer"). */
  readonly name: string;
  /** System prompt sent on every step; NOT a `SystemModelMessage` in the thread. */
  readonly systemPrompt: string;
  /** Factory: receives ToolContext, returns a wired SDK ToolSet with consent gates. */
  readonly buildTools: (ctx: ToolContext) => ToolSet;
  /** Maximum number of steps before the loop forces `finishReason: 'max-steps'`. */
  readonly maxSteps: number;
  /** Sampling temperature. Omit to let the loop default apply. */
  readonly temperature?: number;
}

// ─── System prompts ───────────────────────────────────────────────────────

const EXPLORER_SYSTEM_PROMPT = [
  "You are the Explorer, a worldbuilding assistant for Sluver.",
  "You help users brainstorm and survey their fictional world — characters, locations, items, lore, and events.",
  "Be curious, generative, and concrete: offer specific suggestions the user can build on, and ask a clarifying question when intent is ambiguous.",
  "You have tools to create, read, update, and delete worldbuilding entities, and to manage character phases.",
  "Some operations require user approval before they execute — if the user denies a tool call, respect their decision and suggest alternatives.",
  "You can also read (but not modify) the novel structure — novels, chapters, and scenes.",
  "When creating entities with relationships (e.g. events with participants, phases with triggers), gather the necessary IDs first by listing or getting the related entities.",
  "Notes tools (list_notes, get_note, grep_notes, create_note, update_note, delete_note) may ONLY be used when the user explicitly asks to read, search, create, modify, or delete notes. Never access the user's notes proactively, never as background context gathering, and never suggest note operations unprompted.",
].join(" ");

const WRITER_SYSTEM_PROMPT = [
  "You are the Writer, a novel-writing assistant for Sluver.",
  "You help users draft and refine prose — scenes, chapters, dialogue, description.",
  "Be evocative and precise; match the tone the user is aiming for and respect their voice rather than rewriting it wholesale.",
  "You have tools to create, read, update, and delete novels, chapters, and scenes.",
  "Some operations require user approval before they execute — if the user denies a tool call, respect their decision and adapt.",
  "You can also read (but not modify) the worldbook — characters, locations, items, and events — for reference when writing scenes.",
  "When a scene needs character/item/event references, look them up first so you pass the correct IDs.",
  "Notes tools (list_notes, get_note, grep_notes, create_note, update_note, delete_note) may ONLY be used when the user explicitly asks to read, search, create, modify, or delete notes. Never access the user's notes proactively, never as background context gathering, and never suggest note operations unprompted.",
].join(" ");

// ─── Behavior map ─────────────────────────────────────────────────────────

/**
 * All known role behaviors, keyed by `agentConfigName`. Add a role here when a
 * new `AgentConfig` name needs distinct behavior.
 */
export const ROLE_BEHAVIOR: Record<string, RoleBehavior> = {
  explorer: {
    name: "explorer",
    systemPrompt: EXPLORER_SYSTEM_PROMPT,
    buildTools: buildExplorerTools,
    maxSteps: 10,
  },
  writer: {
    name: "writer",
    systemPrompt: WRITER_SYSTEM_PROMPT,
    buildTools: buildWriterTools,
    maxSteps: 10,
  },
};

/**
 * Look up a role's behavior bundle by its `agentConfigName`.
 *
 * @returns the {@link RoleBehavior}, or `undefined` if the name is unknown
 *   (the runtime should fall back to a default or surface a config error).
 */
export function getRoleBehavior(agentConfigName: string): RoleBehavior | undefined {
  return ROLE_BEHAVIOR[agentConfigName];
}

/** All supported role names, in declaration order. */
export const SUPPORTED_ROLES: readonly string[] = Object.keys(ROLE_BEHAVIOR);
