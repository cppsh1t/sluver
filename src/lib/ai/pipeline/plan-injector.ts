/**
 * Plan-injector — the Plan mode pipeline transform (ADR-0028, ADR-0029 Phase 1).
 *
 * Composes the per-run system prompt by appending the current Plan as a
 * reminder block to the role's static system prompt. This is the ONLY pipeline
 * transform for Phase 1; future transforms (tool-call compaction for Context
 * mode) will compose alongside it.
 *
 * ## Purity (CRITICAL — ADR-0028 invariant 2)
 *
 * This function is PURE: same `{ staticPrompt, plan }` input always produces
 * the same output string. It reads no mutable state, holds no closures, and
 * performs no I/O. The Plan is passed in as an immutable snapshot taken at
 * `Agent.run()` entry; the injector never observes live Plan mutations that
 * occur mid-run.
 *
 * ## Output format
 *
 * When the Plan has pending items, the reminder block appended to the static
 * prompt looks like:
 *
 * ```
 * {staticPrompt}
 *
 * ---
 *
 * ## Current Plan ({doneCount} of {total} done)
 *
 * Continue working through the pending items below. Mark items done by calling
 * the `plan` tool with the updated list; add new items or reorder as needed.
 *
 * - [ ] {pending item 1 text}
 * - [ ] {pending item 2 text}
 * ```
 *
 * - Only PENDING items are rendered as bullets (done items are hidden — the
 *   counts in the header convey their number).
 * - `{doneCount}` = items with `status === "done"`.
 * - `{total}` = `items.length` (pending + done).
 * - If ALL items are done, the header still appears, but the intro line reads
 *   "All items complete; consider whether a new Plan is needed." and no bullets
 *   follow.
 *
 * ## No-op cases
 *
 * When `plan` is `null` or `plan.items` is empty, the static prompt is returned
 * UNCHANGED (no separator, no header). This normalizes "field absent" and
 * "empty items" to identical output (the store contract maps both to `null`).
 *
 * Related: ADR-0028 (three-layer model), ADR-0029 Phase 1 (Plan mode).
 */

import type { SystemPromptComposerInput } from "./types";

/**
 * Compose the per-run system prompt by injecting the Plan reminder block.
 *
 * @param input - The static role prompt and the Plan snapshot (may be null).
 * @returns The composed system prompt. When there is no Plan to inject, the
 *   `staticPrompt` is returned verbatim (same reference).
 */
export function composeSystemPrompt(
    input: SystemPromptComposerInput,
): string {
    const { staticPrompt, plan } = input;

    // No Plan (absent or empty) → no reminder block. Return the static prompt
    // unchanged so non-Plan-aware callers see zero overhead.
    if (plan === null || plan.items.length === 0) {
        return staticPrompt;
    }

    const items = plan.items;
    const total = items.length;
    const doneCount = items.filter((item) => item.status === "done").length;
    const pendingItems = items.filter((item) => item.status === "pending");

    const header = `## Current Plan (${doneCount} of ${total} done)`;

    let intro: string;
    // The block is assembled top-down; pending bullets are appended only when
    // at least one pending item exists.
    const block: string[] = ["", "---", "", header, ""];

    if (pendingItems.length === 0) {
        // All items done — keep the header (so the model knows a Plan existed)
        // but signal completion instead of listing bullets.
        intro =
            "All items complete; consider whether a new Plan is needed.";
        block.push(intro);
    } else {
        intro =
            "Continue working through the pending items below. Mark items done by calling the `plan` tool with the updated list; add new items or reorder as needed.";
        block.push(intro, "");
        for (const item of pendingItems) {
            block.push(`- [ ] ${item.text}`);
        }
    }

    return `${staticPrompt}\n${block.join("\n")}`;
}
