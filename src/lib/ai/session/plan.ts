/**
 * Plan type — the per-Conversation working agenda (ADR-0028, ADR-0029 Phase 1).
 *
 * A Plan is an ordered TODO list authored by the Agent via the `plan` tool.
 * It is NOT a Message — it is never appended to the Persisted Thread. Instead
 * it lives at `conversations.meta.plan` and is re-injected into the Derived
 * Model Input on every subsequent turn via the pipeline's plan-injector.
 *
 * The Plan is replaced wholesale (last-write-wins) on each `plan` tool call.
 * There is at most one active Plan per Conversation. See CONTEXT.md → Plan.
 *
 * Purity: this module defines types only — no runtime, no imports outside the
 * library purity boundary (ADR-0019).
 */

/** Status of an individual Plan item. */
export type PlanStatus = "pending" | "in_progress" | "done";

/** A single TODO item within a Plan. */
export interface PlanItem {
    /** The TODO text (plain string; agent is instructed to keep it short). */
    readonly text: string;
    /** Whether the item is pending, in progress, or done. */
    readonly status: PlanStatus;
}

/** The Plan itself — an ordered list of items. */
export interface Plan {
    readonly items: readonly PlanItem[];
}
