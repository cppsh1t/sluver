/**
 * Pipeline types for the Derived Model Input (ADR-0028).
 *
 * The pipeline module hosts pure transforms that convert the Persisted Thread
 * + Plan snapshot into the Derived Model Input. Currently only the plan-injector
 * transform exists (Plan mode); future transforms (tool-call compaction for
 * Context mode) will live here too.
 *
 * Purity: imports only from siblings and ../session/plan. No React, no IPC,
 * no logger — same boundary as the rest of src/lib/ai/ (ADR-0019).
 */

import type { Plan } from "../session/plan";

/**
 * Input to the system-prompt composer. The `staticPrompt` is the role's
 * hardcoded system prompt (e.g. `EXPLORER_SYSTEM_PROMPT`); the `plan` is the
 * snapshot taken at `Agent.run()` entry (may be `null` or empty).
 *
 * Both fields are treated as immutable by the composer — the function is pure
 * and closes over no mutable state (ADR-0028 invariant 2).
 */
export interface SystemPromptComposerInput {
    /** The role's base system prompt, unmodified by the pipeline. */
    readonly staticPrompt: string;
    /** The Plan snapshot for the current run, or `null` if none is set. */
    readonly plan: Plan | null;
}

/**
 * Per-role policy governing tool-call stub compaction (ADR-0031 Phase 1).
 *
 * Constructed at Agent-build time from the persisted `AgentConfig.contextCompaction`
 * (ADR-0012 Space-scoped per-role config). The `Agent` closes over one
 * `CompactionPolicy` for its lifetime — reconfiguration takes effect the next
 * time the Space window reopens and the Provider rebuilds the Agent (the same
 * lifecycle rule as model rebinding, ADR-0023).
 *
 * `cacheStrategy` is an extension hook for Phase 2 cache optimization
 * (ADR-0031 §4). Phase 1 implements only `"none"` — the compactor is a pure
 * transform and must not be aware of provider-specific cache APIs. The field
 * is defined here so a future `applyCacheBreakpoints` transform can consume
 * it without reshaping this interface.
 */
export interface CompactionPolicy {
    /**
     * Whether stub compaction is active. When `false`, {@link compactToolCalls}
     * returns the input array verbatim (zero-cost no-op).
     */
    readonly enabled: boolean;
    /**
     * Number of recent user-turns whose tool calls are kept verbatim. `0`
     * compacts every prior turn (only the current turn is preserved).
     */
    readonly turnAge: number;
    /**
     * Cache optimization strategy — extension hook, NOT implemented in
     * Phase 1. `"none"` (default) leaves cache control to the provider's
     * automatic behavior. `"anthropic-breakpoints"` is reserved for a future
     * `applyCacheBreakpoints` pipeline transform (ADR-0031 §4).
     */
    readonly cacheStrategy?: "none" | "anthropic-breakpoints";
}
