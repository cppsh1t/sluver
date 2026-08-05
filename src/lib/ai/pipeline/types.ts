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
