# ADR-0028: Three-layer message model for Plan and Context modes

**Status**: accepted.

## Context

Two upcoming agent features break today's implicit invariant "what the user sees is what the model sees":

- **Plan mode** — the Agent authors a TODO list via a `plan` tool; the current Plan is silently re-injected into the model's input on every subsequent turn as a working-agenda reminder.
- **Context mode** — old tool-call results in the thread are compacted to `name+state+id` stubs to keep the model's context window under budget; the Agent can call `context_read` to expand a stub on demand.

Both features share the same structural insight: the array of messages the user sees (and that gets persisted) and the array of messages actually sent to the model are no longer the same array. Without an explicit model for this split, the codebase accumulates ad-hoc divergence — each feature invents its own "compress / inject / patch" hack, persistence and view drift apart, and reasoning about correctness becomes guesswork.

## Decision

Formalize three layers with strict invariants:

1. **Persisted Thread** — `Agent.messages: SessionMessage[]`. Append-only, never transformed. The single source of truth. The user-visible `view.messages` is a 1:1 mirror of this layer.
2. **Derived Model Input** — `ModelMessage[]`. A pure function of the Persisted Thread, recomputed from scratch every `Agent.run()`. Composed by a derivation pipeline of pure transforms (Plan reminder injection, tool-call compaction). Never persisted, never shown to the user.
3. **Run Delta** — `responseMessages` slice from `AgentLoop.run()` resolution. The model's new contributions for this turn. Appended verbatim to the Persisted Thread (no reverse-transform).

Invariants:

1. **Persisted Thread is the source of truth.** Append-only; no transform may mutate it in place. `view.messages === Persisted Thread` (1:1 mapping, what the user sees).
2. **Derived Model Input is a pure function of the Persisted Thread.** Recomputed every run; never cached, never persisted. Same Persisted Thread + same Plan snapshot + same compaction policy → same Derived Model Input. Every transform in the derivation pipeline must be a pure function — it may close over immutable snapshots (Plan, policy) but must not read live mutable state.
3. **Run Delta appends to Persisted Thread verbatim.** No reverse-transform. The delta was produced by the model in response to the Derived Input; it has never been through the forward pipeline, so there is nothing to reverse. (The next run will derive a fresh Derived Input from the now-longer Persisted Thread, applying compaction to the new delta as it ages.)
4. **Strict view/model separation.** The user sees only Persisted Thread. The model sees only Derived Model Input. No UI ever displays Derived Model Input directly; the model never observes that its input was derived.
5. **Pipeline execution site: `Agent.run()`.** The derivation pipeline runs between reading the Persisted Thread and calling `loop.run()`. The `AgentLoop` library stays pure (ADR-0019 unchanged); pipeline transforms live in `src/lib/ai/pipeline/` as pure functions.

## Consequences

**Positive:**

- One explicit mental model replaces an implicit one. Plan mode and Context mode become independent pure transforms over the same pipeline, composable and independently testable.
- The "view ≠ model input" question is answered once, definitively, for all future features that need it (e.g. summarization, retrieval injection, prompt caching).
- Idempotent derivation means reopening a Conversation always reconstructs the correct model input from the persisted thread + Plan state. No drift, no sync issues, no "compacted flag" to persist.
- The pipeline location at `Agent.run()` keeps the pure `AgentLoop` library unchanged — no relaxation of ADR-0019.
- Run Delta being append-verbatim means the persisted thread accumulates real history (full tool results preserved), so compaction policy can change later without data loss.

**Negative:**

- Two message arrays exist at runtime (Persisted Thread and Derived Model Input); developers must learn the distinction. Mitigated by naming + this ADR + inline docstrings.
- Token cost: every run re-derives from scratch. For long conversations this is a small CPU cost (negligible vs. the model round-trip). Compaction itself is what saves tokens; recomputing it per-run is cheap.
- "The user sees full tool results, the model sees stubs" can confuse debugging. Mitigation: a future Settings → Diagnostics toggle could log the Derived Model Input alongside the Persisted Thread for inspection.
- Compaction policy is encoded in code, not in the persisted thread. Changing the policy changes what the model sees for old conversations retroactively. This is a feature (idempotent re-derivation), but worth being aware of.

## References

- [ADR-0017 — Agent drives a manual step loop over `streamText`](./0017-agent-manual-step-loop.md)
- [ADR-0019 — AI agent runtime library purity boundary](./0019-ai-agent-library-purity-boundary.md)
- [ADR-0020 — Session layer](./0020-session-layer.md)
- [ADR-0022 — Chat conversations World-scoped](./0022-chat-conversations-world-scoped.md)
- [CONTEXT.md → Message layers](../CONTEXT.md) — Persisted Thread, Derived Model Input, Run Delta.
