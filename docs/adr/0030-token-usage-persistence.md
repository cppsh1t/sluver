# ADR-0030: Token usage persistence through the SessionStore boundary

**Status**: accepted.

## Context

The agent chat system needs per-turn token-usage display (input/output tokens for each assistant reply). The AI SDK v7 `LanguageModelUsage` is already fully extracted by the stateless `AgentLoop` — `AgentLoopRunResult.totalUsage` (ADR-0017) sums `inputTokens`/`outputTokens`/`totalTokens` across all steps of a run, and the `step_end` event carries per-step usage. As of this ADR, the only consumer is `createAgentEventLogger` (`src/lib/ai/agent-logging.ts`), which logs `tokens_input`/`tokens_output` to the tracing file (ADR-0016) and discards the value. No usage reaches the UI or the persistence layer.

Three tensions shape the decision:

1. **Turn-level data vs per-message storage.** Usage is a property of an entire turn (one `totalUsage` per `Agent.run()`), but persistence is per-message: one `appendMessages` call writes the turn's delta (user message + 1..N assistant + 0..N tool-result messages) as separate rows. Usage does not natively belong to any single message row.

2. **The purity boundary (ADR-0019).** `SessionStore` is defined inside the pure library; `SessionMessage` is `ModelMessage & {id, sessionId, createdAt}` — usage is not part of it. Routing usage to the store means either extending the pure interface (touching ADR-0019's boundary) or routing around it (a separate IPC, breaking the "SessionStore is the only persistence egress" invariant).

3. **What to persist vs what to keep ephemeral.** Not every number in `LanguageModelUsage` is worth a column. `totalTokens` is `input+output` (redundant). Cache/reasoning breakdowns (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) are real-time signals whose historical values have little meaning after the fact. And the context-occupancy ratio's numerator (last step's `inputTokens`) is a live snapshot, not a turn aggregate.

## Decision

**Persist per-turn `inputTokens` + `outputTokens` only, on the turn's last assistant message row, routed through an extension of the pure `SessionStore` interface.** Six parts:

1. **Extend `SessionStore.appendMessages` with an optional `turnUsage?: LanguageModelUsage` third parameter** (the "route through" choice, vs a side-channel IPC). `Agent.run()` passes `result.totalUsage` when calling `appendMessages` after run resolution. The concrete `TauriSessionStore` implementation decides how to store it. The parameter is optional so existing `SessionStore` implementations (test stubs, alternative backends) remain valid without change.

   `LanguageModelUsage` is the AI SDK's generic usage type, already in the library's type space (`src/lib/ai/loop/types.ts`). It is not an application concept (no React, no IPC, no logger) — extending the interface with it does not violate ADR-0019's *spirit* (which prohibits app concerns), only stretches its *letter* by one optional parameter. The tradeoff is accepted: single persistence egress, atomic writes, vs a stricter but more fragmented alternative.

2. **Usage attaches to the turn's last `role === "assistant"` message row.** Every turn has at least one assistant message (the model is called at least once), so there is always a row to attach to. When the delta is `[user, asst(tool-call), tool, asst(text)]`, usage goes on the final text reply — matching the user's mental model ("what did this reply cost"). When the delta ends on a tool-call (step budget exhausted) or a tool-call alone (consent denied per ADR-0025), usage goes on that last assistant tool-call row — still correct, the model did consume tokens to decide the call. User and tool messages never carry usage.

3. **Two nullable `INTEGER` columns on `messages`: `usage_input_tokens`, `usage_output_tokens`.** New `WORLD_MIGRATION` (ALTER TABLE ... ADD COLUMN, non-destructive). Old messages from before the migration are NULL on both.

4. **Field independence for `undefined`.** `inputTokens` and `outputTokens` are judged separately: `undefined` → column NULL (provider did not report); a defined value including `0` → stored verbatim (provider reported a real zero, e.g. an empty completion). This preserves the "unknown" vs "zero" distinction end to end and matches `agent-logging.ts`'s existing treatment. SQLite `SUM` skips NULLs naturally, so partial reports (only one of the two reported) contribute only their reported half to any aggregate.

5. **Do not persist `totalTokens`, cache breakdowns, or reasoning breakdowns.** `totalTokens` is redundant (`input+output`). `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` are real-time signals — a cache hit's value is "did my prompt structure hit cache *just now*," which ages out within minutes as cache entries expire. Historical cache numbers are dead data. These fields remain available live (on `step_end.usage` and `result.totalUsage`) and the UI surfaces them ephemerally per-message, but they are not written to SQLite.

6. **The context-occupancy numerator is not persisted.** The C1 ratio's numerator (last-step `inputTokens` ÷ model context window) is a live snapshot of "how full is the context *right now*." The persisted `usage_input_tokens` on a message is the turn's *cross-step summed* input (cost view, multiplies by step count), which is the wrong number for occupancy. C1 is recomputed from the last run's final step on every render and shows "—" until the first message is sent in a session.

## Consequences

**Positive:**

- Per-turn token usage survives app restart. Reopening an old conversation shows what each reply cost at the time.
- Persistence is atomic with message writes (same transaction in `append_messages`); no "message saved but usage lost" window.
- The pure-library intrusion is one optional parameter on one method. `LanguageModelUsage` is an AI-SDK type already in the library's dependency graph, not an application concept — ADR-0019's prohibition is on React/IPC/logger coupling, which this does not introduce.
- The "unknown vs zero" distinction is preserved end to end, matching the existing logging convention.
- Aborted runs (ADR-0018) still produce partial `totalUsage`, which is persisted normally — the record of "what this (interrupted) turn cost" is honest.

**Negative:**

- `SessionStore.appendMessages` now has a domain-shaped parameter (token usage). Future readers will ask "why does a persistence interface care about tokens?" — answered by this ADR and by the inline docstring that should accompany the parameter. The alternative (side-channel IPC) was rejected for breaking the single-egress invariant.
- "Usage attaches to the last assistant message" is an implicit convention shared between `TauriSessionStore` (writes it) and the UI (reads it). Both sides must agree; documented here and in the store's docstring.
- Migration adds two columns to the `messages` table. Non-destructive (nullable, default NULL), but every `messages` row grows by two integers.

## Alternatives considered

- **Side-channel IPC (route around the pure library).** Add a separate `attach_turn_usage(conversation_id, message_id, usage)` command called from `conversation-runtime/store.ts` finalization, leaving `SessionStore` untouched. Rejected: `append_messages` and `attach_turn_usage` become two separate transactions; if the second fails, the message is saved but its usage is silently lost — unacceptable for a feature whose value is an honest cost record. The pure-library intrusion of the chosen approach is bounded to one optional parameter and an AI-SDK type.
- **Fully ephemeral (no persistence).** Capture usage into the reactive `view` only; discard on restart. Rejected: the core value of per-turn usage is "what did this reply cost," which extends to revisiting old conversations. Ephemeral would halve the feature's usefulness.
- **Turn-level sidecar table** (`turn_usages(message_id PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, ...)`). Rejected: schema overhead for a 1:1 relationship; two columns on `messages` is simpler and matches the existing table's style.
- **Embed usage inside `Message.body` (the opaque `ModelMessage` JSON).** Rejected: `body` is a verbatim round-trip of the SDK's message shape; injecting usage into it would pollute the opaque contract and require special unwrap logic on every read.
- **Per-message sidecar columns for cache/reasoning breakdowns.** Rejected: these are real-time signals without lasting value (Decision §5). Available live from `step_end.usage`; no historical query needs them.
- **Persisting the context-occupancy numerator.** Rejected: it is a live snapshot, not a turn aggregate (Decision §6); the persisted `usage_input_tokens` is a cost-view sum, the wrong number for occupancy.

## References

- [ADR-0017 — Agent drives a manual step loop over `streamText`](./0017-agent-manual-step-loop.md) — `totalUsage` originates here.
- [ADR-0018 — All `AgentLoop.run()` terminations resolve](./0018-abort-resolves-not-rejects.md) — aborted runs still produce partial `totalUsage`, persisted per Decision §1.
- [ADR-0019 — AI agent runtime library purity boundary](./0019-ai-agent-library-purity-boundary.md) — this ADR stretches its letter by one optional parameter without violating its spirit.
- [ADR-0020 — Session layer](./0020-session-layer.md) — `SessionStore` and `appendMessages` defined here.
- [ADR-0022 — Chat conversations World-scoped](./0022-chat-conversations-world-scoped.md) — `messages` table lives in `world.db`.
- [ADR-0025 — Tool consent execute-blocking gate](./0025-tool-consent-execute-blocking-gate.md) — consent-denied terminations still persist usage per Decision §2.
- [ADR-0028 — Three-layer message model](./0028-three-layer-message-model.md) — Persisted Thread is the source of truth; usage attaches to it, not to Derived Model Input.
- [CONTEXT.md → Message](../CONTEXT.md) — updated to mention optional token-usage metadata.
