# ADR-0031: Tool-call stub compaction (Context mode Phase 1)

**Status**: accepted.

## Context

ADR-0028 established the three-layer message model (Persisted Thread / Derived Model Input / Run Delta) and named "tool-call compaction for Context mode" as a future pipeline transform. ADR-0029 designed `ToolContext.threadLookup.findToolResult(toolCallId)` as the reverse channel for that transform (Phase 2, deferred). Neither is yet implemented.

This ADR lands **Phase 1**: a deterministic, per-role-configurable transform that replaces aged tool-call + tool-result pairs in the Derived Model Input with short text stubs, plus the `context_read` tool that expands a stub back to its original content on demand.

Two pressures shape the design:

1. **Token budget vs cache hit rate tension.** Stub replacement changes the middle of the Derived Model Input each time a turn crosses the age threshold, invalidating the prompt cache from that point to the end. The cache cost may exceed the token savings for short conversations with small tool results, but is a net win for long writing conversations with large entity payloads. Per-role configuration (ADR-0012) is the escape hatch — short-exploration roles disable compaction.

2. **Phase 2 semantic compaction is architecturally distinct.** Semantic compaction requires an LLM call and therefore cannot be a Derived Model Input pipeline transform (ADR-0028 invariant 2 requires all transforms to be pure functions). Phase 1 must not pre-abstract a `CompactionStrategy` interface that would bind Phase 2 to a shape it cannot use.

## Decision

Six parts, each independently motivated.

### 1. Configuration: per-role, in AgentConfig

Add a `contextCompaction` field to `AgentConfig` (ADR-0012, Space-scoped per-role):

```typescript
contextCompaction: {
  enabled: boolean;    // default false per role
  turnAge: number;     // default 3
}
```

- **per-role, not per-app or per-conversation.** Different roles have radically different conversation lengths (Explorer runs short探查, Writer runs long写作); per-app is too coarse, per-conversation forces the user to decide every time.
- **No per-conversation override** in Phase 1 (YAGNI). Adding a nullable column later is non-destructive.
- Plan mode has no "enable" flag (it is always on, no-op when the plan is empty). Compaction is different: it changes what the model sees and trades cache hits for tokens, so an explicit opt-in is more honest.

### 2. Trigger: user-turn age, default N = 3

Compaction fires at `Agent.run()` entry on every turn. A turn = one user message + all subsequent assistant/tool messages up to the next user message. The compactor computes `turnAge` for each turn (0 = current turn, 1 = previous, etc.) and compacts every tool-call + tool-result pair inside any turn with `turnAge >= N`.

- **User-turn boundary is a safe cut point**: a user message is always followed by its complete assistant + tool pair, so compacting "all tool pairs in turns older than N" never orphans a tool-call from its result (Pi ch.9 §三 confirms: "after-user cut is the safest choice").
- **Not token-threshold triggered** (unlike Pi's `shouldCompact`, ch.9 §二). Token estimation needs a tokenizer; `chars/4` severely underestimates Chinese (the project's primary language). Token-threshold triggering is deferred to Phase 2 semantic compaction, where it pairs with LLM summarization whose robustness absorbs the estimation error.
- **Single-shot per run**: the compactor is not invoked between steps inside one `Agent.run()` (ADR-0017 manual step loop accumulates Run Delta into a working array that starts from the Derived Input; compaction only re-runs at the next `run()` entry).

### 3. Message form: Scheme Z (preserve assistant reasoning, compact only tool pairs)

The compactor applies two rules based on whether the AssistantMessage carries text:

- **Rule 1 — pure tool-call AssistantMessage (no TextPart)**: replace the `[AssistantMessage(ToolCallPart) + ToolMessage(ToolResultPart)]` pair with a single `UserMessage` whose content is the stub text.
- **Rule 2 — mixed AssistantMessage (TextPart + ToolCallPart)**: keep the AssistantMessage's TextPart(s) verbatim, replace each ToolCallPart with a TextPart containing the stub, and delete the corresponding ToolMessage.

**Stub format**:

```
[tool_call {toolCallId}] {toolName} → {status}
```

**Status taxonomy** (three states, derived from AI SDK v7's `ToolResultPart.output` discriminated union):

| status    | trigger                                                                 |
| --------- | ----------------------------------------------------------------------- |
| succeeded | `output.type` is `text` / `json` / `content` — execute returned normally |
| failed    | `output.type` is `error-text` / `error-json` — execute threw, **including this project's `ToolDeniedError`** (see note below) |
| denied    | `output.type` is `execution-denied` — SDK built-in approval flow. **NOT currently produced by this project** (see note) |

> **Note on `denied` reachability (ADR↔impl gap, documented).** AI SDK v7's `ToolResultPart.output` is a discriminated union; `deriveStatus` maps `execution-denied` → `denied`. However, this project's consent gate (ADR-0025) throws `ToolDeniedError` from `execute`, which the SDK surfaces as `error-text` — indistinguishable from any other thrown error at the message layer. The `denied` branch is therefore unreachable for tool calls that go through this project's custom `ApprovalGate`; such calls collapse to `failed`. The `denied` mapping is retained for correctness (future SDK built-in approval flow, or provider-executed tools) at zero cost. The model will never observe `→ denied` in a compacted stub under the current consent implementation.

- **No parameter summary in the stub** (YAGNI). The model can call `context_read` if it needs args. This follows the "pull over push" pattern (Pi ch.8 §八.3): give a stub (the清单), let the model pull details on demand.
- **Role choice: `UserMessage`.** Follows Pi ch.9 §六 precedent (CompactionSummaryMessage converts to UserMessage). Anthropic and OpenAI both accept mid-conversation user messages; `system` is unreliable mid-thread (Anthropic restricts system to the opening).
- **Why Scheme Z over X / Y**:
  - **Scheme X** (compact only ToolResult output, keep ToolCallPart structure) does not match "compact to text" and complicates future parameter compaction.
  - **Scheme Y** (collapse the whole pair to one text message) drops the AssistantMessage's reasoning TextPart, losing the model's prior train of thought.
  - **Scheme Z** preserves reasoning while still compacting the tool pair.

### 4. Cache strategy: do not optimize in Phase 1, accept cache misses

The compactor is a pure transform; it must not be aware of provider-specific cache APIs (Anthropic `cacheControl` vs OpenAI automatic). Cache optimization is deferred.

- **Trade-off acknowledged**: each turn that newly crosses the age threshold invalidates the prompt cache from that turn to the end of the Derived Input. Net benefit is positive for long conversations with large tool results (Writer), possibly negative for short ones (Explorer) — the per-role config is the escape hatch.
- **Extension hooks (documented, not implemented)**:
  - `CompactionPolicy.cacheStrategy?: "none" | "anthropic-breakpoints"` field, default `"none"`.
  - Future cache optimization lives in a separate pipeline transform `applyCacheBreakpoints(messages, strategy)`, decoupled from the compactor (single-responsibility: compactor compacts, cache applier marks).
  - ADR-0030 token-usage persistence extends to record `cacheReadTokens` / `cacheWriteTokens` (currently ephemeral per ADR-0030 §5), giving Phase 2 data to drive cache optimization.

### 5. `context_read` tool + `threadLookup` (refines ADR-0029 Phase 2)

The reverse channel. Two refinements from ADR-0029's original Phase 2 design:

**Refinement A — interface shape**.

ADR-0029 §Phase 2 specified:

```typescript
interface ThreadLookup {
  findToolResult(toolCallId: string): ModelMessage | undefined
}
```

This returns only the result, not the call args. The actual requirement ("查参数和结果") needs both. Refined to:

```typescript
interface ThreadLookup {
  /** Find the original (uncompacted) tool-call + tool-result pair by toolCallId.
   *  Reads from the Persisted Thread (ADR-0028 invariant 1) — always returns
   *  original content, never compacted stubs. */
  findToolPair(toolCallId: string): { call: ToolCallPart, result: ToolResultPart } | undefined
}
```

This is a refinement of ADR-0029's design, not a contradiction — the field name (`threadLookup`) and intent (reverse channel into the Persisted Thread) are unchanged. ADR-0029 is not amended; this ADR documents the implementation shape.

**Refinement B — implementation site**.

`Agent.findToolPair(toolCallId)` method on the `Agent` class (alongside `getMessages` / `getPlan`). It reads from `Agent.messages` (Persisted Thread) — **never** from the Derived Model Input (ADR-0028 invariant 1: Persisted Thread is the source of truth and always carries original, uncompacted content). `ToolContext.threadLookup.findToolPair` closes over `agentRef` (the chicken-and-egg pattern from ADR-0029 §Negative).

**`context_read` tool definition** (placed in `src/lib/tools/system.ts`, alongside `plan`):

```typescript
{
  name: "context_read",
  consentLevel: "auto",
  description: "Expand a compacted tool-call stub to its original input and output. \
Use when you see a '[tool_call {id}] toolName → status' stub in older turns and need \
the full details. Recent tool calls are NOT compacted — do not call for them. Do not \
call to expand a previous context_read call (its result is already the expanded content).",
  inputSchema: { toolCallId: z.string() },
  execute: async (input, ctx) => {
    const pair = ctx.threadLookup.findToolPair(input.toolCallId)
    if (!pair) {
      return {
        error: "not_found",
        toolCallId: input.toolCallId,
        message: `No tool call with id "${input.toolCallId}" in the thread. The id may be incorrect or the call evicted.`
      }
    }
    return {
      toolName: pair.call.toolName,
      input: pair.call.input,
      output: pair.result.output,
      status: deriveStatus(pair.result)
    }
  }
}
```

Behavioral decisions:

- **consent `auto`**: read-only Persisted Thread access, no side effects.
- **No batch support**: the model calls multiple times in parallel if needed (auto-level is free). YAGNI.
- **Not-found returns structured error, does not throw**: a wrong id is a normal case (the model may misremember), not an invocation error. Throwing would confuse the model into thinking its call shape was wrong.
- **`context_read`'s own result ages normally**: it is appended to the Persisted Thread verbatim (ADR-0028 invariant 3) and will itself be compacted after N turns. The model will not loop on re-expanding it — the stub's toolName is `context_read`, and the description forbids expanding prior `context_read` calls.

### 6. Extension boundary for Phase 2: do not pre-abstract

Phase 1 exports a concrete `compactToolCalls(messages, policy): ModelMessage[]` from the pipeline barrel, alongside `composeSystemPrompt`. **No `CompactionStrategy` interface.**

Four reasons:

1. **Purity differs**: stub compaction is a deterministic pure function; semantic compaction calls an LLM (I/O) — it cannot be a Derived Model Input pipeline transform under ADR-0028 invariant 2. They cannot share a `compact(messages) → messages` contract without faking LSP.
2. **Trigger model differs**: stub compaction runs synchronously at every `run()` entry, age-triggered; semantic compaction runs asynchronously between turns, token-threshold-triggered (Pi ch.9 §一).
3. **Execution site differs**: stub compaction is a Derived Input transform; semantic compaction's site is open (it may need a new layer, possibly modifying ADR-0028 invariants 1 or 2, possibly introducing a Pi-style Session Tree + CompactionEntry). Pre-abstracting binds Phase 2 prematurely.
4. **YAGNI**: a Phase 1 `CompactionStrategy` interface would likely be reshaped in Phase 2 once the real constraints are known.

## Consequences

**Positive:**

- Long Writer conversations stay within context budget without losing tool-call traceability (model sees stubs, can pull originals via `context_read`).
- Persisted Thread integrity is preserved (ADR-0028 invariant 1 untouched) — original tool results are always available to `threadLookup`; compaction is non-destructive and reversible per-run.
- Per-role config matches the heterogeneous conversation lengths across roles; short-exploration roles pay no cache cost.
- The pipeline barrel gains its second transform, validating the ADR-0028 pipeline pattern and establishing the convention for future transforms.

**Negative:**

- Prompt cache hit rate drops for roles with compaction enabled. Each turn that newly crosses the age threshold invalidates the cache from that point to the end of the Derived Input. Mitigated by per-role opt-out; measured and optimized in Phase 2 after ADR-0030 extension records cache breakdowns.
- `ToolContext` widens by one field (`threadLookup`), touching every tool factory (trivial — destructuring only, per ADR-0029 §Negative). This is the cost ADR-0029 anticipated and accepted.
- The ADR-0029 `findToolResult` → `findToolPair` refinement means ADR-0029's literal Phase 2 snippet is not what gets implemented. Documented here; ADR-0029 itself is not amended (it correctly captures the architectural intent; this ADR captures the implementation detail).
- **`denied` is unreachable under the current consent flow.** AI SDK v7's `ToolResultPart.output` is a discriminated union (`text` / `json` / `execution-denied` / `error-text` / `error-json` / `content`), not an object with an `isError` boolean as this ADR originally assumed during design. The project's `ToolDeniedError` (ADR-0025) is thrown from `execute`, which the SDK surfaces as `error-text` — collapsed to `failed` by `deriveStatus`, indistinguishable from any other thrown error. The `denied` mapping (`execution-denied` → `denied`) is retained for correctness at zero cost but the model will never observe `→ denied` in a compacted stub unless the project later adopts the SDK's built-in approval flow. See Decision §3 note.

## Phase 2 (deferred, not designed here)

This ADR explicitly does NOT design semantic compaction. Recorded tensions for the future Phase 2 ADR to resolve:

- **ADR-0028 invariant 2 excludes LLM-driven transforms** from the Derived Input pipeline. Semantic compaction must live elsewhere (a between-turns async task, a Persisted Thread mutation, or a new layer).
- **Do not assume `compactToolCalls` is reusable** — semantic compaction has different purity, trigger, and execution site.
- **Cache optimization** (Decision §4 extension hooks) likely lands alongside semantic compaction, driven by real cache hit/miss data from the extended ADR-0030 persistence.

## References

- [ADR-0012 — Space-scoped AI config](./0012-space-scoped-ai-config.md) — `contextCompaction` lives on AgentConfig, Space-scoped per-role.
- [ADR-0017 — Agent manual step loop](./0017-agent-manual-step-loop.md) — defines the turn/step boundary the trigger model uses.
- [ADR-0025 — Tool consent execute-blocking gate](./0025-tool-consent-execute-blocking-gate.md) — `ToolDeniedError` source for the `denied` status.
- [ADR-0028 — Three-layer message model](./0028-three-layer-message-model.md) — pipeline execution site; invariants 1 (Persisted Thread integrity) and 2 (transform purity) govern this design.
- [ADR-0029 — ToolContext extension](./0029-toolcontext-extension-for-plan-and-context-modes.md) — `threadLookup` original design; this ADR refines `findToolResult` → `findToolPair`.
- [ADR-0030 — Token usage persistence](./0030-token-usage-persistence.md) — extension point for cache breakdown persistence.
- [Pi ch.8 — Context engineering](../pi-agent/第8章-上下文工程-让有限窗口装下无限对话.md) — "push vs pull" pattern motivates the no-arg-summary stub.
- [Pi ch.9 — Compaction](../pi-agent/第9章-上下文压缩-当对话太长怎么办.md) — semantic compaction reference for Phase 2; turn-boundary cut point safety; UserMessage role precedent.
