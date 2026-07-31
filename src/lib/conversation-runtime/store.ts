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
  type LanguageModel,
  type SessionMessage,
} from "@/lib/ai";
import { createAgentEventLogger } from "@/lib/ai/agent-logging";
import { getRoleBehavior } from "@/lib/ai-roles";
import { TauriSessionStore } from "@/lib/ai-store";
import { logger } from "@/lib/logger";
import type { ApprovalGate, ConsentLevel, ToolContext } from "@/lib/tools/types";
import type { Conversation, SpaceId, WorldId } from "@/types";

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
  | { readonly status: "ready"; readonly model: LanguageModel; readonly autoExecuteDangerousTools: boolean }
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

/** Live streaming state for the in-flight run. `null` when idle. */
export interface StreamState {
  readonly runId: string;
  /** Accumulated `text_delta`. */
  readonly text: string;
  /** Accumulated `reasoning_delta`. */
  readonly reasoning: string;
  /** From `step_start` (zero-based). */
  readonly currentStep: number;
  /**
   * Buffer for `tool_input_delta` chunks. The loop emits these WITHOUT a
   * `toolCallId` (the SDK part carries one but the runtime strips it — see
   * `loop/tool-input-delta` handling), so they cannot be keyed per call. They
   * always precede the matching `tool_call` event, so we accumulate here and
   * transfer into the tool card's `inputDraft` when `tool_call` arrives.
   */
  readonly pendingInputDraft: string;
  /** Keyed by `toolCallId`. */
  readonly toolCalls: Record<string, ToolCallView>;
  /** Keyed by `toolCallId` — non-empty while the UI shows approve/deny buttons. */
  readonly pendingApprovals: Record<string, PendingApproval>;
}

/** The reactive slice the UI renders for one conversation. */
export interface ConversationView {
  /** Persisted thread (loaded on Agent open; refreshed after each run). */
  readonly messages: SessionMessage[];
  /** Live streaming state; `null` when idle. */
  readonly stream: StreamState | null;
  readonly isRunning: boolean;
  readonly error: { code: string; message: string } | null;
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
  stream: null,
  isRunning: false,
  error: null,
  draft: "",
};

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

/** A blank tool-call stub — `tool_input_delta` may arrive before `tool_call`. */
function defaultToolCall(toolCallId: string): ToolCallView {
  return {
    toolCallId,
    toolName: "",
    inputDraft: "",
    input: undefined,
    status: "running",
    output: undefined,
    error: null,
  };
}

/** Shallow-merge a patch into one tool-call slot, returning a new record map. */
function upsertToolCall(
  toolCalls: Record<string, ToolCallView>,
  toolCallId: string,
  patch: Partial<ToolCallView>,
): Record<string, ToolCallView> {
  const existing = toolCalls[toolCallId] ?? defaultToolCall(toolCallId);
  return { ...toolCalls, [toolCallId]: { ...existing, ...patch } };
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
): Promise<Agent> {
  const roleBehavior = getRoleBehavior(conversation.agentConfigName);
  if (!roleBehavior) {
    throw new Error(
      `constructAgent: unknown agent config "${conversation.agentConfigName}" — no RoleBehavior registered.`,
    );
  }
  const ctx: ToolContext = {
    spaceId,
    worldId: worldId as WorldId,
    approvalGate,
    autoExecuteDangerousTools,
  };
  const tools = roleBehavior.buildTools(ctx);
  const loop = new AgentLoop({
    model,
    systemPrompt: roleBehavior.systemPrompt,
    tools,
    maxSteps: roleBehavior.maxSteps,
    ...(roleBehavior.temperature !== undefined
      ? { temperature: roleBehavior.temperature }
      : {}),
  });
  const store = new TauriSessionStore({ spaceId, worldId });
  return Agent.open({
    loop,
    store,
    sessionId: conversation.id,
    onPersistError,
  });
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

      const { model, autoExecuteDangerousTools } = resolved;
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
        );
        patchData(worldId, conversationId, (d) => ({
          ...d,
          agent,
          agentLoading: false,
          view: { ...d.view, messages: [...agent.getMessages()], error: null },
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
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: { ...d.view, error: null, isRunning: true, stream: null },
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
              text: "",
              reasoning: "",
              currentStep: 0,
              pendingInputDraft: "",
              toolCalls: {},
              pendingApprovals: {},
            },
          },
        }));

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
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: { ...d.view.stream, currentStep: event.stepNumber },
                  },
                };
              });
              return;

            case "step_end":
              // Usage/latency logged by createAgentEventLogger; no view change.
              return;

            case "text_delta":
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      text: d.view.stream.text + event.delta,
                    },
                  },
                };
              });
              return;

            case "reasoning_delta":
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      reasoning: d.view.stream.reasoning + event.delta,
                    },
                  },
                };
              });
              return;

            case "tool_input_delta":
              // The event carries no toolCallId (the loop strips it); buffer
              // into the pending draft and transfer on the next tool_call.
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      pendingInputDraft:
                        d.view.stream.pendingInputDraft + event.delta,
                    },
                  },
                };
              });
              return;

            case "tool_call":
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                const draft = d.view.stream.pendingInputDraft;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      // Hand the buffered draft to this call, then reset.
                      pendingInputDraft: "",
                      toolCalls: upsertToolCall(d.view.stream.toolCalls, event.toolCallId, {
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        inputDraft: draft,
                        input: event.input,
                        status: "running",
                      }),
                    },
                  },
                };
              });
              return;

            case "tool_result":
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      toolCalls: upsertToolCall(d.view.stream.toolCalls, event.toolCallId, {
                        toolName: event.toolName,
                        status: "done",
                        output: event.output,
                      }),
                    },
                  },
                };
              });
              return;

            case "tool_error":
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return d;
                return {
                  ...d,
                  view: {
                    ...d.view,
                    stream: {
                      ...d.view.stream,
                      toolCalls: upsertToolCall(d.view.stream.toolCalls, event.toolCallId, {
                        toolName: event.toolName,
                        status: "error",
                        error: { code: event.error.code, message: event.error.message },
                      }),
                    },
                  },
                };
              });
              return;

            case "error":
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
              // Immediate "stopped" feedback; result.then() finalizes.
              // Also clear any pending approvals — the gate's abort listener
              // should have already resolved them, but this is defensive.
              patchData(worldId, conversationId, (d) => {
                if (!d.view.stream) return { ...d, view: { ...d.view, isRunning: false } };
                return {
                  ...d,
                  view: {
                    ...d.view,
                    isRunning: false,
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

        handle.subscribe(handleEvent);
        handle.subscribe(createAgentEventLogger(roleName));

        // ── Run finalization ──
        // The Agent registers its OWN handle.result.then() inside run() (it
        // persists the delta + updates agent.messages). Our .then() runs AFTER
        // it (promise callbacks fire in registration order), so
        // agent.getMessages() here already reflects the appended response.
        // The result NEVER rejects (ADR-0018); the .catch is defensive.
        void handle.result
          .then(() => {
            patchData(worldId, conversationId, (d) => ({
              ...d,
              runHandle: null,
              view: {
                ...d.view,
                messages: [...agent.getMessages()],
                isRunning: false,
                stream: null,
              },
            }));
          })
          .catch((e) => {
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
