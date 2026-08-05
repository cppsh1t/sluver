# ADR-0029: ToolContext extension for Plan and Context modes

**Status**: accepted (Phase 1 implemented; Phase 2 deferred).

## Context

The agent's tools today receive a `ToolContext` bag (`src/lib/tools/types.ts`) carrying the runtime identifiers and infrastructure they need to execute: `spaceId`, `worldId`, `approvalGate`, `autoExecuteDangerousTools`. Two upcoming agent features require tools that reach beyond this surface into the Agent's live state:

- **Plan mode (ADR-0028)** — the `plan` tool must read the current Plan (for output counts) and write a new Plan (updating Agent state + persisting). This cannot flow through tool return values alone; the Plan state lives on the Agent, not in the message thread.
- **Context mode (deferred)** — the `context_read` tool must look up the original (uncompressed) tool-result for a given `toolCallId` in the Persisted Thread. The thread is owned by the Agent; the tool needs a query path into it.

Both capabilities share the same structural need: a tool's `execute` closure must reach back into Agent-owned state at runtime. The `ToolContext` bag is the natural injection point — it already captures per-conversation runtime closures (`approvalGate` is built the same way), and tool factories already destructure it.

## Decision

Extend `ToolContext` with two new fields, each a dedicated interface matching the `ApprovalGate` style (named contract, mockable, small surface). One interface per concern — not bundled under a single `agentAccess` namespace — because Plan access (mutable working state, read+write) and thread lookup (immutable history, read-only query) are different concerns with different lifecycles.

### Phase 1 — Plan mode (implemented)

```ts
interface ToolContext {
  // existing fields unchanged
  spaceId: SpaceId;
  worldId: WorldId;
  approvalGate: ApprovalGate;
  autoExecuteDangerousTools: boolean;
  // NEW
  planAccess: PlanAccess;
}

interface PlanAccess {
  /** Read the current Plan snapshot (taken at Agent.run() start). */
  get(): Plan | null;
  /** Write a new Plan; persists immediately. Per ADR-0028 invariant 2,
      the new Plan takes effect on the NEXT run, not the current one. */
  set(plan: Plan): Promise<void>;
}
```

The `plan` tool's `execute` calls `planAccess.set(input)` and uses `planAccess.get()` only to compute the output summary (`pendingCount` / `doneCount`). Other tools never read Plan state — the reminder is injected into the system prompt at run start (ADR-0028), not exposed via context.

### Phase 2 — Context mode (deferred; designed, not built)

```ts
interface ToolContext {
  // ...Phase 1 fields...
  // NEW (Phase 2)
  threadLookup: ThreadLookup;
}

interface ThreadLookup {
  /**
   * Find the original (uncompressed) tool-result message for a given toolCallId.
   * Returns undefined if not found (id wrong, or message absent).
   */
  findToolResult(toolCallId: string): ModelMessage | undefined;
}
```

`threadLookup.findToolResult` is the reverse channel for `context_read`: it scans the Agent's messages for the matching `tool-result` part. Because the Agent's full thread is the source of truth and compaction is applied only at derivation time (ADR-0028 invariant 1), the lookup always returns the original content.

## Phasing

This ADR captures the full architectural intent (both fields). Implementation follows feature scope:

- **Phase 1 (this task — Plan mode)**: implement `planAccess` only. The `threadLookup` field is NOT added to `ToolContext` yet — YAGNI; an unused field on every tool factory's input invites confusion.
- **Phase 2 (future Context mode task)**: add `threadLookup` to `ToolContext` and the `context_read` tool that consumes it. No new ADR required — this ADR already describes the design.

## Consequences

**Positive:**

- Tools gain structured access to live Agent state without leaking the `Agent` class itself (the closures reach in via narrow interfaces).
- Dedicated interfaces (`PlanAccess`, `ThreadLookup`) match the `ApprovalGate` precedent — mockable, testable, single-responsibility.
- Capturing both phases up front avoids re-grilling the `threadLookup` shape when Context mode lands.

**Negative:**

- A small implementation wrinkle: tool factory closures capture an `agentRef` that is initially `null` and is back-filled after `Agent.open()` returns (the chicken-and-egg of "tools need ctx → ctx closes over agent → agent needs tools"). The closures read `agentRef.current` at execution time, when the Agent is guaranteed to exist (AgentLoop runs only after construction completes). Documented in the `constructAgent` docstring.
- Adding `threadLookup` in Phase 2 will touch every tool factory (each receives a wider ctx shape). Trivial — destructuring only — but a global change.

## References

- [ADR-0028 — Three-layer message model](./0028-three-layer-message-model.md) — the model that makes the reverse `threadLookup` necessary (compaction hides original content from the model) and that governs the snapshot semantics of `planAccess`.
- [ADR-0019 — AI agent runtime library purity boundary](./0019-ai-agent-library-purity-boundary.md) — `ToolContext` is part of the application-bridging layer, not the pure library; this extension stays inside that boundary.
- [ADR-0020 — Session layer](./0020-session-layer.md) — `Agent` owns the state these hooks expose.
- `src/lib/tools/types.ts` — `ToolContext` definition (to be extended in Phase 1).
