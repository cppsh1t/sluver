/**
 * Pipeline barrel — pure transforms for the Derived Model Input (ADR-0028).
 *
 * - {@link ./plan-injector} — `composeSystemPrompt`: appends the Plan reminder
 *   block to the role's static system prompt (Plan mode, ADR-0029 Phase 1).
 * - {@link ./types}         — `SystemPromptComposerInput`.
 *
 * Purity: this module and its siblings import only from siblings and
 * `../session/plan`. No React, no IPC, no logger (ADR-0019).
 *
 * Future transforms (tool-call compaction for Context mode — ADR-0028) will be
 * exported from this barrel alongside the plan-injector.
 */

export { composeSystemPrompt } from "./plan-injector";
export type { SystemPromptComposerInput } from "./types";
