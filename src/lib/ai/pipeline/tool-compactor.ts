/**
 * Tool-call stub compactor — the Context-mode pipeline transform
 * (ADR-0028, ADR-0031 Phase 1).
 *
 * Replaces aged tool-call + tool-result pairs in the Derived Model Input with
 * short text stubs (Scheme Z). The model can pull the original (uncompacted)
 * content back on demand via the `context_read` tool (ADR-0031 §5).
 *
 * ## Purity (CRITICAL — ADR-0028 invariant 2)
 *
 * This function is PURE: same `{ messages, policy }` input always produces the
 * same output array. It reads no mutable state, holds no closures, and performs
 * no I/O. The input array and every element in it are treated as immutable —
 * the output is a freshly constructed array (and freshly constructed message
 * objects wherever a mutation would have been required). The Persisted Thread
 * (`Agent.messages`) is never observed or modified by this transform; only the
 * Derived Model Input (a copy built at `Agent.run()` entry) is reshaped.
 *
 * ## Algorithm (ADR-0031 §3 — Scheme Z)
 *
 * 1. **Turn segmentation.** A "turn" is one user message + all subsequent
 *    assistant/tool messages up to (but excluding) the next user message. The
 *    last turn (the one containing the user message that triggered this run) is
 *    age 0; the previous is age 1; etc.
 *
 * 2. **Compaction boundary.** Every tool-call inside a turn whose age is
 *    `>= policy.turnAge` is compactable. Per ADR-0031 §2, the user-turn
 *    boundary is the safe cut point — a user message is always followed by its
 *    complete assistant + tool pair, so age-based compaction never orphans a
 *    tool-call from its result.
 *
 * 3. **Rewrite rules.** For each compactable assistant tool-call:
 *    - **Rule 1 — pure-tool assistant message** (content has ONLY ToolCallParts,
 *      no text/reasoning): the assistant message + its matching tool results
 *      are replaced by ONE `UserMessage` whose content is the joined stub lines.
 *    - **Rule 2 — mixed assistant message** (has text/reasoning + tool-call):
 *      the text/reasoning parts are preserved verbatim; each tool-call part is
 *      replaced in-place by a TextPart carrying the stub; the matching tool
 *      results are deleted from their ToolMessage.
 *
 * 4. **Stub format** (ADR-0031 §3):
 *    ```
 *    [tool_call {toolCallId}] {toolName} → {status}
 *    ```
 *    The `{toolCallId}` is preserved verbatim — the model uses it to call
 *    `context_read`.
 *
 * 5. **Status derivation.** Inspecting the original `ToolResultPart.output`
 *    discriminated union (AI SDK v7):
 *    - `output.type === "execution-denied"` → `denied` (SDK's built-in approval
 *      flow; not currently produced by this project's custom `ToolDeniedError`
 *      path, which lands as `error-text`, but handled for correctness).
 *    - `output.type === "error-text"` | `"error-json"` → `failed`.
 *    - otherwise (`"text"` | `"json"` | `"content"` | …) → `succeeded`.
 *    - no matching tool-result (should never happen — `filterIncompleteToolCalls`
 *      guarantees pairing upstream) → `failed` fallback.
 *
 * ## Skill-tool exemption (ADR-0043 §4 — amendment to ADR-0031)
 *
 * `activate_skill` call pairs are NEVER stubbed, regardless of age: the
 * skill's loaded instructions must persist in the model's view for the
 * whole conversation — stubbing them out mid-session is silent behavior
 * drift. `read_skill_file` is NOT exempt: its results are re-readable via
 * the tool, so aging them out is safe. See {@link isCompactionExempt}.
 *
 * ## No-op cases
 *
 * When `policy.enabled === false`, the input array is returned VERBATIM (same
 * reference) — zero allocation. When no user message is present, every message
 * is in age-0 (the only turn) and nothing is compacted.
 *
 * Related: ADR-0028 (three-layer model, invariant 2), ADR-0031 (this transform).
 */

import type {
    AssistantContent,
    ModelMessage,
    TextPart,
    ToolCallPart,
    ToolResultPart,
    UserModelMessage,
} from "ai";

import type { CompactionPolicy } from "./types";

// ─── Status derivation ───────────────────────────────────────────────────

/**
 * Tool names whose call/result pairs are exempt from stub compaction
 * (ADR-0043 §4 — amendment to ADR-0031). `activate_skill` results carry
 * the skill's instructions for the rest of the conversation; stubbing them
 * once aged would silently drop those instructions from the model's view.
 * `read_skill_file` is deliberately NOT listed — its results are
 * re-readable via the tool, so aging them out is safe.
 */
const SKILL_TOOLS_NEVER_COMPACT: ReadonlySet<string> = new Set([
    "activate_skill",
]);

/**
 * Pure predicate: whether a tool's call/result pairs must survive
 * compaction uncompacted, regardless of turn age (ADR-0043 §4).
 */
function isCompactionExempt(toolName: string): boolean {
    return SKILL_TOOLS_NEVER_COMPACT.has(toolName);
}

/**
 * Derive the stub status from a {@link ToolResultPart}'s output union.
 *
 * See the module docstring §5 for the full taxonomy. `denied` is reachable
 * only via the SDK's built-in approval flow (`output.type === "execution-
 * denied"`); this project's custom `ToolDeniedError` (ADR-0025) is thrown from
 * `execute`, which the SDK surfaces as `error-text` — indistinguishable from
 * any other thrown error at the message layer. Per ADR-0031 §Consequences,
 * that ambiguity is accepted: both collapse to `failed` here.
 */
export function deriveStatus(result: ToolResultPart): "succeeded" | "failed" | "denied" {
    const { output } = result;
    switch (output.type) {
        case "execution-denied":
            return "denied";
        case "error-text":
        case "error-json":
            return "failed";
        default:
            return "succeeded";
    }
}

// ─── Stub formatting ─────────────────────────────────────────────────────

/**
 * Build the single-line stub for one compacted tool-call. The `{toolCallId}`
 * is preserved verbatim — the model reads it from the stub and passes it to
 * `context_read` to recover the original args/output.
 *
 * Shape (ADR-0031 §3): `[tool_call {toolCallId}] {toolName} → {status}`
 */
function formatStub(
    toolCallId: string,
    toolName: string,
    status: "succeeded" | "failed" | "denied",
): string {
    return `[tool_call ${toolCallId}] ${toolName} \u2192 ${status}`;
}

/**
 * Build the stub for a tool-call given its matched tool-result. Centralizes the
 * status derivation so the compactor and `context_read` agree on the wording.
 */
function formatStubForPair(
    call: ToolCallPart,
    result: ToolResultPart | undefined,
): string {
    const status = result ? deriveStatus(result) : "failed";
    return formatStub(call.toolCallId, call.toolName, status);
}

// ─── Turn segmentation ───────────────────────────────────────────────────

/**
 * Compute the turn-age of every message index. A turn = one user message +
 * everything up to the next user message. The LAST turn is age 0; earlier
 * turns have ascending ages.
 *
 * Returns a `Uint32Array` (one slot per message) where each value is the age
 * of that message's turn. `0` is also the floor for messages that precede the
 * first user message (they belong to age-0's lead-in — there is no older turn
 * to compact them into).
 */
function computeTurnAges(messages: ModelMessage[]): Uint32Array {
    const ages = new Uint32Array(messages.length);
    // Collect user-message indices in one pass.
    const userTurnStarts: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user") userTurnStarts.push(i);
    }
    if (userTurnStarts.length === 0) {
        // No user message → everything is in the sole (age-0) turn.
        return ages;
    }
    // userTurnStarts[last] is the start of age 0; userTurnStarts[last - k] is
    // the start of age k. Assign each message the age of the most-recent turn
    // start at or before its index.
    const lastIdx = userTurnStarts.length - 1;
    for (let turnIdx = 0; turnIdx < userTurnStarts.length; turnIdx++) {
        const start = userTurnStarts[turnIdx];
        const end = turnIdx + 1 < userTurnStarts.length
            ? userTurnStarts[turnIdx + 1]
            : messages.length;
        const age = lastIdx - turnIdx;
        for (let i = start; i < end; i++) ages[i] = age;
    }
    // Messages before the first user message belong to the first turn's lead-in
    // (ages[0..firstStart-1] are already 0 from the Uint32Array zero-init).
    return ages;
}

// ─── Core transform ──────────────────────────────────────────────────────

/**
 * Compact aged tool-call + tool-result pairs in the Derived Model Input,
 * replacing them with short text stubs (Scheme Z — ADR-0031 §3).
 *
 * @param messages  The Derived Model Input (Persisted Thread + the just-appended
 *                  user message), all converted to `ModelMessage`. Treated as
 *                  immutable.
 * @param policy    The per-role compaction policy. When `enabled === false`,
 *                  the input array is returned verbatim (zero-cost no-op).
 * @returns A new array of `ModelMessage` with aged tool pairs stubbed. When
 *          nothing was compacted, the input array reference is returned.
 */
export function compactToolCalls(
    messages: ModelMessage[],
    policy: CompactionPolicy,
): ModelMessage[] {
    // Zero-cost no-op when disabled. Returning the SAME reference (not a copy)
    // lets upstream identity checks short-circuit and keeps the hot path
    // allocation-free for roles that opt out.
    if (!policy.enabled) return messages;

    const n = messages.length;
    if (n === 0) return messages;

    const ages = computeTurnAges(messages);

    // ── Pass 1: collect toolCallIds that are eligible for compaction ──
    // A toolCallId is compactable iff it appears in a tool-call part of an
    // assistant message whose turn-age is >= policy.turnAge. (We do NOT need
    // to look at the matching tool-result's age — by the turn invariant, a
    // user-message cut never splits a call/result pair, so the result lives
    // in the same turn as the call.) Exempt tool names (ADR-0043 §4) never
    // enter the set, so both their call parts and result parts survive
    // verbatim — the pass-3 rewrite and result-drop are both keyed on this
    // set alone.
    const compactableCallIds = new Set<string>();
    for (let i = 0; i < n; i++) {
        if (ages[i] < policy.turnAge) continue;
        const msg = messages[i];
        if (msg.role !== "assistant") continue;
        const { content } = msg;
        if (typeof content === "string" || !Array.isArray(content)) continue;
        for (const part of content) {
            if (
                part.type === "tool-call"
                && !isCompactionExempt(part.toolName)
            ) {
                compactableCallIds.add(part.toolCallId);
            }
        }
    }
    if (compactableCallIds.size === 0) return messages;

    // ── Pass 2: build a toolCallId → ToolResultPart index ──
    // Used to (a) format stubs and (b) check whether a tool-result needs to be
    // dropped. A given toolCallId has at most one tool-result across the whole
    // thread (provider contract).
    const resultByCallId = new Map<string, ToolResultPart>();
    for (const msg of messages) {
        if (msg.role !== "tool") continue;
        const { content } = msg;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (part.type === "tool-result") {
                resultByCallId.set(part.toolCallId, part);
            }
        }
    }

    // ── Pass 3: rebuild the thread, applying Rule 1 / Rule 2 ──
    const out: ModelMessage[] = [];
    for (let i = 0; i < n; i++) {
        const msg = messages[i];

        // ── AssistantMessage: maybe compact tool-call parts ──
        if (msg.role === "assistant") {
            const content = msg.content as AssistantContent;
            // String or non-array content: untouched (no tool-call parts).
            if (typeof content === "string" || !Array.isArray(content)) {
                out.push(msg);
                continue;
            }
            // `content` is now narrowed to the array variant of
            // `AssistantContent`. Partition parts: keep (text/reasoning/non-
            // compactable-call) vs compactable tool-calls.
            const contentArr: Exclude<AssistantContent, string> = content;
            const compactableCalls: ToolCallPart[] = [];
            const kept: typeof contentArr = [];
            for (const part of contentArr) {
                if (
                    part.type === "tool-call"
                    && compactableCallIds.has(part.toolCallId)
                ) {
                    compactableCalls.push(part);
                } else {
                    kept.push(part);
                }
            }
            if (compactableCalls.length === 0) {
                // No compaction touched this message — preserve identity.
                out.push(msg);
                continue;
            }
            if (kept.length === 0) {
                // Rule 1: pure-tool assistant → emit ONE UserMessage with the
                // joined stubs as plain text content (one line per call).
                const stubLines = compactableCalls.map((call) =>
                    formatStubForPair(call, resultByCallId.get(call.toolCallId)),
                );
                out.push(toolsStubUserMessage(stubLines));
            } else {
                // Rule 2: mixed → REPLACE each compactable tool-call part
                // IN PLACE with a TextPart carrying its stub. Text/reasoning
                // parts are preserved verbatim in their original positions, so
                // the model keeps its prior train of thought in order. Since
                // TextPart is already a member of the content element union,
                // the mapped array stays structurally valid for
                // AssistantContent.
                const rewritten: typeof contentArr = contentArr.map(
                    (part) =>
                        part.type === "tool-call"
                            && compactableCallIds.has(part.toolCallId)
                            ? ({
                                type: "text",
                                text: formatStubForPair(
                                    part,
                                    resultByCallId.get(part.toolCallId),
                                ),
                            } as TextPart)
                            : part,
                );
                out.push({ ...msg, content: rewritten });
            }
            continue;
        }

        // ── ToolMessage: drop tool-results whose call was compacted ──
        if (msg.role === "tool") {
            const { content } = msg;
            if (!Array.isArray(content) || content.length === 0) {
                out.push(msg);
                continue;
            }
            const kept = content.filter(
                (part) =>
                    part.type !== "tool-result"
                    || !compactableCallIds.has(part.toolCallId),
            );
            if (kept.length === 0) {
                // Every result in this ToolMessage belonged to a compacted
                // call — drop the message entirely (Rule 1 / Rule 2 cleanup).
                continue;
            }
            out.push(
                kept.length === content.length ? msg : { ...msg, content: kept },
            );
            continue;
        }

        // ── UserMessage / other: verbatim ──
        out.push(msg);
    }
    return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a {@link UserModelMessage} whose content is the joined stub lines for
 * a Rule-1 (pure-tool) replacement. The role choice (`user`, not `system`)
 * follows ADR-0031 §3 — mid-thread `system` messages are unreliable on
 * Anthropic; `user` is universally accepted.
 */
function toolsStubUserMessage(stubLines: string[]): UserModelMessage {
    return {
        role: "user",
        content: stubLines.join("\n"),
    };
}
