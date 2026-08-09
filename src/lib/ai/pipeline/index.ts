/**
 * Pipeline barrel — pure transforms for the Derived Model Input (ADR-0028).
 *
 * - {@link ./plan-injector}  — `composeSystemPrompt`: appends the Plan reminder
 *   block to the role's static system prompt (Plan mode, ADR-0029 Phase 1).
 * - {@link ./tool-compactor} — `compactToolCalls`: stubs aged tool-call +
 *   tool-result pairs to short text (Context mode, ADR-0031 Phase 1).
 * - {@link ./types}          — `SystemPromptComposerInput`, `CompactionPolicy`.
 *
 * Purity: this module and its siblings import only from siblings,
 * `../session/plan`, and the `ai` SDK's type surface. No React, no IPC, no
 * logger (ADR-0019). Every transform is a deterministic pure function of its
 * inputs (ADR-0028 invariant 2).
 */

export { composeSystemPrompt } from "./plan-injector";
export { compactToolCalls, deriveStatus } from "./tool-compactor";
export type { SystemPromptComposerInput, CompactionPolicy } from "./types";
