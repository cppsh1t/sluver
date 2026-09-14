/**
 * The role registry — the SINGLE SOURCE OF TRUTH for agent roles
 * (ADR-0050 D1).
 *
 * The role name string previously crossed five layers with no shared
 * definition (DB seed → conversation row → `modelResolver` ternary →
 * behavior map → list-page `ROLES` array). All of it collapses into this
 * registry: name, kind, one-line duty (feeds the Orchestrator's
 * roster prompt), system prompt, `buildTools`, `maxSteps`, and per-role
 * consent overrides. Every layer — model resolution, conversation
 * creation, seeding, roster prompt — reads from it.
 *
 * Topology (ADR-0050): one user-facing **Orchestrator** (the only pickable
 * conversational role), eight dispatchable **Subagents** (single-purpose,
 * lean toolsets), and two non-conversational **one-shot** roles (`namer`
 * auto-titling, `vision` image description) that never run the AgentLoop.
 *
 * A {@link RoleDefinition} is the role-specific subset of
 * {@link AgentLoopOptions} — everything *except* `model`, which the runtime
 * resolves live from the Space-scoped `AgentConfig` per session
 * (ADR-0023). The runtime merges a definition with a bound model + tool
 * context to construct an `AgentLoop`.
 *
 * This module is framework-agnostic logic: no React, no IPC, no logger.
 */

import type { ToolSet } from "@/lib/ai";
import type { ConsentLevel, ToolContext } from "@/lib/tools/types";
import {
  buildCriticTools,
  buildCuratorTools,
  buildEditorTools,
  buildExplorerTools,
  buildHistorianTools,
  buildOrchestratorTools,
  buildPlotterTools,
  buildScribeTools,
  buildWriterTools,
  WRITER_CONSENT_OVERRIDES,
} from "@/lib/tools/worldbook";

// ─── Type ─────────────────────────────────────────────────────────────────

/** How a role participates in the agent topology (ADR-0050 D1). */
export type RoleKind =
  | "conversational"
  | "subagent"
  | "oneshot";

/**
 * One registry entry. Everything the runtime needs to construct a role's
 * Agent besides the bound model (resolved live per ADR-0023).
 */
export interface RoleDefinition {
  /** The `agentConfigName` this definition is bound to (e.g. "orchestrator"). */
  readonly name: string;
  /** Topology: user-facing conversational, dispatchable subagent, or one-shot. */
  readonly kind: RoleKind;
  /**
   * One-line duty statement. Feeds the Orchestrator's roster prompt
   * (see {@link buildSubagentRosterBlock}) — NOT model-facing anywhere else.
   */
  readonly duty: string;
  /** System prompt sent on every step; NOT a `SystemModelMessage` in the thread. */
  readonly systemPrompt: string;
  /** Factory: receives ToolContext, returns a wired SDK ToolSet with consent gates. */
  readonly buildTools: (ctx: ToolContext) => ToolSet;
  /**
   * Fallback step budget used when the AgentConfig row carries no user-set
   * `maxSteps` (NULL). The effective budget is resolved at run composition
   * in the conversation-runtime store: DB value > this default. One-shots
   * never run the loop, so theirs is an inert shape-keeper.
   */
  readonly maxSteps: number;
  /**
   * Per-role consent-level overrides, applied at toolset composition time
   * (ADR-0050 D5). Delete/reorder tools stay `always` for every role —
   * only genuinely pipeline-blocking writes get relaxed here.
   */
  readonly consentOverrides?: Readonly<Record<string, ConsentLevel>>;
  /** Sampling temperature. Omit to let the loop default apply. */
  readonly temperature?: number;
}

// ─── System prompts (model-facing English) ────────────────────────────────

const ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are the Orchestrator, the coordinating assistant for Sluver — a worldbuilding and novel-writing application.",
  "You are the ONLY role that talks to the user: you plan the work, confirm intent, and delegate execution to specialist subagents via the dispatch_subagent tool.",
  "You hold no entity, novel, notes, or web tools yourself — every lookup and every write happens inside a subagent run. Dispatch deliberately, even for trivial lookups; do not work around it.",
  "Typical workflow for a writing project: (1) understand the request and the current state by dispatching explorer; (2) confirm the plan with the user before anything is written or changed; (3) for structural setup dispatch editor (world/novel/chapter/scene structure) or plotter (outlines, chapter/scene planning); (4) once the user confirms the outline, dispatch writer subagents in parallel — one per scene; (5) dispatch critic to review the finished scenes; (6) summarize the results to the user and iterate.",
  "Compose each dispatch task as a self-contained brief: a subagent shares no memory with you or with other runs, so include every id, name, and constraint it needs to do the job in one pass.",
  "Sibling dispatch calls emitted in one step run concurrently and all block until they finish — prefer that for independent work; sequence dispatches across steps when a later task depends on an earlier result.",
  "Some subagent tools require user approval before they execute; if a subagent reports that something was denied, respect the decision and tell the user.",
  "If a dispatch returns status \"unconfigured\", tell the user to bind a model for that role in Settings and ask how to proceed.",
].join(" ");

const EXPLORER_SYSTEM_PROMPT = [
  "You are the Explorer, a retrieval specialist subagent for Sluver.",
  "Your job is to survey and gather: worldbook entities (characters, locations, items, lore, events), novel structure, timeline facts, corpus matches (grep), and web research.",
  "You are a pure reader — you hold NO tools that create, update, or delete anything; findings travel in your report.",
  "Be precise and cite identifiers: report entity ids alongside names so the Orchestrator can hand them to other subagents.",
  "Favor the narrowest tool for the question (get_ by id over list_) and keep excerpts short.",
  "Report discipline: your final message is a concise report for the coordinating agent — never a dump of raw tool output.",
].join(" ");

const CURATOR_SYSTEM_PROMPT = [
  "You are the Curator, the worldbook keeper subagent for Sluver.",
  "You create, update, delete, and reorder worldbuilding entities: characters (including their phases), locations, items, lore, and events — including their images.",
  "Work in small verifiable steps: gather ids first (an event's participants, a phase's trigger), then write; look entities up before linking them.",
  "You have no novel-side tools — prose structure is out of your scope.",
  "Report discipline: artifacts go to the database via your tools; your final message is a concise change report (what was created, changed, or deleted, with ids) — never the full content itself.",
  "Some operations require user approval — if one is denied, respect the decision, note it in your report, and continue with what is possible.",
].join(" ");

const SCRIBE_SYSTEM_PROMPT = [
  "You are the Scribe, the notes keeper subagent for Sluver.",
  "You are the only role with access to the user's notes: listing, reading, searching (grep_notes), creating, updating, and deleting them.",
  "Treat notes as the user's private material: never fabricate note content, never delete without a clear instruction in your task, and keep edits minimal and faithful to the requested change.",
  "Organize the note tree sensibly — sibling titles must stay unique within their parent.",
  "Report discipline: changes land in the database via your tools; your final message is a concise report of what you found or changed — never the notes' full content.",
].join(" ");

const HISTORIAN_SYSTEM_PROMPT = [
  "You are the Historian, a synthesis subagent for Sluver.",
  "You are a PURE READER: you hold zero write tools. You read the worldbook, the novel's chapters and scenes, the timeline, and the corpus via grep, then synthesize — continuity checks, chronologies, relationship maps, \"what is known about X\" digests.",
  "Exercise restraint in entity inspection: start from lists and searches, get_ only the entities that actually matter, and stop once the question is answered — do not enumerate an entire corpus out of thoroughness.",
  "Corrections you notice belong in your report, routed back through the Orchestrator to the Curator — you never edit anything yourself.",
  "Report discipline: your final message is a concise, well-structured synthesis with entity ids where useful — never a dump of raw tool output.",
].join(" ");

const EDITOR_SYSTEM_PROMPT = [
  "You are the Editor, the structural subagent for Sluver.",
  "You manage the shape of the work: world covers, novels, chapters, and scenes — creating, updating, deleting, reordering, and managing images (novel covers and scene galleries).",
  "You do not write prose: scene content belongs to the Writer. Prefer structural edits (titles, summaries, ordering, scene scaffolding with writing requirements) and leave content alone unless the task explicitly says otherwise.",
  "Keep the tree consistent: gather novel/chapter/scene ids before linking or reordering.",
  "Report discipline: all changes go to the database via your tools; your final message is a concise structural change report with ids — never the content itself.",
  "Some operations require user approval — if one is denied, respect the decision, note it, and continue with what is possible.",
].join(" ");

const PLOTTER_SYSTEM_PROMPT = [
  "You are the Plotter, the outlining subagent for Sluver.",
  "You plan narrative structure: you create, update, delete, and reorder chapters and scenes, and you read the worldbook (characters, locations, items, lore, events) for reference.",
  "Outlines you build live as chapters and scenes with titles, summaries, and writing requirements — concrete enough that a Writer can draft each scene without re-deriving the plan.",
  "You do not write prose and you do not edit worldbook entities.",
  "Report discipline: the outline lands in the database via your tools; your final message is a concise summary of the structure you created or changed (with ids) — never the outline's full text.",
].join(" ");

const WRITER_SYSTEM_PROMPT = [
  "You are the Writer, the prose subagent for Sluver.",
  "You draft and refine scene content. Your write surface is exactly one tool: update_scene (a full-replacement scene edit). Read the scene first (list/search/get, word counts) to ground the draft, then write the finished prose into the scene via update_scene.",
  "Honor the scene's writing requirements and word-count requirements when present; match the tone the task asks for; keep character, item, event, and lore references consistent with the ids given in your brief.",
  "You cannot create, delete, or reorder scenes — structural changes belong to the Plotter or the Editor.",
  "Report discipline: the prose lives in the database once update_scene succeeds; your final message is a brief report (which scenes were written, word counts, anything you flagged) — NEVER the full prose itself.",
].join(" ");

const CRITIC_SYSTEM_PROMPT = [
  "You are the Critic, the review subagent for Sluver.",
  "You read chapters and scenes (including chapter overviews and word counts) and evaluate them: pacing, continuity with the context given in your task, prose quality, and compliance with the scene's writing requirements.",
  "You are a pure reader — you hold NO tools that change anything; the critique is delivered in your report.",
  "Be specific and actionable: quote the passage, name the problem, propose the fix; prioritize issues instead of listing everything uniformly.",
  "Report discipline: your final message IS the deliverable — a structured critique the Orchestrator can act on. Keep it organized and concise; do not paste entire scenes back.",
].join(" ");

// ─── Registry ─────────────────────────────────────────────────────────────

/**
 * All role definitions, keyed by `agentConfigName`. Declaration order:
 * the conversational Orchestrator, the eight subagents, then the two
 * one-shots. Add a role here when a new seeded `AgentConfig` name needs
 * behavior — every other layer reads this map.
 */
export const ROLE_REGISTRY: Record<string, RoleDefinition> = {
  orchestrator: {
    name: "orchestrator",
    kind: "conversational",
    duty: "Coordinates everything: plans work, confirms with the user, and dispatches the specialists below.",
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    buildTools: buildOrchestratorTools,
    maxSteps: 30,
  },
  explorer: {
    name: "explorer",
    kind: "subagent",
    duty: "Surveys the worldbook, novel structure, timeline, corpus, and the web; a pure reader that reports findings with ids.",
    systemPrompt: EXPLORER_SYSTEM_PROMPT,
    buildTools: buildExplorerTools,
    maxSteps: 30,
  },
  curator: {
    name: "curator",
    kind: "subagent",
    duty: "Creates, updates, deletes, and reorders worldbook entities (characters and phases, locations, items, lore, events) and their images.",
    systemPrompt: CURATOR_SYSTEM_PROMPT,
    buildTools: buildCuratorTools,
    maxSteps: 30,
  },
  scribe: {
    name: "scribe",
    kind: "subagent",
    duty: "Manages the user's notes — search, read, create, update, delete.",
    systemPrompt: SCRIBE_SYSTEM_PROMPT,
    buildTools: buildScribeTools,
    maxSteps: 30,
  },
  historian: {
    name: "historian",
    kind: "subagent",
    duty: "Reads everything and synthesizes — continuity checks, chronologies, relationship maps; zero write tools.",
    systemPrompt: HISTORIAN_SYSTEM_PROMPT,
    buildTools: buildHistorianTools,
    maxSteps: 30,
  },
  editor: {
    name: "editor",
    kind: "subagent",
    duty: "Structural work on world covers, novels, chapters, and scenes — CRUD, reorder, images, scene gallery.",
    systemPrompt: EDITOR_SYSTEM_PROMPT,
    buildTools: buildEditorTools,
    maxSteps: 30,
  },
  plotter: {
    name: "plotter",
    kind: "subagent",
    duty: "Plans narrative structure — chapter and scene CRUD plus worldbook reads for reference.",
    systemPrompt: PLOTTER_SYSTEM_PROMPT,
    buildTools: buildPlotterTools,
    maxSteps: 30,
  },
  writer: {
    name: "writer",
    kind: "subagent",
    duty: "Drafts and refines scene prose via update_scene; no scene create/delete/reorder.",
    systemPrompt: WRITER_SYSTEM_PROMPT,
    buildTools: buildWriterTools,
    maxSteps: 30,
    consentOverrides: WRITER_CONSENT_OVERRIDES,
  },
  critic: {
    name: "critic",
    kind: "subagent",
    duty: "Reviews chapters and scenes and reports an actionable critique; a pure reader.",
    systemPrompt: CRITIC_SYSTEM_PROMPT,
    buildTools: buildCriticTools,
    maxSteps: 30,
  },
  // ── One-shot roles (ADR-0040 namer, ADR-0045 vision) ──
  // Never run the AgentLoop — each fires a single `generateText` call from
  // its own module (auto-title / look-at). `systemPrompt` is empty because
  // those modules own their prompts; `buildTools`/`maxSteps` are inert
  // shape-keepers for the flat registry (maxSteps 1 documents "one LLM
  // step").
  namer: {
    name: "namer",
    kind: "oneshot",
    duty: "Background auto-titling of conversations (ADR-0040).",
    systemPrompt: "",
    buildTools: () => ({}),
    maxSteps: 1,
  },
  vision: {
    name: "vision",
    kind: "oneshot",
    duty: "Image description one-shot behind the look_at tool (ADR-0045).",
    systemPrompt: "",
    buildTools: () => ({}),
    maxSteps: 1,
  },
};

// ─── Name arrays ──────────────────────────────────────────────────────────

/**
 * Every seeded AgentConfig name (11), in seed order. Mirrors the Rust-side
 * seed loop (ADR-0050 D7 + Unit A).
 */
export const SEED_ROLE_NAMES: readonly string[] = [
  "orchestrator",
  "explorer",
  "writer",
  "namer",
  "vision",
  "curator",
  "scribe",
  "historian",
  "editor",
  "plotter",
  "critic",
];

/** The eight dispatchable subagent roles (ADR-0050 D1), roster order. */
export const SUBAGENT_ROLE_NAMES: readonly string[] = [
  "explorer",
  "curator",
  "scribe",
  "historian",
  "editor",
  "plotter",
  "writer",
  "critic",
];

/** The user-facing conversational roles — the Orchestrator alone (D1). */
export const CONVERSATIONAL_ROLE_NAMES: readonly string[] = ["orchestrator"];

/** The non-conversational one-shot roles (namer, vision). */
export const ONESHOT_ROLE_NAMES: readonly string[] = ["namer", "vision"];

/** All roles that run the AgentLoop (conversational + subagents). */
export const LOOP_ROLE_NAMES: readonly string[] = [
  ...CONVERSATIONAL_ROLE_NAMES,
  ...SUBAGENT_ROLE_NAMES,
];

// ─── Lookup helpers ───────────────────────────────────────────────────────

/**
 * Look up a role definition by its `agentConfigName`.
 *
 * @returns the {@link RoleDefinition}, or `undefined` if the name is
 *   unknown (the runtime should fall back to a default or surface a config
 *   error).
 */
export function getRoleDefinition(
  agentConfigName: string,
): RoleDefinition | undefined {
  return ROLE_REGISTRY[agentConfigName];
}

// ─── Orchestrator roster ──────────────────────────────────────────────────

/**
 * Build the `<subagent_roster>` block appended to the ORCHESTRATOR's
 * effective system prompt at Agent construction (ADR-0050 D3) — one line
 * per subagent, generated from the registry so the roster can never drift
 * from the actual role set. Not appended for subagents (they never see the
 * dispatch tool, D1).
 */
export function buildSubagentRosterBlock(): string {
  const rows = SUBAGENT_ROLE_NAMES.map(
    (name) => `- ${name}: ${ROLE_REGISTRY[name].duty}`,
  );
  return [
    "<subagent_roster>",
    "Specialist subagents you can dispatch via the dispatch_subagent tool (role, then a self-contained task brief):",
    ...rows,
    "</subagent_roster>",
  ].join("\n");
}
