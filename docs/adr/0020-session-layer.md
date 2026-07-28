# Session layer: stateful Agent wraps stateless AgentLoop

**Status**: accepted.

The session layer at `src/lib/ai/session/` adds conversation memory and persistence on top of the stateless `AgentLoop` (ADR-0017). Three new concepts: `Agent` (stateful, multi-turn wrapper), `SessionStore` (pure persistence interface, concrete impl outside the library per ADR-0019), and `SessionMessage` (a `ModelMessage` enriched with `id`, `sessionId`, `createdAt`).

The stateless `AgentLoop` was renamed from `Agent` to make room: `AgentLoop` is the pure single-run executor (ADR-0017); `Agent` is the stateful consumer-facing class that auto-loads history, drives the loop, and auto-persists message deltas. One `Agent` instance is bound to one session for its lifetime (multi-session management is an app-layer concern, not the library's).

Persistence uses a delta model: `SessionStore.loadMessages(sessionId)` loads the full thread on resume; `SessionStore.appendMessages(sessionId, delta)` appends only new messages after each turn. The user message is persisted best-effort before the loop runs (fire-and-forget; `run()` is sync, so the persist cannot be awaited without making the API async); the assistant delta is persisted on `handle.result` resolution. Since ADR-0018 (revised) guarantees all terminations resolve, the same `.then()` path handles success, abort, and error uniformly — partial messages from aborted or errored runs are persisted. Persistence failures never throw — they are surfaced via an optional `onPersistError` callback on `AgentOptions`. The loop's concurrency guard (`ConfigError` on concurrent `run()`) is checked before any side effect is committed, so a throw leaves the message thread and store untouched.

The `SessionStore` interface is defined inside the pure library boundary (ADR-0019) but its concrete implementation (SQLite, IndexedDB, etc.) lives outside — mirroring the tool-closure-capture pattern. `SessionRecord.meta` is an opaque `unknown` escape hatch for app-specific metadata (Scene FK, title); the library does not interpret it.

Tradeoffs:

- The rejected alternative was folding statefulness into `AgentLoop` itself. That would have killed the stateless one-shot executor primitive (needed for summarization, batch generation, stateless evaluation) and coupled the loop to persistence concerns.
- The rejected alternative was making `Session` (the state) and `Agent` (the executor) separate classes. One `Agent` = one session is simpler and matches the mental model; multi-session management belongs to a higher layer.
- `meta: unknown` sacrifices type safety at the library boundary. The app-side wrapper provides typed access. This keeps the library domain-agnostic (ADR-0019).
