/**
 * Conversation runtime store — the reactive core of the AI Chat feature.
 *
 * Bridges four concerns into one vanilla zustand store (ADR-0024):
 *
 * 1. **The pure Agent library** (`@/lib/ai`) — `Agent` holds the persisted
 *    thread; `AgentLoop` drives the model.
 * 2. **Persistence** (`@/lib/ai-store`) — `TauriSessionStore` routes message
 *    deltas to the conversation IPC commands.
 * 3. **Live model resolution** (ADR-0023) — a `ModelResolver` closure, fed by
 *    the Provider from Space-scoped `AgentConfig`, supplies the bound model at
 *    Agent construction time. The model is NOT persisted on the conversation,
 *    so reopening a conversation always picks up the current config.
 * 4. **Reactivity** — a two-level `Map<worldId, Map<conversationId, …>>` keeps
 *    every conversation's runtime alive simultaneously, so in-flight runs
 *    survive conversation switches, world switches, in-app navigation, and
 *    window hide-to-tray. Only destroying the Space window (the Provider
 *    unmounting) tears everything down.
 *
 * The store is constructed via the vanilla `createStore` factory (NOT the
 * `create` hook) so a single instance can be held in React context and tied to
 * the Provider's lifetime.
 *
 * Related: ADR-0017 (manual step loop), ADR-0018 (result never rejects),
 * ADR-0019 (library purity), ADR-0020 (session layer), ADR-0023 (live model),
 * ADR-0024 (in-flight run survival).
 */

import { createStore, type StoreApi } from "zustand";

import {
  Agent,
  AgentLoop,
  type AgentEvent,
  type AgentRunHandle,
  type CompactionPolicy,
  type LanguageModel,
  type LanguageModelUsage,
  type SessionMessage,
} from "@/lib/ai";
import { loadMessages as loadMessagesIpc } from "@/api/conversation";
import { createAgentEventLogger } from "@/lib/ai/agent-logging";
import { getRoleBehavior } from "@/lib/ai-roles";
import { TauriSessionStore } from "@/lib/ai-store";
import { logger } from "@/lib/logger";
import type { ApprovalGate, ConsentLevel, ToolContext } from "@/lib/tools/types";
import type { Conversation, ContextCompaction, Message, SpaceId, WorldId } from "@/types";

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Outcome of resolving a role's bound model. Three states so consumers
 * (notably `resolveAgent`) never confuse "still loading" with "genuinely
 * unconfigured" — collapsing both into a single `null` caused a transient
 * `MODEL_NOT_CONFIGURED` flash on chat-view mount, because the Space-scoped
 * AI config queries had not resolved yet.
 *
 * Built by the Provider from `useResolvedModelConfig`; read at Agent
 * construction time.
 */
export type ResolvedModel =
  | {
      readonly status: "ready";
      readonly model: LanguageModel;
      readonly autoExecuteDangerousTools: boolean;
      /** Per-role Context-mode compaction config (ADR-0031 Phase 1). */
      readonly contextCompaction: ContextCompaction;
      /**
       * Per-role system prompt override from the Space's AgentConfig.
       * Empty string = use the code-defined default (ai-roles/index.ts).
       * Non-empty = replace the role's system prompt.
       */
      readonly systemPrompt: string;
    }
  | { readonly status: "loading" }
  | { readonly status: "unconfigured" };

/**
 * Resolves the bound model for a role name (`"explorer"` / `"writer"`). Built
 * by the Provider from `useResolvedModelConfig`; passed into store actions.
 */
export type ModelResolver = (role: string) => ResolvedModel;

/** Routes a background persistence failure to the logger (ADR-0014). */
export type PersistErrorHandler = (error: unknown) => void;

/** Reactive view of a single in-flight tool call. */
export interface ToolCallView {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Accumulated `tool_input_delta` chunks (live args preview). */
  readonly inputDraft: string;
  /** Final parsed args from the `tool_call` event. */
  readonly input: unknown;
  readonly status: "running" | "done" | "error";
  /** From `tool_result`. */
  readonly output: unknown;
  /** From `tool_error`. */
  readonly error: { code: string; message: string } | null;
}

/** A pending tool-consent request awaiting user approval. */
export interface PendingApproval {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly consentLevel: ConsentLevel;
}

/**
 * Ordered chronological log of live-stream events. The block builder renders
 * segments IN ARRAY ORDER so a tool card called AFTER some text appears BELOW
 * that text — replacing the previous flat accumulator model (single `text`,
 * `reasoning`, `toolCalls`) that hardcoded the order as
 * `reasoning → ALL tools → text`.
 *
 * - `step` segments render one divider per `step_start` (one per loop step).
 * - `reasoning` / `text` segments coalesce consecutive deltas of the same
 *   `stepNumber`, so each step gets at most one reasoning block and one text
 *   block, but interleaving with tools is preserved (a tool between two text
 *   spans produces two text segments).
 * - `tool` segments are never coalesced (each `tool_call` is distinct). Their
 *   fields mirror {@link ToolCallView} so the segment is structurally
 *   assignable to it (no cast needed at the render layer).
 *
 * `text` / `toolName` / `inputDraft` / `input` / `status` / `output` / `error`
 * are intentionally mutable so delta handlers can replace them in place inside
 * a fresh array (see `handleEvent`).
 */
export type StreamSegment =
  | { readonly kind: "step"; readonly stepNumber: number }
  | { readonly kind: "reasoning"; readonly stepNumber: number; text: string }
  | { readonly kind: "text"; readonly stepNumber: number; text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      toolName: string;
      inputDraft: string;
      input: unknown;
      status: "running" | "done" | "error";
      output: unknown;
      error: { code: string; message: string } | null;
    };

/**
 * Live streaming state for the in-flight run. `null` when idle.
 *
 * Events arrive in true chronological order from the loop (`text_delta`,
 * `reasoning_delta`, `tool_call`, `tool_result`, …). They are appended to
 * {@link segments} so the block builder can render them in the EXACT order they
 * arrived — preserving interleaving like text → tool → more text.
 */
export interface StreamState {
  readonly runId: string;
  /**
   * Chronologically ordered log of stream events (step dividers, reasoning,
   * text, tool calls). Rendered in array order by `buildBlocks`.
   */
  readonly segments: readonly StreamSegment[];
  /**
   * Buffer for `tool_input_delta` chunks. The loop emits these WITHOUT a
   * `toolCallId` (the SDK part carries one but the runtime strips it — see
   * `loop/tool-input-delta` handling), so they cannot be keyed per call. They
   * always precede the matching `tool_call` event, so we accumulate here and
   * transfer into the tool segment's `inputDraft` when `tool_call` arrives.
   */
  readonly pendingInputDraft: string;
  /** Keyed by `toolCallId` — non-empty while the UI shows approve/deny buttons. */
  readonly pendingApprovals: Record<string, PendingApproval>;
}

/**
 * Per-message persisted token usage (ADR-0030). Surfaces `inputTokens` /
 * `outputTokens` for a single message row — both nullable to preserve the
 * "unknown" vs "real zero" distinction end to end (ADR-0030 §4). Only the
 * turn's last assistant message carries non-null values; the rest are
 * `null`/absent. Keyed by message id (NOT session/message index — message
 * ids are stable UUID v4).
 *
 * This type lives on `view.messageUsages` (a separate channel from
 * `view.messages`, which is `SessionMessage[]` — the pure library's
 * `SessionMessage` shape stays usage-free per ADR-0019).
 */
export interface MessageUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** The reactive slice the UI renders for one conversation. */
export interface ConversationView {
  /** Persisted thread (loaded on Agent open; refreshed after each run). */
  readonly messages: SessionMessage[];
  /**
   * Per-message token usage, keyed by message id (ADR-0030). Populated from
   * the `messages.usage_input_tokens` / `usage_output_tokens` columns on
   * Agent load and updated incrementally on each run's finalization. Only
   * the turn's last assistant row has non-null values; other rows are
   * absent from this map entirely (so "key not present" ⇒ "no usage for
   * this message" — never confuse with a real zero). UI consumers SHOULD
   * treat absence as "no data" and `null` as "provider reported unknown."
   */
  readonly messageUsages: Record<string, MessageUsage>;
  /**
   * Ephemeral token usage for the most recent turn (ADR-0030 §5/§6). Carries
   * the full {@link LanguageModelUsage} shape — including cache/reasoning
   * breakdowns that are NOT persisted but are useful for a live "this turn
   * hit X% cache" indicator. Reset to `undefined` at the start of each
   * `send` (cleared in the same patch that wipes `stream`) and re-set on
   * run finalization. `undefined` for a freshly loaded conversation until
   * the first message is sent.
   */
  readonly lastTurnUsage?: LanguageModelUsage;
  /**
   * Context-occupancy numerator (ADR-0030 §6): the LAST completed step's
   * `inputTokens` — i.e. the live context size right now. Distinct from
   * `lastTurnUsage.inputTokens`, which SUMS input across all steps of the
   * turn (cost view, ~N× this value on an N-step turn) and is the WRONG
   * number for occupancy. Sourced from `result.steps.at(-1)?.usage?.inputTokens`
   * on run finalization. `undefined` under the same conditions as
   * `lastTurnUsage` (fresh load, between turns, while streaming) and also
   * when the last step reported no usage.
   */
  readonly lastStepInputTokens?: number;
  /** Live streaming state; `null` when idle. */
  readonly stream: StreamState | null;
  readonly isRunning: boolean;
  readonly error: { code: string; message: string } | null;
  /**
   * Why the most recent run ended, when that ending should be surfaced to the
   * user. `"aborted"` is set the moment the `abort` event fires and again on
   * run finalization, so a "Stopped" marker survives below the (now persisted)
   * partial assistant message — not only in the ephemeral live-stream window.
   * Cleared on the next `send`.
   */
  readonly stopReason: "aborted" | null;
  /** Draft text — preserved across conversation switches (ADR-0024). */
  draft: string;
}

/**
 * Per-conversation runtime data. Held in the two-level Map so switching the
 * displayed conversation never tears down another's in-flight run.
 *
 * `agent` + `runHandle` are non-serializable object references — the immutability
 * helpers below copy them by reference (never clone), only producing new `view`
 * / flag references for reactivity.
 */
export interface ConversationRuntimeData {
  /** Cached so `send` can derive the role name + lazily (re)construct. */
  readonly conversation: Conversation;
  /** `null` until the runtime is ensured (lazy — constructed on first send/ensure). */
  agent: Agent | null;
  /** `true` while `Agent.open()` is in flight. */
  agentLoading: boolean;
  /** The current in-flight run handle (for abort). */
  runHandle: AgentRunHandle | null;
  /** Reactive VIEW — what the UI renders. */
  view: ConversationView;
}

/**
 * The full store state: the two-level runtime map plus the actions that mutate
 * it. Actions are called by the Provider/hooks (and internally), never React-internals.
 */
export interface ConversationRuntimeState {
  /** `worldId → conversationId → runtime data`. */
  readonly worlds: Map<string, Map<string, ConversationRuntimeData>>;

  ensureRuntime: (
    worldId: string,
    conversation: Conversation,
    modelResolver: ModelResolver,
    onPersistError: PersistErrorHandler,
  ) => Promise<void>;

  send: (
    worldId: string,
    conversationId: string,
    text: string,
    modelResolver: ModelResolver,
    onPersistError: PersistErrorHandler,
  ) => Promise<void>;

  abort: (worldId: string, conversationId: string) => void;
  setDraft: (worldId: string, conversationId: string, text: string) => void;
  removeConversation: (worldId: string, conversationId: string) => void;
  clearError: (worldId: string, conversationId: string) => void;
  resolveApproval: (worldId: string, conversationId: string, toolCallId: string, approved: boolean) => void;
}

// ─── Helpers (pure, operate on state) ─────────────────────────────────────

/** Stable empty view for conversations not yet in the map (selector fallback). */
export const EMPTY_VIEW: ConversationView = {
  messages: [],
  messageUsages: {},
  // lastTurnUsage intentionally omitted — `undefined` until first turn.
  stream: null,
  isRunning: false,
  error: null,
  stopReason: null,
  draft: "",
};

/**
 * Build a `messageUsages` map from a fresh {@link Message} IPC payload.
 *
 * Only rows where BOTH usage columns are NULL are skipped — every row that
 * carries at least one of `usageInputTokens` / `usageOutputTokens` lands in
 * the map (so a partial provider report that omits one half still surfaces
 * the half it reported). `null` is preserved verbatim (the UI distinguishes
 * "provider reported unknown" from "no data"); an absent key means "no
 * usage for this message" (never confuse with a real `0`).
 *
 * Per ADR-0030 §2, only the turn's last assistant message should carry
 * non-null values — but this helper is defensive: it does not enforce that
 * invariant, it merely reports whatever the columns hold.
 */
function buildMessageUsages(
  messages: readonly Message[],
): Record<string, MessageUsage> {
  const map: Record<string, MessageUsage> = {};
  for (const m of messages) {
    const input = m.usageInputTokens ?? null;
    const output = m.usageOutputTokens ?? null;
    // Skip rows where the DB wrote NULL on both — they are the majority
    // (every user / tool / non-last-assistant message). Keeping them out
    // shrinks the map and gives UI consumers a clean "key present ⇒ data"
    // signal.
    if (input === null && output === null) continue;
    map[m.id] = { inputTokens: input, outputTokens: output };
  }
  return map;
}

/**
 * Find the id of the LAST `role === "assistant"` message in a list, or
 * `null` if there is none. Used by run finalization to attach per-turn
 * usage to the correct message id (ADR-0030 §2).
 */
function lastAssistantMessageId(
  messages: readonly SessionMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].id;
  }
  return null;
}

function getData(
  state: ConversationRuntimeState,
  worldId: string,
  conversationId: string,
): ConversationRuntimeData | undefined {
  return state.worlds.get(worldId)?.get(conversationId);
}

/**
 * Ensure the (worldId, conversationId) slot exists, caching the conversation.
 * Returns a fresh `worlds` Map (new outer + inner references) so zustand sees
 * the change; returns the existing map unchanged if the slot already exists.
 */
function ensureSlot(
  state: ConversationRuntimeState,
  worldId: string,
  conversation: Conversation,
): Map<string, Map<string, ConversationRuntimeData>> {
  const conversationId = conversation.id;
  const existing = state.worlds.get(worldId)?.get(conversationId);
  if (existing) return state.worlds;

  const data: ConversationRuntimeData = {
    conversation,
    agent: null,
    agentLoading: false,
    runHandle: null,
    view: { ...EMPTY_VIEW },
  };
  const worldMap = new Map(state.worlds.get(worldId) ?? []);
  worldMap.set(conversationId, data);
  const worlds = new Map(state.worlds);
  worlds.set(worldId, worldMap);
  return worlds;
}

/**
 * Immutably update one conversation's data. Returns a fresh `worlds` Map, or
 * `undefined` when the slot doesn't exist (caller falls back to the prior map).
 * `agent` + `runHandle` flow through the updater by reference — never cloned.
 */
function updateConversation(
  state: ConversationRuntimeState,
  worldId: string,
  conversationId: string,
  updater: (data: ConversationRuntimeData) => ConversationRuntimeData,
): Map<string, Map<string, ConversationRuntimeData>> | undefined {
  const worldMap = state.worlds.get(worldId);
  if (!worldMap) return undefined;
  const data = worldMap.get(conversationId);
  if (!data) return undefined;
  const newWorldMap = new Map(worldMap);
  newWorldMap.set(conversationId, updater(data));
  const newWorlds = new Map(state.worlds);
  newWorlds.set(worldId, newWorldMap);
  return newWorlds;
}

/**
 * Coalesce a `text_delta` / `reasoning_delta` chunk into the segment log.
 *
 * If the LAST segment is the same kind with the SAME `stepNumber`, append the
 * delta to its `text`; otherwise push a fresh segment. Consecutive same-kind
 * deltas within one step thus become a single block, but a tool interleaved
 * between two text spans splits them into two segments — preserving the true
 * arrival order.
 *
 * **In-place mutation**: per the `StreamSegment` type's documented mutability
 * (store.ts ~line 126-128: *"intentionally mutable so delta handlers can
 * replace them in place inside a fresh array"*), the last segment's `text` is
 * mutated directly rather than allocating `{ ...last, text: ... }` per delta.
 * This avoids one small-object spread per streaming chunk (thousands per
 * autonomous run). The fresh top-level array (`[...segments]`) is still
 * returned so zustand sees a new reference and re-renders. The superseded
 * state's segment object is technically mutated too, but it is immediately
 * superseded and never read again — harmless under the single-reader zustand
 * model.
 *
 * NOTE: string concatenation (`last.text += delta`) is inherent to JS (strings
 * are immutable) and still allocates. The O(N²) string garbage is the
 * remaining cost; eliminating it requires chunk-array batching (future work).
 */
function appendDelta(
  segments: readonly StreamSegment[],
  kind: "text" | "reasoning",
  stepNumber: number,
  delta: string,
): readonly StreamSegment[] {
  const next = [...segments];
  const last = next[next.length - 1];
  if (last && last.kind === kind && last.stepNumber === stepNumber) {
    // Mutate in place — `text` is intentionally mutable on the type (see
    // store.ts StreamSegment docstring). Avoids `{ ...last, text: ... }`.
    last.text += delta;
  } else {
    next.push({ kind, stepNumber, text: delta });
  }
  return next;
}

/**
 * Patch a tool segment (matched by `toolCallId`) with new fields, returning a
 * NEW array. Used for `tool_result` (status/output) and `tool_error`
 * (status/error). No-op if the id is not present (defensive — the matching
 * `tool_call` should always precede these events).
 */
function patchToolSegment(
  segments: readonly StreamSegment[],
  toolCallId: string,
  patch: Partial<Pick<ToolCallView, "toolName" | "status" | "output" | "error">>,
): readonly StreamSegment[] {
  const idx = segments.findIndex(
    (s) => s.kind === "tool" && s.toolCallId === toolCallId,
  );
  if (idx === -1) return segments;
  const seg = segments[idx];
  if (seg.kind !== "tool") return segments; // unreachable given findIndex above
  const next = [...segments];
  next[idx] = { ...seg, ...patch };
  return next;
}

/**
 * Construct a stateful {@link Agent} for a conversation. Resolves the role
 * behavior, builds a `TauriSessionStore` + `AgentLoop`, and loads history via
 * the async `Agent.open` factory. Throws if the role is unknown or the store
 * rejects — callers handle errors and surface them into `view.error`.
 */
async function constructAgent(
  conversation: Conversation,
  model: LanguageModel,
  spaceId: SpaceId,
  worldId: string,
  onPersistError: PersistErrorHandler,
  approvalGate: ApprovalGate,
  autoExecuteDangerousTools: boolean,
  contextCompaction: ContextCompaction,
  systemPromptOverride: string,
): Promise<Agent> {
  const roleBehavior = getRoleBehavior(conversation.agentConfigName);
  if (!roleBehavior) {
    throw new Error(
      `constructAgent: unknown agent config "${conversation.agentConfigName}" — no RoleBehavior registered.`,
    );
  }

  // agentRef chicken-and-egg (ADR-0029 Negative): tools need ctx → ctx closes
  // over planAccess → planAccess reaches into the Agent → the Agent needs
  // tools (via the loop). The agentRef is initially `null` and is back-filled
  // after `Agent.open()` returns. Tool execute closures read `agentRef.current`
  // at EXECUTION time (not construction time), and the AgentLoop runs only
  // after `Agent.open()` has fully resolved — so by the time any tool can
  // execute, `agentRef.current` is guaranteed to be the live Agent.
  //
  // The ref is a local `const` (lexically scoped to constructAgent), NOT a
  // module-level mutable — one independent ref per Agent. Once back-filled, it
  // stays non-null for the Agent's lifetime.
  const agentRef: { current: Agent | null } = { current: null };

  const ctx: ToolContext = {
    spaceId,
    worldId: worldId as WorldId,
    approvalGate,
    autoExecuteDangerousTools,
    planAccess: {
      // `get` reads the live `Agent.plan`. Used by the `plan` tool only to
      // compute output counts at execute time — the Plan reminder that
      // actually enters the model's input is snapshotted separately at
      // `Agent.run()` entry via the pipeline's plan-injector (ADR-0028
      // invariant 2). Returns `null` defensively if somehow observed before
      // back-fill (should never happen in practice — see header comment).
      get: () => agentRef.current?.getPlan() ?? null,
      // `set` delegates to `Agent.setPlan`, which updates the in-memory value
      // synchronously and fire-and-forget persists via the SessionStore. The
      // synchronous throw guards against the (also-should-never-happen) case
      // of a tool executing before Agent construction completes — per
      // ADR-0029: "agentRef.current is null only between ctx construction and
      // Agent.open() resolution; tools execute only after Agent construction".
      set: (plan) => {
        if (!agentRef.current) {
          throw new Error(
            "planAccess.set called before Agent construction completed — agentRef not back-filled (ADR-0029).",
          );
        }
        return agentRef.current.setPlan(plan);
      },
    },
    // `threadLookup` is the reverse channel for Context-mode stub compaction
    // (ADR-0031 §5). Used by the `context_read` tool to expand a compacted
    // `[tool_call {id}] …` stub back to its original input + output. Unlike
    // `planAccess`, this is READ-ONLY — no `set` — so there is no null-guard
    // throw; an unresolved agentRef simply yields `undefined` (which the tool
    // converts to a structured `not_found` result). In practice, tools never
    // execute before Agent.open() resolves (same lifecycle guarantee as
    // planAccess — see the header comment above).
    threadLookup: {
      findToolPair: (toolCallId) => agentRef.current?.findToolPair(toolCallId),
    },
  };

  const tools = roleBehavior.buildTools(ctx);
  // Apply the DB-stored system prompt override. Empty string = use the code
  // default from ROLE_BEHAVIOR. This lets users customize per-role prompts
  // from the Space config page without code changes.
  const effectiveSystemPrompt =
    systemPromptOverride.trim() || roleBehavior.systemPrompt;
  const loop = new AgentLoop({
    model,
    systemPrompt: effectiveSystemPrompt,
    tools,
    maxSteps: roleBehavior.maxSteps,
    ...(roleBehavior.temperature !== undefined
      ? { temperature: roleBehavior.temperature }
      : {}),
  });
  const store = new TauriSessionStore({ spaceId, worldId, conversation });
  // Convert the persisted per-role config (ADR-0012) into the library-side
  // policy. The library stays free of the `ContextCompaction` app type
  // (ADR-0019 purity); the conversion happens here at the app boundary.
  const compactionPolicy: CompactionPolicy = {
    enabled: contextCompaction.enabled,
    turnAge: contextCompaction.turnAge,
  };
  const agent = await Agent.open({
    loop,
    store,
    sessionId: conversation.id,
    roleStaticPrompt: effectiveSystemPrompt,
    onPersistError,
    compactionPolicy,
  });
  // Back-fill — tools can now reach the live Agent via planAccess. This is the
  // single assignment to agentRef.current; it stays non-null for the Agent's
  // lifetime. Tools cannot execute before this point (AgentLoop runs only
  // after Agent.open() resolves).
  agentRef.current = agent;
  return agent;
}

// ─── Store factory ────────────────────────────────────────────────────────

/**
 * Create the conversation runtime store. `spaceId` is captured in the closure
 * (one Provider per Space window — ADR-0011/0024); `worldId` is per-action
 * since a Space holds many Worlds.
 */
export function createConversationRuntimeStore(
  spaceId: SpaceId,
): StoreApi<ConversationRuntimeState> {
  return createStore<ConversationRuntimeState>((set, get) => {
    /** Patch one conversation's data, no-oping if the slot is gone. */
    const patchData = (
      worldId: string,
      conversationId: string,
      updater: (data: ConversationRuntimeData) => ConversationRuntimeData,
    ): void => {
      set((state) => ({
        worlds: updateConversation(state, worldId, conversationId, updater) ?? state.worlds,
      }));
    };

    // ── Approval gate infrastructure ──────────────────────────────
    // Per-store map of pending approval resolvers, keyed by toolCallId.
    // The gate sets a Promise resolver here; resolveApproval consumes it.
    const approvalResolvers = new Map<string, (approved: boolean) => void>();

    /**
     * Create an ApprovalGate bound to a specific (worldId, conversationId).
     * The gate patches `stream.pendingApprovals` when a request arrives, and
     * auto-denies (resolves false) if the run's abort signal fires.
     */
    function createGate(worldId: string, conversationId: string): ApprovalGate {
      return {
        request: (req) =>
          new Promise<boolean>((resolve) => {
            // Auto-deny if already aborted.
            if (req.abortSignal.aborted) {
              resolve(false);
              return;
            }
            approvalResolvers.set(req.toolCallId, resolve);

            // Auto-deny on abort — unblocks the execute so the run can end.
            req.abortSignal.addEventListener(
              "abort",
              () => {
                const r = approvalResolvers.get(req.toolCallId);
                if (r) {
                  approvalResolvers.delete(req.toolCallId);
                  r(false);
                }
                patchData(worldId, conversationId, (d) => {
                  if (!d.view.stream) return d;
                  const rest = { ...d.view.stream.pendingApprovals };
                  delete rest[req.toolCallId];
                  return {
                    ...d,
                    view: {
                      ...d.view,
                      stream: { ...d.view.stream, pendingApprovals: rest },
                    },
                  };
                });
              },
              { once: true },
            );

            // Surface the pending approval to the UI.
            patchData(worldId, conversationId, (d) => {
              if (!d.view.stream) return d;
              return {
                ...d,
                view: {
                  ...d.view,
                  stream: {
                    ...d.view.stream,
                    pendingApprovals: {
                      ...d.view.stream.pendingApprovals,
                      [req.toolCallId]: {
                        toolCallId: req.toolCallId,
                        toolName: req.toolName,
                        input: req.input,
                        consentLevel: req.consentLevel,
                      },
                    },
                  },
                },
              };
            });
          }),
      };
    }

    /**
     * Resolve a usable Agent for a conversation: return the cached one, or
     * construct it lazily (persisting the new instance into the slot). Returns
     * `null` + sets the appropriate `view.error` when construction is impossible
     * (model unconfigured, role unknown, store failure).
     */
    const resolveAgent = async (
      data: ConversationRuntimeData,
      modelResolver: ModelResolver,
      onPersistError: PersistErrorHandler,
      worldId: string,
      conversationId: string,
    ): Promise<Agent | null> => {
      if (data.agent) return data.agent;

      const resolved = modelResolver(data.conversation.agentConfigName);
      // "loading": the Space-scoped AI config queries (agent configs, provider
      // credentials, models.dev catalog) haven't resolved yet, so whether the
      // role is configured is UNKNOWN. Bail WITHOUT mutating state — the
      // Provider recreates `modelResolver` once config lands (its `isLoading`
      // flags are in the builder's useMemo deps), which re-fires
      // `useEnsureRuntime`'s effect and retries `resolveAgent`.
      if (resolved.status === "loading") return null;
      if (resolved.status === "unconfigured") {
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: {
            ...d.view,
            error: {
              code: "MODEL_NOT_CONFIGURED",
              message: "No model is configured for this role.",
            },
          },
        }));
        return null;
      }

      const { model, autoExecuteDangerousTools, contextCompaction, systemPrompt } = resolved;
      const gate = createGate(worldId, conversationId);
      patchData(worldId, conversationId, (d) => ({ ...d, agentLoading: true }));
      try {
        const agent = await constructAgent(
          data.conversation,
          model,
          spaceId,
          worldId,
          onPersistError,
          gate,
          autoExecuteDangerousTools,
          contextCompaction,
          systemPrompt,
        );
        // ADR-0030 read path — pull the persisted Message rows (with usage
        // columns) STRAIGHT from the IPC, bypassing TauriSessionStore
        // (which strips usage to keep SessionMessage pure-library — ADR-
        // 0019). The two load paths are not redundant: SessionMessage[]
        // feeds the Agent's in-memory thread (pure-lib contract), the
        // usage columns feed `view.messageUsages` (app-layer UI surface).
        const persistedMessages = await loadMessagesIpc(
          spaceId,
          worldId as WorldId,
          data.conversation.id,
        ).catch((e: unknown) => {
          // Defensive: usage is best-effort UI metadata; a failure here
          // MUST NOT block the runtime (the Agent already loaded its
          // thread successfully). Log + fall back to an empty map.
          logger.warn("conversation.usage.load_failed", {
            conversation_id: data.conversation.id,
            world_id: worldId,
            error: e instanceof Error ? e.message : String(e),
          });
          return [] as Message[];
        });
        patchData(worldId, conversationId, (d) => ({
          ...d,
          agent,
          agentLoading: false,
          view: {
            ...d.view,
            messages: [...agent.getMessages()],
            messageUsages: buildMessageUsages(persistedMessages),
            error: null,
          },
        }));
        return agent;
      } catch (e) {
        patchData(worldId, conversationId, (d) => ({
          ...d,
          agentLoading: false,
          view: {
            ...d.view,
            error: {
              code: "RUNTIME_INIT_FAILED",
              message: e instanceof Error ? e.message : String(e),
            },
          },
        }));
        return null;
      }
    };

    return {
      worlds: new Map(),

      // ── ensureRuntime ──
      ensureRuntime: async (worldId, conversation, modelResolver, onPersistError) => {
        const conversationId = conversation.id;
        // Cache the conversation into a slot (idempotent).
        set((state) => ({ worlds: ensureSlot(state, worldId, conversation) }));

        const current = getData(get(), worldId, conversationId);
        // Already loaded or currently loading — nothing to do.
        if (current?.agent || current?.agentLoading) return;
        if (!current) return; // defensive — ensureSlot just made it.

        await resolveAgent(current, modelResolver, onPersistError, worldId, conversationId);
      },

      // ── send ──
      send: async (worldId, conversationId, text, modelResolver, onPersistError) => {
        const data = getData(get(), worldId, conversationId);
        if (!data) {
          // ensureRuntime was never called for this conversation.
          logger.warn("conversation.send.no_runtime", {
            conversation_id: conversationId,
            world_id: worldId,
          });
          return;
        }

        const agent = await resolveAgent(
          data,
          modelResolver,
          onPersistError,
          worldId,
          conversationId,
        );
        if (!agent) return; // resolveAgent set view.error.

        // Clear error + flip to running. Stream is set after we have the runId.
        // `lastTurnUsage` is reset here so the previous turn's value does not
        // linger while the new run is in-flight (ADR-0030 — it gets re-set on
        // finalization).
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: {
            ...d.view,
            error: null,
            isRunning: true,
            stream: null,
            stopReason: null,
            lastTurnUsage: undefined,
            lastStepInputTokens: undefined,
          },
        }));

        let handle: AgentRunHandle;
        try {
          handle = agent.run(text);
        } catch (e) {
          // ConfigError (already running) or other synchronous failure.
          patchData(worldId, conversationId, (d) => ({
            ...d,
            view: {
              ...d.view,
              isRunning: false,
              error: {
                code: "RUN_FAILED",
                message: e instanceof Error ? e.message : String(e),
              },
            },
          }));
          return;
        }

        const roleName = data.conversation.agentConfigName;

        // Record the handle + initialize the live stream view.
        patchData(worldId, conversationId, (d) => ({
          ...d,
          runHandle: handle,
          view: {
            ...d.view,
            stream: {
              runId: handle.runId,
              segments: [],
              pendingInputDraft: "",
              pendingApprovals: {},
            },
          },
        }));

        // ── Streaming batch buffer ──────────────────────────────────────
        // High-frequency deltas (text / reasoning / tool-input) are buffered
        // here as chunk arrays and flushed ONCE per animation frame via a
        // single patchData call. This collapses O(tokens) per-delta string
        // concatenations + zustand state-tree rebuilds + React re-renders
        // into O(frames) batch flushes — the core memory/CPU fix for
        // autonomous multi-step runs where thousands of deltas stream across
        // many steps (reasoning models especially).
        //
        // **Chunk arrays, not incremental concat**: each delta is pushed as
        // an array element (O(1)). The array is `.join("")`-ed once per flush,
        // producing a SINGLE string allocation per frame instead of the O(N²)
        // allocation of per-delta `text += delta`.
        //
        // **Structural events flush immediately**: step_start, tool_call,
        // tool_result, tool_error, error, and abort each call flushBatch()
        // BEFORE their own patchData. This guarantees segment ordering (a
        // tool card appears AFTER all preceding text) and completeness.
        //
        // **Safety valve**: if the batch exceeds FLUSH_THRESHOLD chunks (rAF
        // throttled by a hidden window — ADR-0024 in-flight survival), a
        // timer-based flush fires to prevent unbounded growth.
        const FLUSH_THRESHOLD = 500;
        const batch = {
          text: { stepNumber: -1, chunks: [] as string[] },
          reasoning: { stepNumber: -1, chunks: [] as string[] },
          inputDraftChunks: [] as string[],
          rafId: null as number | null,
          timeoutId: null as number | null,
        };

        /**
         * Flush all pending batch buffers into a single patchData call.
         * Cancels any pending rAF and safety-valve timer. Resets the batch
         * arrays. No-op when all buffers are empty. Idempotent (safe to call
         * from structural events, finalization, rAF callback, and the safety
         * valve re-entrantly).
         */
        const flushBatch = (): void => {
          if (batch.rafId !== null) {
            cancelAnimationFrame(batch.rafId);
            batch.rafId = null;
          }
          if (batch.timeoutId !== null) {
            clearTimeout(batch.timeoutId);
            batch.timeoutId = null;
          }
          // Snapshot + reset BEFORE patchData — avoids re-entrancy issues if
          // a subscriber somehow triggers another flush.
          const tChunks = batch.text.chunks;
          const tStep = batch.text.stepNumber;
          const rChunks = batch.reasoning.chunks;
          const rStep = batch.reasoning.stepNumber;
          const iChunks = batch.inputDraftChunks;
          batch.text.chunks = [];
          batch.reasoning.chunks = [];
          batch.inputDraftChunks = [];

          if (
            tChunks.length === 0 &&
            rChunks.length === 0 &&
            iChunks.length === 0
          ) {
            return;
          }

          const tBatch = tChunks.length > 0 ? tChunks.join("") : null;
          const rBatch = rChunks.length > 0 ? rChunks.join("") : null;
          const iBatch = iChunks.length > 0 ? iChunks.join("") : null;

          patchData(worldId, conversationId, (d) => {
            if (!d.view.stream) return d;
            let segments = d.view.stream.segments;
            if (tBatch !== null) {
              segments = appendDelta(segments, "text", tStep, tBatch);
            }
            if (rBatch !== null) {
              segments = appendDelta(segments, "reasoning", rStep, rBatch);
            }
            return {
              ...d,
              view: {
                ...d.view,
                stream: {
                  ...d.view.stream,
                  segments,
                  pendingInputDraft:
                    iBatch !== null
                      ? d.view.stream.pendingInputDraft + iBatch
                      : d.view.stream.pendingInputDraft,
                },
              },
            };
          });
        };

        /**
         * Schedule a rAF flush if not already pending. Safety valve: if the
         * batch exceeds FLUSH_THRESHOLD chunks, flush via setTimeout(0)
         * instead (works when rAF is throttled by a hidden window).
         */
        const scheduleFlush = (): void => {
          const total =
            batch.text.chunks.length +
            batch.reasoning.chunks.length +
            batch.inputDraftChunks.length;
          if (total >= FLUSH_THRESHOLD) {
            if (batch.rafId !== null) {
              cancelAnimationFrame(batch.rafId);
              batch.rafId = null;
            }
            // Only schedule one timer at a time — prevents pile-up when the
            // buffer stays above threshold under sustained fast streaming.
            if (batch.timeoutId === null) {
              batch.timeoutId = setTimeout(flushBatch, 0);
            }
            return;
          }
          if (batch.rafId === null) {
            batch.rafId = requestAnimationFrame(flushBatch);
          }
        };

        // ── Event handler — mutates view.stream per AgentEvent ──
        // Registered synchronously after run(); the loop starts on the next
        // microtask, so this listener is attached before `run_start` fires.
        const handleEvent = (event: AgentEvent): void => {
          switch (event.type) {
            case "run_start":
              // Stream already initialized in send(); nothing to add.
              return;

            case "run_end":
              // The result.then() below owns message refresh + stream clear.
              return;

            case "step_start":
              flushBatch();
              // One divider per step — `step_start` fires once per loop step.
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      segments: [
                        ...d.view.stream.segments,
                        { kind: "step", stepNumber: event.stepNumber },
                      ],
                    },
                  },
                };
              });
              return;

            case "step_end":
              // Usage/latency logged by createAgentEventLogger; no view change.
              return;

            case "text_delta":
              // Flush pending reasoning to preserve arrival order (reasoning
              // → text interleaving within a step is uncommon but possible).
              if (batch.reasoning.chunks.length > 0) {
                flushBatch();
              }
              // Step boundary → flush previous step's batch so segments stay
              // in arrival order, then start accumulating for the new step.
              if (batch.text.stepNumber !== event.stepNumber) {
                flushBatch();
                batch.text.stepNumber = event.stepNumber;
              }
              batch.text.chunks.push(event.delta);
              scheduleFlush();
              return;

            case "reasoning_delta":
              // Flush pending text to preserve arrival order.
              if (batch.text.chunks.length > 0) {
                flushBatch();
              }
              if (batch.reasoning.stepNumber !== event.stepNumber) {
                flushBatch();
                batch.reasoning.stepNumber = event.stepNumber;
              }
              batch.reasoning.chunks.push(event.delta);
              scheduleFlush();
              return;

            case "tool_input_delta":
              // The event carries no toolCallId (the loop strips it); buffer
              // into the pending draft and transfer on the next tool_call.
              // tool_call flushes the batch first, so the full accumulated
              // draft is available when the tool segment is created.
              batch.inputDraftChunks.push(event.delta);
              scheduleFlush();
              return;

            case "tool_call":
              flushBatch();
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                const inputDraft = d.view.stream.pendingInputDraft;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      // Hand the buffered draft to this call, then reset.
                      pendingInputDraft: "",
                      segments: [
                        ...d.view.stream.segments,
                        {
                          kind: "tool",
                          toolCallId: event.toolCallId,
                          toolName: event.toolName,
                          inputDraft,
                          input: event.input,
                          status: "running",
                          output: undefined,
                          error: null,
                        },
                      ],
                    },
                  },
                };
              });
              return;

            case "tool_result":
              flushBatch();
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      segments: patchToolSegment(
                        d.view.stream.segments,
                        event.toolCallId,
                        { toolName: event.toolName, status: "done", output: event.output },
                      ),
                    },
                  },
                };
              });
              return;

            case "tool_error":
              flushBatch();
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      segments: patchToolSegment(
                        d.view.stream.segments,
                        event.toolCallId,
                        {
                          toolName: event.toolName,
                          status: "error",
                          error: { code: event.error.code, message: event.error.message },
                        },
                      ),
                    },
                  },
                };
              });
              return;

            case "error":
              flushBatch();
              // Stream-terminating error: surface immediately. The run will
              // resolve shortly and the result.then() does final cleanup
              // (stream clear + message refresh); view.error survives the
              // spread there.
              patchData(worldId, conversationId, (d) => ({
                ...d,
                view: {
                  ...d.view,
                  isRunning: false,
                  error: { code: event.error.code, message: event.error.message },
                },
              }));
              return;

            case "abort":
              flushBatch();
              // Immediate "stopped" feedback; result.then() finalizes.
              // Also clear any pending approvals — the gate's abort listener
              // should have already resolved them, but this is defensive.
              // stopReason is set here so the "Stopped" marker shows instantly
              // (even before finalization refreshes view.messages), and is
              // re-asserted by the finalization .then() so it survives the
              // stream → null transition.
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) {
                  return {
                    ...d,
                    view: { ...d.view, isRunning: false, stopReason: "aborted" },
                  };
                }
                return {
                  ...d,
                  view: {
                    ...d.view,
                    isRunning: false,
                    stopReason: "aborted",
                    stream: { ...d.view.stream, pendingApprovals: {} },
                  },
                };
              });
              return;

            default: {
              // Exhaustiveness guard — a new AgentEvent variant forces a
              // handling decision here (matches createAgentEventLogger).
              const _exhaustive: never = event;
              void _exhaustive;
              return;
            }
          }
        };

        // Capture both unsubscribe functions. The per-run emitter owns its
        // subscriber set, and while `runHandle: null` (set in finalization
        // below) SHOULD release the handle + emitter, V8/WebView2 is
        // conservative about GC-ing Promise chains — the discarded closures
        // (`handleEvent` captures `patchData` → zustand `set`/`get`) can stay
        // pinned longer than expected after a run. Calling both unsubscribes
        // deterministically in EVERY termination path (ADR-0018 — all runs
        // resolve, never reject) is the robust fix. Idempotent (events.ts).
        const unsubView = handle.subscribe(handleEvent);
        const unsubLogger = handle.subscribe(createAgentEventLogger(roleName));
        const detachRunListeners = (): void => {
          unsubView();
          unsubLogger();
        };

        // ── Run finalization ──
        // The Agent registers its OWN handle.result.then() inside run() (it
        // persists the delta + updates agent.messages). Our .then() runs AFTER
        // it (promise callbacks fire in registration order), so
        // agent.getMessages() here already reflects the appended response.
        // The result NEVER rejects (ADR-0018); the .catch is defensive.
        void handle.result
          .then((result) => {
            flushBatch();
            detachRunListeners();
            // ADR-0030 — surface per-turn usage two ways:
            //   1. `lastTurnUsage` = the full LanguageModelUsage (with
            //      cache/reasoning breakdowns) for ephemeral live display.
            //   2. `messageUsages[lastAssistantId]` = the persisted
            //      input/output pair, attached to the turn's last assistant
            //      message id. `undefined → null` per §4. Existing entries
            //      for earlier messages are preserved (incremental update).
            patchData(worldId, conversationId, (d) => {
              const updatedMessages = [...agent.getMessages()];
              const lastAssistantId = lastAssistantMessageId(updatedMessages);
              const nextMessageUsages: Record<string, MessageUsage> = {
                ...d.view.messageUsages,
              };
              if (lastAssistantId !== null) {
                nextMessageUsages[lastAssistantId] = {
                  inputTokens: result.totalUsage.inputTokens ?? null,
                  outputTokens: result.totalUsage.outputTokens ?? null,
                };
              }
              return {
                ...d,
                runHandle: null,
                view: {
                  ...d.view,
                  messages: updatedMessages,
                  messageUsages: nextMessageUsages,
                  lastTurnUsage: result.totalUsage,
                  lastStepInputTokens:
                    result.steps[result.steps.length - 1]?.usage?.inputTokens,
                  isRunning: false,
                  stream: null,
                  stopReason: result.finishReason === "aborted" ? "aborted" : null,
                },
              };
            });
          })
          .catch((e) => {
            flushBatch();
            detachRunListeners();
            patchData(worldId, conversationId, (d) => ({
              ...d,
              runHandle: null,
              view: {
                ...d.view,
                isRunning: false,
                stream: null,
                error: {
                  code: "RUN_FAILED",
                  message: e instanceof Error ? e.message : String(e),
                },
              },
            }));
          });
      },

      // ── abort ──
      abort: (worldId, conversationId) => {
        // Idempotent — AgentRunHandle.abort no-ops if already settled.
        getData(get(), worldId, conversationId)?.runHandle?.abort();
      },

      // ── setDraft ──
      setDraft: (worldId, conversationId, text) => {
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: { ...d.view, draft: text },
        }));
      },

      // ── removeConversation ──
      removeConversation: (worldId, conversationId) => {
        // Abort any in-flight run BEFORE dropping the slot, so the pending
        // result.then() finds no data and no-ops.
        getData(get(), worldId, conversationId)?.runHandle?.abort();
        set((state) => {
          const worldMap = state.worlds.get(worldId);
          if (!worldMap) return {};
          const newWorldMap = new Map(worldMap);
          newWorldMap.delete(conversationId);
          const newWorlds = new Map(state.worlds);
          if (newWorldMap.size === 0) {
            // Drop empty world buckets to keep the map tidy.
            newWorlds.delete(worldId);
          } else {
            newWorlds.set(worldId, newWorldMap);
          }
          return { worlds: newWorlds };
        });
      },

      // ── clearError ──
      clearError: (worldId, conversationId) => {
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: { ...d.view, error: null },
        }));
      },

      // ── resolveApproval ──
      resolveApproval: (worldId, conversationId, toolCallId, approved) => {
        const resolver = approvalResolvers.get(toolCallId);
        if (!resolver) return;
        approvalResolvers.delete(toolCallId);
        patchData(worldId, conversationId, (d) => {
          if (!d.view.stream) return d;
          const rest = { ...d.view.stream.pendingApprovals };
          delete rest[toolCallId];
          return {
            ...d,
            view: {
              ...d.view,
              stream: { ...d.view.stream, pendingApprovals: rest },
            },
          };
        });
        resolver(approved);
      },
    };
  });
}
