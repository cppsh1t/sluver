/**
 * Per-role behavior bundle for the AI Chat feature.
 *
 * A {@link RoleBehavior} is the role-specific subset of
 * {@link AgentLoopOptions} — everything *except* `model`, which the runtime
 * resolves live from the Space-scoped `AgentConfig` per session (ADR-0023).
 * The runtime merges a `RoleBehavior` with a bound model to construct an
 * `AgentLoop`.
 *
 * v1 hardcodes two roles (`explorer`, `writer`) and binds the same
 * {@link demoToolSet} to both — real functional tools land later. System
 * prompts are hardcoded strings; behavior persistence is future work
 * (ADR-0023).
 *
 * This module is framework-agnostic logic: no React, no IPC, no logger.
 */

import type { ToolSet } from "@/lib/ai";
import { demoToolSet } from "@/lib/tools/demo";

// ─── Type ─────────────────────────────────────────────────────────────────

/**
 * The role-specific subset of {@link AgentLoopOptions} (everything except
 * `model`). The runtime supplies the model per session.
 *
 * `name` mirrors the `agentConfigName` key and is carried alongside so a
 * resolved {@link RoleBehavior} is self-describing (useful for logging /
 * debugging without re-deriving the key).
 */
export interface RoleBehavior {
  /** The `agentConfigName` this behavior is bound to (e.g. "explorer"). */
  readonly name: string;
  /** System prompt sent on every step; NOT a `SystemModelMessage` in the thread. */
  readonly systemPrompt: string;
  /** Tools accessible to the model. Pass `{}` explicitly when none. */
  readonly tools: ToolSet;
  /** Maximum number of steps before the loop forces `finishReason: 'max-steps'`. */
  readonly maxSteps: number;
  /** Sampling temperature. Omit to let the loop default apply. */
  readonly temperature?: number;
}

// ─── System prompts (v1 hardcoded; ADR-0023) ──────────────────────────────

const EXPLORER_SYSTEM_PROMPT = [
  "You are the Explorer, a worldbuilding assistant for Sluver.",
  "You help users brainstorm and survey their fictional world — characters, locations, events, and lore.",
  "Be curious, generative, and concrete: offer specific suggestions the user can build on, and ask a clarifying question when intent is ambiguous.",
  "(v1 demo: alongside worldbuilding guidance, you have a few test tools — call them when the user asks about rice arithmetic or the current time.)",
].join(" ");

const WRITER_SYSTEM_PROMPT = [
  "You are the Writer, a novel-writing assistant for Sluver.",
  "You help users draft and refine prose — scenes, chapters, dialogue, description.",
  "Be evocative and precise; match the tone the user is aiming for and respect their voice rather than rewriting it wholesale.",
  "(v1 demo: alongside writing help, you have a few test tools — call them when the user asks about rice arithmetic or the current time.)",
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
    tools: demoToolSet,
    maxSteps: 5,
  },
  writer: {
    name: "writer",
    systemPrompt: WRITER_SYSTEM_PROMPT,
    tools: demoToolSet,
    maxSteps: 5,
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
