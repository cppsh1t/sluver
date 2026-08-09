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
 * When the Plan has active (pending or in-progress) items, the reminder block
 * appended to the static prompt looks like:
 *
 * ```
 * {staticPrompt}
 *
 * ---
 *
 * ## Current Plan ({doneCount} of {total} done[, {n} in progress])
 *
 * Items marked `[~]` are in progress — resume them and mark each `done` when
 * finished, or re-plan if stale. Items marked `[ ]` are pending.
 *
 * - [~] {in-progress item text}
 * - [ ] {pending item 1 text}
 * - [ ] {pending item 2 text}
 * ```
 *
 * - ACTIVE items (in-progress + pending) are rendered as bullets in their
 *   original Plan order. In-progress items use the `[~]` marker; pending items
 *   use the `[ ]` marker. DONE items are hidden — the counts in the header
 *   convey their number.
 * - `{doneCount}` = items with `status === "done"`.
 * - `{n}` = items with `status === "in_progress"` (shown only when > 0).
 * - `{total}` = `items.length` (pending + in-progress + done).
 * - When no item is in progress, the intro line reads "Continue working through
 *   the pending items below. Mark items done by calling the `plan` tool with the
 *   updated list; add new items or reorder as needed." instead.
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
    const inProgressItems = items.filter((item) => item.status === "in_progress");
    // Active = not yet done. Rendered as bullets in original order so the
    // model resumes an in-progress item rather than restarting it.
    const activeItems = items.filter(
        (item) => item.status === "in_progress" || item.status === "pending",
    );

    let header = `## Current Plan (${doneCount} of ${total} done)`;
    if (inProgressItems.length > 0) {
        header += `, ${inProgressItems.length} in progress`;
    }

    let intro: string;
    // The block is assembled top-down; active bullets are appended only when
    // at least one active (pending or in-progress) item exists.
    const block: string[] = ["", "---", "", header, ""];

    if (activeItems.length === 0) {
        // All items done — keep the header (so the model knows a Plan existed)
        // but signal completion instead of listing bullets.
        intro =
            "All items complete; consider whether a new Plan is needed.";
        block.push(intro);
    } else {
        if (inProgressItems.length > 0) {
            intro =
                "Items marked `[~]` are in progress — resume them and mark each `done` when finished, or re-plan if stale. Items marked `[ ]` are pending.";
        } else {
            intro =
                "Continue working through the pending items below. Mark items done by calling the `plan` tool with the updated list; add new items or reorder as needed.";
        }
        block.push(intro, "");
        for (const item of activeItems) {
            const marker = item.status === "in_progress" ? "- [~]" : "- [ ]";
            block.push(`${marker} ${item.text}`);
        }
    }

    return `${staticPrompt}\n${block.join("\n")}`;
}
