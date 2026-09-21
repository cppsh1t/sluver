# ADR-0050: Subagent orchestration — one Orchestrator, eight dispatchable specialists, one-shot hidden runs

**Status**: accepted. Replaces the two-role (explorer/writer) user-facing chat surface; amends ADR-0045's conditional `look_at` registration; ADR-0023's role-binding principle survives unchanged (the Orchestrator is simply the only pickable role). *(Amended 2026-09-21: D1's forced-delegation purity relaxed — the Orchestrator gains a base read surface; see D1.)*

## Context

The dual-role chat surface gives every conversation one of two fat behavior bundles (~84 tools for explorer, ~64 for writer). Both bundles must carry the entire worldbook + novel + notes + web surface "just in case," which is a permanent context tax on every turn, and the two roles have no division of labor for the actual novel pipeline (outline → write → critique). The redesign: one user-facing coordinating role (Orchestrator) that dispatches single-purpose Subagents, each with a lean toolset tuned to its job.

Decisions D1–D11 below came out of a design interview; they are recorded together because they form one architecture.

## Decision

### 1. Role topology and the single role registry

The user-facing conversational surface is the **Orchestrator** alone. Eight **Subagents** are seeded per Space — explorer, curator, scribe, historian, editor, plotter, writer, critic — dispatchable only by the Orchestrator (exactly one delegation level; subagents never receive the dispatch tool). `namer`/`vision` remain non-conversational one-shots, untouched.

The role name string previously crossed five layers with no single source of truth (DB seed → conversation row → `modelResolver` ternary → `ROLE_BEHAVIOR` map → list-page `ROLES` array). All of it collapses into **one role registry**: name, subagent flag, system prompt, `buildTools`, `maxSteps`, per-role consent overrides, and dispatch visibility. Every layer (model resolution, conversation creation, seeding, roster prompt) reads from it.

**Orchestrator tool purity**: the Orchestrator carries only universal tools (time, format, plan, context_read, dispatch, and conditionally skills/shell/look_at) — no entity, notes, or web tools. Even trivial lookups ("how many characters?") are dispatched to explorer. This is deliberate: a coordinator that *can* query will query (model behavior inertia); forced delegation keeps its context permanently lean.

> **Amendment** (2026-09-21): the purity rule is relaxed by a **base read surface** — the Orchestrator now carries the worldbook read trio (list_/search_/get_/count_ across characters, locations, items, lore, events), `grep`, and `web_search`, all consentLevel `auto`. Rationale: every trivial lookup was costing a full dispatch round-trip (child conversation boot + LLM run + report), which in practice made small questions slow and expensive. The delegation stance survives for everything heavier: novel/chapter/scene reads, notes, web page reading (`web_fetch`*), `timeline_lookup`, surveys/synthesis, and every write still go through subagents. The original concern (a coordinator that queries bloats its own context) is accepted as the tradeoff and mitigated in the Orchestrator's prompt: own reads are scoped to "trivial lookups settleable in one or two calls".

### 2. Subagent Run = one-shot hidden conversation

One Dispatch = one fresh execution. A **Subagent Run** is persisted as a Conversation row with `meta.kind = "subagent"` and parent linkage (`parentConversationId`, `parentToolCallId`), created by the dispatch tool at execution time. Rationale: the entire message stack (delta append, usage columns, attachments cascade, message mutations, `TauriSessionStore` hydration) and the conversation runtime store keying are reused verbatim — a run is just another session id to every layer below. `list_conversations` already filters non-`world` kinds, so runs never appear in the chat list.

Runs share no memory — cross-run context flows exclusively through the Orchestrator's task briefs (explicit, curator-edited). Auto-titling is suppressed for `kind: "subagent"` (namer stays silent-skip). Compaction can never fire inside a run (a single-user-turn thread never ages past `turnAge`).

Rejected: persistent per-role subagent sessions (contradicts the context-diet goal; concurrent same-role dispatches would contend on one thread) and sidecar `subagent_runs`/`subagent_messages` tables (duplicates the heaviest infrastructure in the codebase for zero semantic gain).

### 3. Dispatch contract: one tool, parallel-in-step, blocking

A single `dispatch_subagent(role, task)` tool. `role` is a **static enum of all eight subagents** (schema stability is also prompt-cache-friendly); `task` is free-form text the Orchestrator composes. The roster with usage guidance lives in the Orchestrator's system prompt, generated from the registry.

Mechanics: sibling dispatch calls emitted in one step are executed concurrently by the SDK; each `execute` blocks until its child run resolves; the step completes when all resolve. This delivers "block the Orchestrator until all subagents finish" with zero new loop machinery — it is structurally identical to the consent gate's indefinite-blocking execute (ADR-0025). Blocking consumes no step budget (maxSteps counts loop iterations, not wall time). Sequential dispatch across steps works naturally (dispatch → inspect result → dispatch again).

Return value (also the persisted `tool_result` in the parent thread):

```
{ runId, status, finalMessage, usage: { input, output } }
status ∈ "completed" | "aborted" | "stopped" | "error" | "unconfigured"
```

Only the child's **final assistant message** returns — never the transcript (the transcript lives in the run's own conversation; the UI drills into it). `finalMessage` is **not mechanically truncated**; each subagent's system prompt enforces report discipline (artifacts go to the DB via tools; the final message is a brief). Aborted/stopped runs return whatever partial text exists plus the status; the Orchestrator decides whether to re-dispatch. The tool_result ages into an ADR-0031 stub like any tool pair; `context_read` re-expands it. The subagent block anchors on `runId` from the persisted tool result, with `meta.parentToolCallId` as the redundant back-link.

### 4. Abort semantics

- **Stopping the Orchestrator** cascades to all in-flight children via chained abort signals (the `ToolCallOptions.abortSignal` forwarding pattern `look_at` already uses). Every dispatch resolves `status: "aborted"` with partial text; ADR-0018's always-resolve guarantee holds for the composite.
- **Stopping a single subagent** (Stop button on the block or in the drill-in view) aborts only that child's run handle; siblings and the Orchestrator continue. The dispatch resolves `status: "stopped"`.
- **No wall-clock timeouts** — consistent with the consent gate's unbounded waits; provider stalls surface through `streamText`'s own error paths as `status: "error"`.
- Runs live in the renderer: window close kills them. Partial run transcripts are already persisted per-turn; the parent thread retains a dangling dispatch tool-call which the existing `filterIncompleteToolCalls` strips on the next derivation. Acceptable pre-release.

### 5. Consent: per-child surfacing and the writer override

Each run is its own conversation with its own approval gate, so **a subagent's approval requests surface in that run's own stream** — visible in the drill-in view, announced by the existing OS-native notification for non-visible conversations (zero new plumbing), and flagged on the parent's subagent block with a pending badge plus an **approve-all button** (the only cross-runtime surface added).

**Per-role consent override** in the registry: the writer's `update_scene` is `configurable` (governed by writer's own `autoExecuteDangerousTools` flag) instead of `always`. Without this, every scene write would halt the unattended batch pipeline for manual approval, contradicting the architecture's purpose. Safety nets: the workflow's human confirmation gates (outline sign-off before writing), critic verification afterward, and delete/reorder tools remaining `always` for every role.

### 6. Explicit-fail over silent-hide

Unconfigured subagents are **never hidden**: the dispatch enum always lists all eight; dispatching a role whose model is unbound resolves `status: "unconfigured"`, and the Orchestrator's prompt instructs it to report this to the user and proceed or abort sensibly. **`look_at` is amended the same way** (superseding ADR-0045's registration-time `visionConfig` gate): always registered, returning a structured `unconfigured` result when no vision model is bound. Silent disappearance of capabilities caused real confusion. Exception: `namer` (auto-titling) keeps its silent skip — it is a background amenity, not a workflow step the model initiates.

### 7. Configuration surface

Eleven AgentConfigs per Space (orchestrator + 8 subagents + namer + vision). **Per-config model binding stays** — heterogeneous models per specialty are the point of the redesign; no inheritance/default-model mechanism (it would obscure "which model is this?"). The settings UI gains a bulk "apply to all unconfigured" convenience. Users still cannot create or delete configs (the nine-role workflow topology is hardcoded); per-config system-prompt override and per-config skill enablement (ADR-0043 junction) extend to all new roles, Orchestrator included.

### 8. Budgets and tool assignment

`maxSteps` lives in the registry: Orchestrator 10 (talk + dispatch), writer/curator 15 (output-heavy / batch operations), others 10. `plan` is available to **every** role — a run self-organizing against its brief measurably helps accuracy, and plan persistence is per-conversation so runs are naturally isolated. `context_read` is Orchestrator-only (runs never produce stubs). Subagent "universal" tools converge to: get_current_time, format_time, plan, look_at (always registered), plus conditional skills/shell.

Historian is a **pure reader** (worldbook + novel/chapter/scene read tools + grep/timeline_lookup + get_chapter_overview; zero write tools) despite being staffed "on curator's base" in early planning — a synthesis role must not hold delete keys; corrections route back through the Orchestrator to curator.

### 9. Migration (pre-release, destructive)

No users ship yet, so: a world migration **deletes all existing conversations** (every one is explorer/writer-bound and would fail `constructAgent` under the new registry); messages/attachments/plans cascade away. The explorer/writer `agent_configs` rows are **kept and re-purposed** (the roles survive, demoted); seven new configs are seeded (orchestrator, curator, scribe, historian, editor, plotter, critic) using the fixed-UUID + far-future-timestamp seed precedent. The conversation-creation role picker is removed — all new user-facing conversations are Orchestrator-bound.

### 10. UI: the subagent block and drill-in

The subagent block is a specialized `dispatch_subagent` ToolCard renderer: role name, task digest, live status (running / awaiting-approval(N) / completed / stopped / error / aborted), a Stop button while running, the approve-all affordance when approvals pend, and click-to-drill. N parallel dispatches render as N blocks in tool-call order.

Drill-in switches the chat page to a ConversationView keyed by the run's conversation id — live streaming works through the existing per-runtime stream machinery (a run is just another runtime slot); historical blocks replay into the archived transcript via the persisted `runId`. The drill-in view has **no composer**: the user's only interventions in a run are stop and approve. Breadcrumb returns to the parent conversation.

## Consequences

**Positive:** per-role context diets (the original motivation); the unattended outline → parallel-write → critique pipeline becomes executable; every subagent's work is fully auditable and replayable; minimal new runtime machinery — dispatch reuses the consent-gate blocking precedent, runs reuse the conversation/session/stream stores, abort reuses signal chaining, usage reuses per-conversation accounting.

**Negative:** trivial questions cost a dispatch round-trip (deliberate purity, D1 — **amended**: they now answer from the Orchestrator's base read surface, at the price of ~19 extra read-tool definitions in its prompt); eleven models to bind per Space (mitigated by bulk-apply); the parent turn's token footer excludes child usage (child usage rides the dispatch result and the run's own messages; cross-run aggregation is future reporting); renderer-resident runs die on window close leaving dangling dispatch calls (stripped next derivation).

## References

- ADR-0017 (manual step loop — tools execute inside the SDK step pipeline), ADR-0018 (always-resolve, extended to the dispatch composite), ADR-0022/0023 (World-scoped, role-bound conversations — unchanged), ADR-0024 (runtime cache — runs slot in as conversations), ADR-0025 (blocking consent gate — the structural precedent for blocking dispatch), ADR-0028 (three-layer model — run transcripts as Persisted Threads), ADR-0031 (compaction interplay), ADR-0040/0045 (one-shot precedents; 0045's registration gate superseded by D6), ADR-0043 (per-config skills, extended to all roles).
- CONTEXT.md → Orchestrator, Subagent, Dispatch, Subagent Run; updated AgentConfig, Conversation, ConsentLevel, Context Compaction.
