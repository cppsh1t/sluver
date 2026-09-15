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
import type { UserContent } from "ai";

import {
  Agent,
  AgentLoop,
  type AgentEvent,
  type AgentRunHandle,
  type CompactionPolicy,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ResolvedModelConfig,
  type SessionMessage,
} from "@/lib/ai";
import {
  createConversation as createConversationIpc,
  deleteMessages as deleteMessagesIpc,
  loadMessages as loadMessagesIpc,
  updateMessage as updateMessageIpc,
} from "@/api/conversation";
import {
  getCharacterImage,
  getEventImage,
  getItemImage,
  getLocationImage,
  getLoreImage,
  getNovelImage,
  getPhaseImage,
  getWorldImage,
} from "@/api/image";
import { getSceneImage } from "@/api/scene-image";
import { createAgentEventLogger } from "@/lib/ai/agent-logging";
import {
  buildSubagentRosterBlock,
  getRoleDefinition,
  injectContextNote,
} from "@/lib/ai-roles";
import { TauriSessionStore } from "@/lib/ai-store";
import { base64Encode, sniffImageMime } from "@/lib/image-bytes";
import { logger } from "@/lib/logger";
import { notifyToolConsentRequested } from "@/lib/notify";
import { expandDeleteIds, replaceMessageText } from "./message-mutations";
import type {
  ToolContext,
  ApprovalGate,
  ConsentLevel,
  EntityImageKind,
  SubagentDispatchInput,
  SubagentDispatchResult,
  SubagentRunner,
} from "@/lib/tools/types";
import {
  characterIdSchema,
  eventIdSchema,
  itemIdSchema,
  locationIdSchema,
  loreIdSchema,
  novelIdSchema,
  phaseIdSchema,
  sceneImageIdSchema,
  worldIdSchema,
} from "@/types";
import type {
  Conversation,
  ContextCompaction,
  ConversationId,
  EnabledSkill,
  Message,
  SpaceId,
  WorldId,
} from "@/types";

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
      /**
       * Whether the shell execution tool (`run_shell_command`) is
       * registered for this role (ADR-0042). Read at Agent-construction
       * time; rides the ToolContext like `autoExecuteDangerousTools`.
       */
      readonly shellToolEnabled: boolean;
      /** Per-role Context-mode compaction config (ADR-0031 Phase 1). */
      readonly contextCompaction: ContextCompaction;
      /**
       * Per-role context note from the Space's AgentConfig. Empty string =
       * none. Non-empty = inserted at the END of the role prompt's
       * `<context>` block (`injectContextNote`, ai-roles/index.ts) — the
       * code-defined prompt itself is never replaced.
       */
      readonly contextNote: string;
      /**
       * Per-role step-budget override from the Space's AgentConfig.
       * `null` = use the role registry's code-defined default
       * (ai-roles/index.ts). Applied at Agent-construction time.
       */
      readonly maxSteps: number | null;
      /**
       * Agent Skills enabled for this role (ADR-0043 §3). Empty array =
       * none — no skill tools registered, no `<available_skills>` catalog.
       * Resolved live per role from the Space's per-AgentConfig enablement;
       * takes effect for new conversations (ADR-0024 agent cache).
       */
      readonly skills: EnabledSkill[];
      /**
       * The Space's dedicated `"vision"` agent model config (ADR-0045),
       * resolved live by the Provider (Space-scoped, shared by every role —
       * unlike the fields above it is NOT per-role). `null` = unbound →
       * the always-registered `look_at` tool returns its structured
       * `unconfigured` result (ADR-0050 D6). Takes effect for new
       * conversations (ADR-0024 agent cache — same lifecycle as
       * `shellToolEnabled`).
       */
      readonly visionConfig: ResolvedModelConfig | null;
    }
  | { readonly status: "loading" }
  | { readonly status: "unconfigured" };

/**
 * Resolves the bound model for a role name (any registry role — see
 * `src/lib/ai-roles`; conversational and subagent roles alike). Built by
 * the Provider from the Space-scoped `AgentConfig` list; passed into store
 * actions.
 */
export type ModelResolver = (role: string) => ResolvedModel;

/**
 * Resolves whether the model currently bound to a role accepts image input
 * (ADR-0044 §D9 step 2 — catalog-driven vision downgrade). Built by the
 * Provider from the models.dev catalog (`inputModalities.includes("image")`).
 *
 * Tri-state by contract:
 * - `true`  — catalog confirms the model takes images (pass parts through);
 * - `false` — catalog confirms it does NOT (downgrade to text markers);
 * - `undefined` — unknown (no catalog entry / no modalities / no model
 *   chosen / queries still loading). NEVER defaults to `false` — a custom
 *   OpenAI-compatible vision setup must not be silently downgraded.
 */
export type ImageInputSupportedResolver = (role: string) => boolean | undefined;

/**
 * Legacy text encoding a text attachment was deterministically converted
 * from at pick time (ADR-0044): `"utf-16le"` / `"utf-16be"` (byte-order-mark
 * detected) or `"gb18030"` (GBK/GB2312 superset — the realistic zh-CN
 * legacy case). See `attachment-picker.ts` for the cascade.
 */
export type ConvertedFromEncoding = "utf-16le" | "utf-16be" | "gb18030";

/**
 * A staged-but-unsent chat attachment (ADR-0044 §D8). Lives on
 * {@link ConversationView} next to `draft` so it survives conversation
 * switches (ADR-0024); cleared inside `send`. `dataUrl` holds the full
 * base64 data URL (`data:{mime};base64,…`) — the same runtime form the
 * message thread uses, so `send` can build `FilePart`s from it directly.
 */
export interface DraftAttachment {
  /** Client-minted UUID v4 (`crypto.randomUUID()`) — stable across re-renders. */
  readonly id: string;
  readonly kind: "image" | "text";
  readonly mime: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
  /**
   * Present only when a legacy text encoding was auto-converted to UTF-8 at
   * pick time; `undefined` = staged as-is (already valid UTF-8). When set,
   * `dataUrl` + `sizeBytes` describe the CONVERTED UTF-8 bytes (what actually
   * reaches the model and persistence). Drives the composer's conversion
   * toast — conversion is never silent.
   */
  readonly convertedFrom?: ConvertedFromEncoding;
}

/**
 * Max attachments per message (plan D6 — context-bloat control; the cap is
 * frontend-only, NOT enforced Rust-side in v1). Exported so the UI layer
 * (Wave 3 composer) can pre-validate; `addDraftAttachments` enforces it
 * defensively by IGNORING overflow items.
 */
export const MAX_DRAFT_ATTACHMENTS = 8;

/** Routes a background persistence failure to the logger (ADR-0014). */
export type PersistErrorHandler = (error: unknown) => void;

/** Input for the silent auto-title callback (ADR-0040). */
export interface AutoTitleInput {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  /** The conversation's FIRST user message, in full (truncated downstream). */
  readonly userText: string;
}

/**
 * Fire-and-forget conversation titling (ADR-0040). Implemented by the
 * Provider (which owns the `"namer"` agent's resolved model config); invoked
 * by run finalization when an untitled conversation completes its first
 * assistant run. Return contract:
 *
 * - non-null = the conversation's CURRENT title — either generated and
 *   persisted by us, or observed already-set in the DB (typically a sidebar
 *   rename the caller's slot cache never saw). Callers patch their cached
 *   `conversation.title` with it, permanently stopping re-triggers.
 * - `null` = nothing done (unconfigured namer, conversation gone, skip, or
 *   failure) — stay silent.
 *
 * NEVER rejects.
 */
export type AutoTitleCallback = (input: AutoTitleInput) => Promise<string | null>;

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
  /**
   * The dispatch contract's authoritative terminal status for a subagent
   * run's slot (ADR-0050 D3): written by the dispatch runtime AFTER
   * driveRun's finalization so it WINS over the generic `stopReason`
   * (which cannot tell a user-stop from a parent-cascade abort).
   * `null` everywhere else — user conversations never set it, and every
   * new run clears it (driveRun's start-of-run reset).
   */
  readonly terminalStatus: SubagentDispatchResult["status"] | null;
  /** Draft text — preserved across conversation switches (ADR-0024). */
  draft: string;
  /**
   * Staged attachments for the next send (ADR-0044 §D8) — the composer's
   * chip strip. Preserved across conversation switches like `draft`;
   * cleared inside `send`. Enforced to at most {@link MAX_DRAFT_ATTACHMENTS}
   * entries by `addDraftAttachments`.
   */
  draftAttachments: DraftAttachment[];
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
  /**
   * `true` while a background auto-title call is in flight (ADR-0040).
   * Guards against double-firing across consecutive run finalizations;
   * the cached `conversation.title` update is what permanently stops
   * re-triggering (title !== null check).
   */
  autoTitlePending: boolean;
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
    /**
     * The outgoing user turn (ADR-0044): a plain string (the historical
     * form) or an SDK `UserContent` parts array (text + image/text file
     * attachments with data-URL `data`).
     */
    content: UserContent,
    modelResolver: ModelResolver,
    onPersistError: PersistErrorHandler,
    autoTitle: AutoTitleCallback,
    /**
     * Per-send vision capability for the role's bound model (ADR-0044 §D9
     * step 2). Forwarded to `agent.run` as `imageInputSupported`.
     */
    imageInputSupportedResolver: ImageInputSupportedResolver,
  ) => Promise<void>;

  /**
   * User-initiated single-message delete (ADR-0047). Pair-aware via
   * `expandDeleteIds`: deleting an assistant message takes its immediately
   * answering tool messages; deleting a tool message takes its parent
   * assistant + ALL sibling tool messages — the surviving thread never
   * carries a dangling half of a tool pair.
   *
   * Durable-first: the DB rows are deleted BEFORE the in-memory thread. On
   * IPC failure NOTHING is mutated and the error RETHROWS (the hook caller
   * toasts). No-op (warn) when the runtime is missing or a run is in
   * flight. `pendingTurn` page-level echo is intentionally left alone (the
   * page owns the optimistic echo).
   */
  deleteMessage: (
    worldId: string,
    conversationId: string,
    messageId: string,
  ) => Promise<void>;

  /**
   * In-place message body edit (ADR-0047): replaces the target message's
   * text content — both `user` and `assistant` messages — WITHOUT
   * re-running anything. `partIndex` targets one text part within an
   * assistant message's content array (block id `${msg.id}#text-${n}`, n =
   * index within the parts array); `null` for string content and user
   * messages (whole-message edit).
   *
   * Durable-first with raw-body surgery: the persisted row's `body`
   * carries `attachment://` refs the hydrated in-memory copy no longer
   * has, so the replacement body is computed against the RAW persisted
   * row (via `load_messages` + `replaceMessageText`) and written via
   * `update_message` BEFORE memory moves. Usage columns are preserved by
   * the Rust command; `messageUsages` / `lastTurnUsage` stay untouched
   * (content edits don't change token accounting).
   *
   * Resolution contract: resolves `true` once the edit is committed
   * durably AND in the in-memory thread. Resolves `false` when a guard
   * rejected the edit (runtime missing, run in flight, target not found
   * or not editable — already logged). Rejects on persistence failure,
   * with memory untouched (durable-first; the hook caller toasts).
   */
  editMessage: (
    worldId: string,
    conversationId: string,
    messageId: string,
    partIndex: number | null,
    newText: string,
  ) => Promise<boolean>;

  abort: (worldId: string, conversationId: string) => void;
  setDraft: (worldId: string, conversationId: string, text: string) => void;
  /**
   * Stage draft attachments (ADR-0044 §D8). Does NO mime/size validation —
   * Rust validates authoritatively at persist time and the UI pre-validates
   * for instant feedback; the ONLY guard here is the count cap
   * ({@link MAX_DRAFT_ATTACHMENTS}): items beyond the cap are IGNORED
   * (not truncated-with-error) — a deliberate choice; the UI layer
   * pre-validates and this is the defensive backstop.
   */
  addDraftAttachments: (
    worldId: string,
    conversationId: string,
    items: DraftAttachment[],
  ) => void;
  removeDraftAttachment: (
    worldId: string,
    conversationId: string,
    id: string,
  ) => void;
  removeConversation: (worldId: string, conversationId: string) => void;
  clearError: (worldId: string, conversationId: string) => void;
  resolveApproval: (worldId: string, conversationId: string, toolCallId: string, approved: boolean) => void;
  /**
   * Approve every pending approval of a subagent run's slot in ONE gesture
   * (ADR-0050 D5 — the subagent block's approve-all affordance, the only
   * cross-runtime consent surface). Iterates the slot's CURRENT
   * `pendingApprovals` keys and resolves each through the exact per-id path
   * as {@link resolveApproval} (resolver consumed + removed, view patched,
   * gate unblocked). No-op when the slot or its stream is absent.
   */
  approveAllForRun: (worldId: string, runId: string) => void;
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
  terminalStatus: null,
  draft: "",
  draftAttachments: [],
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

// ─── Auto-title extraction (ADR-0040) ─────────────────────────────────────

/**
 * Extract the text content of one message, skipping non-text parts (tool
 * calls, files, reasoning). Returns `""` when the message carries no text.
 */
function messageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((s) => s !== "")
    .join(" ")
    .trim();
}

/**
 * Pick the FIRST user text from a finalized thread for auto-titling.
 * Non-text parts and empty messages are skipped; `null` when there is
 * nothing extractable.
 */
function extractTitleText(
  messages: readonly ModelMessage[],
): string | null {
  for (const message of messages) {
    if (message.role === "user") {
      const text = messageText(message);
      if (text !== "") return text;
    }
  }
  return null;
}

/**
 * Slice a subagent run's report: the LAST assistant message carrying text,
 * scanned from the run result's message array (which includes best-effort
 * partials for aborted / error terminations — ADR-0018), so interrupted
 * runs still return whatever partial text exists (ADR-0050 D3). Empty
 * string when the run produced no assistant text. Reuses the title
 * extractor's text joiner (trims, skips non-text parts).
 */
function lastAssistantText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text !== "") return text;
  }
  return "";
}

// ─── Subagent dispatch constants (ADR-0050 D2/D3/D4) ──────────────────────

/**
 * The abort-reason string marking a USER-initiated stop of a single run.
 * The child run's `abort` event carries it verbatim
 * (`AgentRunHandle.abort(reason)` → `AbortSignal.reason` → event), and the
 * dispatch runtime maps it to `status: "stopped"` — everything else
 * (including the reason-less aborts of a parent cascade) maps to
 * `"aborted"` (D4). The store's user-facing `abort` action passes this
 * constant so stopping a child through its own slot (the Unit D Stop
 * button path) labels correctly.
 */
const SUBAGENT_STOP_REASON = "stopped";

/**
 * Bounded patience while the child role's model resolution is still
 * "loading" (see {@link resolveChildModel}). ~1.5s worst case — tiny
 * relative to a dispatch round-trip, and the state is near-impossible in
 * practice (all roles gate on the same Space-scoped queries).
 */
const SUBAGENT_LOADING_ATTEMPTS = 10;
const SUBAGENT_LOADING_DELAY_MS = 150;

/**
 * No-op {@link AutoTitleCallback} for child runs — belt-and-suspenders next
 * to the `kind: "subagent"` gate in run finalization (Unit B): runs are
 * hidden machinery and never titled (ADR-0050 D2).
 */
const NOOP_AUTO_TITLE: AutoTitleCallback = async () => null;

/**
 * The never-available runner handed to subagent runs (ADR-0050 D1 — exactly
 * one delegation level). Subagent roles never register `dispatch_subagent`,
 * so reaching this stub means a wiring bug; it rejects loudly instead of
 * silently no-oping. The rejection can only surface inside a tool execute
 * that should not exist — the dispatch composite's never-reject contract
 * (D4) applies to the REAL runner, which resolves every outcome.
 */
const SUBAGENT_RUNNER_STUB: SubagentRunner = {
  run: () =>
    Promise.reject(
      new Error(
        "dispatch_subagent is not available on subagent runs — subagents never dispatch (ADR-0050 D1).",
      ),
    ),
};

/** Zeroed usage for dispatch outcomes that never reached a model call. */
const ZERO_DISPATCH_USAGE = { input: 0, output: 0 } as const;

/**
 * Resolve the child role's bound model, tolerating a transient "loading".
 *
 * In practice the child resolver cannot still be `"loading"` at dispatch
 * time: the Provider's `modelResolver` gates EVERY role on the SAME
 * Space-scoped queries (agent configs + credentials + catalog + skills —
 * see provider.tsx), so a running Orchestrator implies settled queries and
 * the child resolves `"ready"` or `"unconfigured"` immediately. The bounded
 * retry below is defense for contract drift (e.g. per-role query
 * splitting): a few short abort-aware polls, after which the caller
 * surfaces an `error` result asking the Orchestrator to retry — NOT a
 * silent `"unconfigured"`, which would send the user to Settings for a
 * model that is actually bound (explicit-fail discipline, D6).
 */
async function resolveChildModel(
  role: string,
  modelResolver: ModelResolver,
  abortSignal: AbortSignal,
): Promise<ResolvedModel> {
  let resolved = modelResolver(role);
  for (let attempt = 0; attempt < SUBAGENT_LOADING_ATTEMPTS; attempt++) {
    if (resolved.status !== "loading") return resolved;
    if (abortSignal.aborted) return resolved;
    await new Promise((resolve) => setTimeout(resolve, SUBAGENT_LOADING_DELAY_MS));
    resolved = modelResolver(role);
  }
  return resolved;
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
    autoTitlePending: false,
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

// ─── Skills catalog injection (ADR-0043 §3) ───────────────────────────────

/**
 * Build the `<available_skills>` catalog block appended to the effective
 * system prompt at Agent construction — step 1 of progressive disclosure:
 * a lightweight name + description listing (~100 tokens per skill) that
 * sits permanently in context; the body and bundled files load only on
 * demand via `activate_skill` / `read_skill_file`.
 *
 * Deterministic and greppable: one `<skill>` element per enabled skill, in
 * the order the resolver produced. English by convention — system prompts
 * are English throughout this codebase (ai-roles/index.ts).
 */
function buildAvailableSkillsBlock(skills: readonly EnabledSkill[]): string {
  const entries = skills
    .map(
      (s) =>
        `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n</skill>`,
    )
    .join("\n");
  return [
    "<available_skills>",
    "The following skills are installed for this agent. When the user's task matches a skill's description, call activate_skill with its name BEFORE proceeding. Activated skill instructions persist for the conversation.",
    entries,
    "</available_skills>",
  ].join("\n");
}

/**
 * Read one stored entity image's raw bytes for the `look_at` entity source
 * (ADR-0048) — the IPC half of `entityImageLookup` below.
 *
 * Kind → getter mapping follows `api/image.ts`'s conventions exactly: World
 * is keyed by its own id (no `worldId` arg — World IS the entity), every
 * other kind scopes to the conversation's world, and `scene_image` reads a
 * single gallery row by its own image id via `api/scene-image.ts`. The zod
 * brandings are applied HERE so the API layer's branded signatures stay
 * satisfied without `as never` casts at the call sites.
 */
function fetchEntityImageBytes(
  spaceId: SpaceId,
  worldId: WorldId,
  kind: EntityImageKind,
  id: string,
): Promise<ArrayBuffer | null> {
  switch (kind) {
    case "world":
      // World lives in space.db and is addressed by its own id (no worldId).
      return getWorldImage(spaceId, worldIdSchema.parse(id));
    case "character":
      return getCharacterImage(spaceId, worldId, characterIdSchema.parse(id));
    case "phase":
      return getPhaseImage(spaceId, worldId, phaseIdSchema.parse(id));
    case "location":
      return getLocationImage(spaceId, worldId, locationIdSchema.parse(id));
    case "item":
      return getItemImage(spaceId, worldId, itemIdSchema.parse(id));
    case "lore":
      return getLoreImage(spaceId, worldId, loreIdSchema.parse(id));
    case "event":
      return getEventImage(spaceId, worldId, eventIdSchema.parse(id));
    case "novel":
      return getNovelImage(spaceId, worldId, novelIdSchema.parse(id));
    case "scene_image":
      // A gallery row, addressed by its own id — NOT the scene's id.
      return getSceneImage(spaceId, worldId, sceneImageIdSchema.parse(id));
  }
}

/**
 * The `<image_access>` block appended to the effective system prompt at
 * Agent construction (ADR-0045). Since ADR-0050 D6 the `look_at` tool is
 * registered UNCONDITIONALLY (explicit-fail over silent-hide — an unbound
 * vision config surfaces as a structured `unconfigured` tool result), so
 * the teaching rides the same always-on registration: the prompt may
 * always advertise the tool. Wording covers BOTH attachment paths: a
 * non-vision bound model sees NOT-delivered downgrade markers
 * (ADR-0044 D9), a vision-capable one sees the pixels plus a delivered
 * companion annotation (ADR-0048) — the teaching must tell the model how
 * to tell the two markers apart.
 */
const LOOK_AT_PROMPT_BLOCK = [
  "<image_access>",
  'Images the user attaches arrive WITH a `[image attachment: "filename" — ...]` marker telling you whether the pixels reached you. If the marker says image content NOT delivered you cannot see the image — call the look_at tool with the EXACT filename from the marker. If it says image content delivered in this message you already see the pixels (no look_at needed; the filename is the handle for the image tools, e.g. set_character_image_from_attachment). Image URLs in text cannot be viewed directly — call look_at with the URL. Every look_at call returns a description from a separate vision model.',
  'Entity images you or the user have stored CAN also be examined: call look_at with entityKind + entityId to describe a character/novel/event/element image (works for any entity whose hasImage is true — get_/list_ tools report it), entityKind "scene_image" with an image id from list_scene_images for a scene gallery image, or entityKind "world" ALONE (no id) for the current world\'s cover. This is how you verify a portrait or cover actually shows what it should.',
  "Pass question to focus on what you need to know. Use the description before answering questions about the image's content.",
  "</image_access>",
].join("\n");

/**
 * Construct a stateful {@link Agent} for a conversation. Resolves the role
 * definition from the registry (ADR-0050 D1), builds a `TauriSessionStore`
 * + `AgentLoop`, and loads history via the async `Agent.open` factory.
 * Throws if the role is unknown or the store rejects — callers handle
 * errors and surface them into `view.error`.
 */
async function constructAgent(
  conversation: Conversation,
  model: LanguageModel,
  spaceId: SpaceId,
  worldId: string,
  onPersistError: PersistErrorHandler,
  approvalGate: ApprovalGate,
  autoExecuteDangerousTools: boolean,
  shellToolEnabled: boolean,
  contextCompaction: ContextCompaction,
  contextNote: string,
  maxStepsOverride: number | null,
  skills: EnabledSkill[],
  visionConfig: ResolvedModelConfig | null,
  subagentRunner: SubagentRunner,
): Promise<Agent> {
  const roleDefinition = getRoleDefinition(conversation.agentConfigName);
  if (!roleDefinition) {
    throw new Error(
      `constructAgent: unknown agent config "${conversation.agentConfigName}" — no RoleDefinition registered.`,
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
    shellToolEnabled,
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
    // Agent Skills (ADR-0043 §3): the enabled catalog rides the context so
    // `skillTools` can enum-constrain `activate_skill` to real names, and
    // the mutable Set carries the per-conversation activation dedup state
    // (one fresh Set per Agent — ADR-0024 conversation cache).
    skills,
    activatedSkills: new Set(),
    // `look_at` (ADR-0045): the Space's dedicated one-shot vision agent
    // config. `null` = the seeded `vision` AgentConfig is unbound → the
    // tool stays registered and returns a structured `unconfigured`
    // result at execute time (ADR-0050 D6 — the registration-time gate
    // was removed; explicit-fail over silent-hide).
    visionConfig,
    // `look_at` (ADR-0045): resolves an in-conversation image attachment by
    // filename from the Persisted Thread — the reverse channel for the
    // downgrade markers (ADR-0044 D9). Same agentRef chicken-and-egg
    // pattern as `threadLookup` above (read-only; null when not found).
    // Hydrated data-URL FileParts already live in `Agent.messages`
    // (ADR-0044 D3 hydration) — zero IPC. Newest message wins so a
    // re-uploaded image is described, not a stale namesake.
    attachmentLookup: {
      findByFilename: (filename) => {
        const messages = agentRef.current?.getMessages() ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (message.role !== "user") continue;
          const { content } = message;
          if (typeof content === "string" || !Array.isArray(content)) continue;
          for (const part of content) {
            if (
              part.type === "file" &&
              part.mediaType.startsWith("image/") &&
              typeof part.data === "string" &&
              part.data.startsWith("data:") &&
              part.filename !== undefined &&
              (part.filename === filename ||
                part.filename.toLowerCase() === filename.toLowerCase())
            ) {
              return { dataUrl: part.data, mediaType: part.mediaType };
            }
          }
        }
        return null;
      },
    },
    // `look_at` entity source (ADR-0048): reads a stored entity image back
    // from its `image_blob` column as a data URL. Unlike attachmentLookup
    // above this IS IPC-backed (entity columns are not mirrored into the
    // thread) — one `get<Entity>Image` read per call, hence async. Unlike
    // planAccess/threadLookup it needs NO agentRef: it closes over the
    // per-conversation spaceId/worldId only. A `null` (no image set)
    // travels back as a structured `entity_image_not_found` tool result.
    entityImageLookup: {
      findByEntity: async (kind, id) => {
        const bytes = await fetchEntityImageBytes(spaceId, ctx.worldId, kind, id);
        if (!bytes) return null;
        // Sniff the real format from the bytes rather than trusting any
        // stored mime metadata — the write paths all emit WebP, but the
        // sniffer is O(1) defense-in-depth (see image-bytes.ts).
        const mediaType = sniffImageMime(bytes);
        return {
          dataUrl: `data:${mediaType};base64,${base64Encode(new Uint8Array(bytes))}`,
          mediaType,
        };
      },
    },
    // `dispatch_subagent` (ADR-0050 D3): the app-side dispatch capability.
    // Built by the CALLER (resolveAgent) because it needs the live
    // modelResolver + this conversation's identity as the parent link —
    // conversational (Orchestrator) conversations get the real runner,
    // subagent runs get the throwing stub (they never register the tool,
    // D1's exactly-one delegation level).
    subagentRunner,
  };

  const tools = roleDefinition.buildTools(ctx);
  // Apply the user's per-role context note: the trimmed text is inserted
  // at the END of the registry prompt's `<context>` block (never a new
  // XML section, never a replacement — the structured prompt's
  // operational sections stay code-owned). Empty note = registry prompt
  // verbatim. See injectContextNote in ai-roles/index.ts.
  const baseSystemPrompt = injectContextNote(
    roleDefinition.systemPrompt,
    contextNote,
  );
  // Apply the DB-stored step-budget override. `null` = use the code
  // default from the role registry (ai-roles/index.ts). Unlike the
  // context note, this is nullable-numeric so the fallback uses `??` (an
  // explicit 0 is schema-invalid and never persists).
  const effectiveMaxSteps = maxStepsOverride ?? roleDefinition.maxSteps;
  // ADR-0050 D3 — the orchestrator's roster block is appended AFTER the
  // base prompt: additive machinery like the skills catalog below, so the
  // roster is present regardless of the context note. Skipped for
  // subagents — they never see the dispatch tool (D1).
  // ADR-0045 — the look_at teaching is appended unconditionally since
  // ADR-0050 D6 (the tool is always registered; unbound vision surfaces
  // as a structured `unconfigured` result instead of silence).
  // ADR-0043 §3 catalog — appended AFTER the role prompt. It is additive
  // machinery, not user content: the context note never removes it. Skipped
  // entirely when the role has no enabled skills.
  const effectiveSystemPrompt = [
    baseSystemPrompt,
    ...(roleDefinition.kind === "conversational"
      ? [buildSubagentRosterBlock()]
      : []),
    LOOK_AT_PROMPT_BLOCK,
    ...(skills.length > 0 ? [buildAvailableSkillsBlock(skills)] : []),
  ].join("\n\n");
  const loop = new AgentLoop({
    model,
    systemPrompt: effectiveSystemPrompt,
    tools,
    maxSteps: effectiveMaxSteps,
    ...(roleDefinition.temperature !== undefined
      ? { temperature: roleDefinition.temperature }
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

            // Native OS notification — fire-and-forget, never blocks the gate.
            // Fired here (store layer) rather than the ConsentBanner so it
            // catches consent requests in non-visible conversations too
            // (in-flight runs survive switches — ADR-0024).
            void notifyToolConsentRequested({
              worldId,
              conversationId,
              toolName: req.toolName,
            });
          }),
      };
    }

    /**
     * Resolve one pending approval on a slot — the shared per-id body of
     * `resolveApproval` and `approveAllForRun` (identical semantics:
     * consume the resolver, drop the entry from `stream.pendingApprovals`,
     * then unblock the gate's execute).
     */
    const resolveApprovalInSlot = (
      worldId: string,
      conversationId: string,
      toolCallId: string,
      approved: boolean,
    ): void => {
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
    };
    // ── Shared run driver (send + subagent dispatch, ADR-0050 D3) ────────
    //
    // ONE event-handling code path for every AgentLoop run this store
    // drives: the user-facing `send` action AND the subagent dispatch
    // runtime below. Owns the running-state patch, the streaming batch
    // buffer, `handleEvent` (StreamState mutation), and run finalization
    // (message refresh, per-turn usage, auto-title). A subagent run is
    // "just another conversation id in the two-level map" (D2) — its events
    // flow through here unchanged, so the drill-in UI (Unit D) reads the
    // child slot's live view exactly like a user conversation's.
    //
    // Returns the run handle (for the caller's abort bookkeeping), or
    // `null` when `agent.run` threw synchronously (ConfigError — already
    // running; `view.error` is patched and nothing else is mutated).
    const driveRun = (
      worldId: string,
      conversationId: string,
      agent: Agent,
      content: UserContent,
      options: {
        /** Per-run vision capability for the bound model (ADR-0044 §D9). */
        imageInputSupported?: boolean;
        /**
         * Silent auto-title callback (ADR-0040). Already double-gated for
         * child runs: the finalization kind check skips `kind: "subagent"`
         * AND the subagent path passes a no-op.
         */
        autoTitle: AutoTitleCallback;
      },
    ): AgentRunHandle | null => {
      // Clear error + flip to running. Stream is set after we have the runId.
      // `lastTurnUsage` is reset here so the previous turn's value does not
      // linger while the new run is in-flight (ADR-0030 — it gets re-set on
      // finalization). The staged attachments leave with this turn — they
      // are now part of `content` (ADR-0044 §D8; user sends only — a child
      // run's slot never stages any).
      patchData(worldId, conversationId, (d) => ({
        ...d,
        view: {
          ...d.view,
          error: null,
          isRunning: true,
          stream: null,
          stopReason: null,
          // Stale terminal status from a previous run dies with the new
          // one (subagent slots are single-run today, but the reset keeps
          // the field honest for any re-driven slot).
          terminalStatus: null,
          lastTurnUsage: undefined,
          lastStepInputTokens: undefined,
          draftAttachments: [],
        },
      }));

      let handle: AgentRunHandle;
      // Build the run options conditionally so the argument object stays
      // key-identical to the historical user-send call shape (an explicit
      // `undefined` value would be observably different to strict spies).
      const runOptions: { imageInputSupported?: boolean } = {};
      if (options.imageInputSupported !== undefined) {
        runOptions.imageInputSupported = options.imageInputSupported;
      }
      try {
        handle = agent.run(content, runOptions);
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
        return null;
      }

      const roleName =
        getData(get(), worldId, conversationId)?.conversation.agentConfigName ??
        "unknown";

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
            // Stream already initialized above; nothing to add.
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

          // ── Auto-title (ADR-0040, fire-and-forget) ──────────────────
          // After the FIRST completed assistant run on an untitled
          // conversation, silently ask the "namer" agent for a short
          // title. Never blocks the finalization path above; every
          // rejection is swallowed (the callback never rejects by
          // contract — the .catch is defensive).
          // Gated per ADR-0040 "first completed run"; aborts/errors resolve too (ADR-0018) but must not trigger titling.
          // ADR-0050 D2 — subagent runs are hidden machinery, never
          // user-facing list rows: auto-titling is suppressed for
          // `kind: "subagent"` (the namer keeps its silent-skip
          // exception while look_at went explicit-fail — D6).
          const slot = getData(get(), worldId, conversationId);
          const conversation = slot?.conversation;
          if (
            slot &&
            conversation &&
            conversation.meta.kind !== "subagent" &&
            conversation.title === null &&
            !slot.autoTitlePending &&
            result.finishReason !== "aborted" &&
            result.finishReason !== "error"
          ) {
            const userText = extractTitleText(agent.getMessages());
            if (userText !== null) {
              patchData(worldId, conversationId, (d) => ({
                ...d,
                autoTitlePending: true,
              }));
              void options.autoTitle({
                worldId: worldId as WorldId,
                conversationId: conversation.id,
                userText,
              })
                .then((title) => {
                  patchData(worldId, conversationId, (d) => ({
                    ...d,
                    autoTitlePending: false,
                    // Cache the title so the NEXT finalization's
                    // `title === null` check doesn't re-trigger.
                    ...(title
                      ? { conversation: { ...d.conversation, title } }
                      : {}),
                  }));
                })
                .catch((e: unknown) => {
                  // Defensive — autoTitle resolves (never rejects) by
                  // contract; this guards against contract violations.
                  logger.warn("chat.auto_title.failed", {
                    conversation_id: conversationId,
                    world_id: worldId,
                    error: String(e),
                  });
                  patchData(worldId, conversationId, (d) => ({
                    ...d,
                    autoTitlePending: false,
                  }));
                });
            }
          }
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

      return handle;
    };

    // ── Subagent dispatch runtime (ADR-0050 D2/D3/D4) ────────────────────
    //
    // The live SubagentRunner bound to one parent (Orchestrator)
    // conversation. Each run():
    //
    // 1. resolves the child role's model (tri-state; "unconfigured"
    //    short-circuits with guidance and NO conversation — D6);
    // 2. creates the hidden `kind: "subagent"` conversation carrying the
    //    parent linkage (D2) via the flat create-conversation fields
    //    (Rust builds `meta` server-side);
    // 3. constructs the child Agent through the SAME resolveAgent path as
    //    a user conversation — own AgentLoop, own approval gate (D5), own
    //    runtime slot keyed by the run's conversation id in the two-level
    //    map (nothing blocks two live slots in one world: sibling
    //    dispatches are independent map entries);
    // 4. drives it with the shared driveRun machinery (one event path —
    //    the child's stream is live in its own slot for the drill-in UI);
    // 5. resolves the DispatchResult contract: status mapping via
    //    finishReason + the abort-source listener, finalMessage = last
    //    assistant text (partials included, ADR-0018), usage from
    //    result.totalUsage, runId = the child conversation id.
    //
    // Abort semantics (D4): the parent abortSignal is chained MANUALLY (a
    // plain reason-less handle.abort) so a parent cascade always maps to
    // status "aborted", while user-initiated single-run stops — runner
    // .stop() and the store's `abort` action on the child's own slot —
    // carry the SUBAGENT_STOP_REASON string and map to "stopped".
    //
    // Logging: run_started / run_finished / run_stopped with snake_case
    // fields; the task brief is NEVER logged (ADR-0016 redaction — the
    // dispatch input carries creative-work instructions).
    const createSubagentRunner = (
      worldId: string,
      parentConversationId: string,
      modelResolver: ModelResolver,
      onPersistError: PersistErrorHandler,
    ): SubagentRunner => {
      /** Live child run handles, keyed by run conversation id (drives stop). */
      const liveRuns = new Map<string, AgentRunHandle>();

      const runInner = async (
        input: SubagentDispatchInput,
        abortSignal: AbortSignal,
      ): Promise<SubagentDispatchResult> => {
        // 1. Child model resolution (tri-state, ADR-0050 D6).
        const resolved = await resolveChildModel(
          input.role,
          modelResolver,
          abortSignal,
        );
        if (abortSignal.aborted) {
          // Parent died while we were resolving — no run was created.
          return {
            runId: null,
            status: "aborted",
            finalMessage: "",
            usage: ZERO_DISPATCH_USAGE,
          };
        }
        if (resolved.status === "unconfigured") {
          // D6 — explicit-fail over silent-hide: report and suggest the fix;
          // NO conversation row is created.
          return {
            runId: null,
            status: "unconfigured",
            finalMessage:
              `No model is bound for the "${input.role}" agent, so the subagent did not run. ` +
              'Tell the user to bind a model for this role in Settings (AI configuration) and ask how to proceed.',
            usage: ZERO_DISPATCH_USAGE,
          };
        }
        if (resolved.status === "loading") {
          // Bounded patience exhausted (see resolveChildModel) — surface as
          // a retryable error, NOT as "unconfigured" (the model may well be
          // bound; sending the user to Settings would be a wrong diagnosis).
          return {
            runId: null,
            status: "error",
            finalMessage: `The AI configuration for "${input.role}" is still loading. Retry the dispatch in a moment.`,
            usage: ZERO_DISPATCH_USAGE,
          };
        }

        // 2. Hidden run conversation (D2). Flat linkage fields — the Rust
        //    command builds the persisted `meta` server-side. The
        //    parentToolCallId anchor comes from the dispatch tool's call
        //    options (SDK-assigned); the UUID fallback only fires on direct
        //    execute calls that could not provide one.
        let conversation: Conversation;
        try {
          conversation = await createConversationIpc(
            spaceId,
            worldId as WorldId,
            {
              agentConfigName: input.role,
              kind: "subagent",
              parentConversationId,
              parentToolCallId: input.parentToolCallId ?? crypto.randomUUID(),
              role: input.role,
            },
          );
        } catch (e) {
          return {
            runId: null,
            status: "error",
            finalMessage: `could not create the subagent run: ${e instanceof Error ? e.message : String(e)}`,
            usage: ZERO_DISPATCH_USAGE,
          };
        }

        logger.info("subagent.run_started", {
          role: input.role,
          run_id: conversation.id,
          parent_conversation_id: parentConversationId,
          world_id: worldId,
        });

        // 3. Own runtime slot + own Agent (same path as a user
        //    conversation — the two-level map takes any number of live
        //    children per world).
        set((state) => ({ worlds: ensureSlot(state, worldId, conversation) }));
        const childData = getData(get(), worldId, conversation.id);
        if (!childData) {
          // Defensive — ensureSlot just created it.
          return {
            runId: conversation.id,
            status: "error",
            finalMessage: "the subagent run slot could not be created",
            usage: ZERO_DISPATCH_USAGE,
          };
        }
        const childAgent = await resolveAgent(
          childData,
          modelResolver,
          onPersistError,
          worldId,
          conversation.id,
        );
        if (!childAgent) {
          // resolveAgent patched view.error on the child slot — surface it.
          const failure = getData(get(), worldId, conversation.id)?.view.error;
          return {
            runId: conversation.id,
            status: "error",
            finalMessage: `the subagent runtime failed to initialize: ${failure?.message ?? "unknown error"}`,
            usage: ZERO_DISPATCH_USAGE,
          };
        }

        // 4. Drive through the shared machinery (one event path, D3). The
        //    child's ToolContext carries the dispatch STUB — subagents
        //    never dispatch (D1) — so no recursion is possible.
        const handle = driveRun(
          worldId,
          conversation.id,
          childAgent,
          input.task,
          { autoTitle: NOOP_AUTO_TITLE },
        );
        if (!handle) {
          // agent.run threw synchronously (ConfigError) — driveRun patched
          // view.error on the child slot. Evict the cached childAgent (F3)
          // and stamp the authoritative error status (F1) before bailing.
          patchData(worldId, conversation.id, (d) => ({
            ...d,
            agent: null,
            view: { ...d.view, terminalStatus: "error" },
          }));
          const failure = getData(get(), worldId, conversation.id)?.view.error;
          return {
            runId: conversation.id,
            status: "error",
            finalMessage: `the subagent run failed to start: ${failure?.message ?? "unknown error"}`,
            usage: ZERO_DISPATCH_USAGE,
          };
        }
        liveRuns.set(conversation.id, handle);

        // 5. Abort wiring (D4). The source listener reads the child's
        //    `abort` EVENT reason: only SUBAGENT_STOP_REASON ("stopped",
        //    set by stop() below and by the store's user-facing abort
        //    action on the child's own slot) maps to "stopped"; the parent
        //    cascade below aborts reason-less → "aborted". Fires exactly
        //    once per aborted run, whichever path triggered it.
        // Boxed on purpose: closure writes don't participate in
        // straight-line control-flow narrowing, so a plain `let` would be
        // read back as its literal "aborted" initializer (TS2367 on the
        // `=== "stopped"` check below). Property reads keep the declared
        // union across the intervening calls.
        const abortSource: { source: "aborted" | "stopped" } = {
          source: "aborted",
        };
        const unsubSource = handle.subscribe((event) => {
          if (event.type === "abort") {
            abortSource.source =
              event.reason === SUBAGENT_STOP_REASON ? "stopped" : "aborted";
            logger.info("subagent.run_stopped", {
              run_id: conversation.id,
              source: abortSource.source,
            });
          }
        });
        // Parent cascade: manual chaining (NOT agent.run's abortSignal
        // option, which would forward the parent's own abort reason into
        // the child's signal and pollute the source mapping above).
        const onParentAbort = (): void => handle.abort();
        if (abortSignal.aborted) {
          onParentAbort();
        } else {
          abortSignal.addEventListener("abort", onParentAbort, { once: true });
        }

        // 6. Resolve + map (handle.result NEVER rejects — ADR-0018).
        const result = await handle.result;
        unsubSource();
        abortSignal.removeEventListener("abort", onParentAbort);
        liveRuns.delete(conversation.id);

        let status: SubagentDispatchResult["status"];
        let finalMessage: string;
        switch (result.finishReason) {
          case "aborted": {
            status = abortSource.source;
            // Partial text: result.messages carries best-effort salvaged
            // assistant output (D3 — whatever exists plus the status).
            const partial = lastAssistantText(result.messages);
            if (abortSource.source === "stopped") {
              // A user stop must be unmistakable to the Orchestrator: the
              // bare "stopped" status doesn't say WHO stopped the run, so
              // the model could re-dispatch a task the user just killed.
              // State the cause explicitly, keeping any partial output.
              finalMessage = partial
                ? `The user stopped this subagent run. Partial output before the stop:\n${partial}`
                : "The user stopped this subagent run.";
            } else {
              finalMessage = partial;
            }
            break;
          }
          case "error":
            status = "error";
            finalMessage = result.error
              ? `${result.error.code}: ${result.error.message}`
              : "the subagent run failed";
            break;
          default:
            // stop / length / max-steps / content-filter / other — the run
            // finished; the report discipline lives in the role prompts.
            status = "completed";
            finalMessage = lastAssistantText(result.messages);
            break;
        }

        // F1/F3 — post-settlement slot patch. `terminalStatus` is the
        // dispatch contract's authoritative terminal state (only this
        // layer knows "stopped" vs "aborted" — driveRun's generic
        // stopReason cannot distinguish them); written AFTER driveRun's
        // finalization so it wins. `agent: null` releases the
        // SessionStore thread + model handle — a long writing session
        // would otherwise accumulate one Agent per dispatch for the
        // window's lifetime. The view + conversation stay for drill-in
        // replay; nothing re-drives a settled slot (each dispatch creates
        // a fresh run conversation), and `resolveAgent` already handles
        // `data.agent` being null if anything ever did.
        patchData(worldId, conversation.id, (d) => ({
          ...d,
          agent: null,
          view: { ...d.view, terminalStatus: status },
        }));

        return {
          runId: conversation.id,
          status,
          finalMessage,
          usage: {
            input: result.totalUsage.inputTokens ?? 0,
            output: result.totalUsage.outputTokens ?? 0,
          },
        };
      };

      return {
        run: async (input, abortSignal) => {
          const startedAt = performance.now();
          // ADR-0018 semantics extended to the dispatch composite (D4):
          // every outcome — including an unexpected internal throw —
          // resolves into the result contract; the promise never rejects.
          let outcome: SubagentDispatchResult;
          try {
            outcome = await runInner(input, abortSignal);
          } catch (e) {
            outcome = {
              runId: null,
              status: "error",
              finalMessage: `subagent dispatch failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`,
              usage: ZERO_DISPATCH_USAGE,
            };
          }
          logger.info("subagent.run_finished", {
            role: input.role,
            run_id: outcome.runId,
            status: outcome.status,
            latency_ms: Math.round(performance.now() - startedAt),
            usage_input: outcome.usage.input,
            usage_output: outcome.usage.output,
          });
          return outcome;
        },
        stop: (runId) => {
          // Reason-marked abort → the source listener above maps it to
          // "stopped" and the dispatch resolves with partial text.
          liveRuns.get(runId)?.abort(SUBAGENT_STOP_REASON);
        },
      };
    };

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

      const { model, autoExecuteDangerousTools, shellToolEnabled, contextCompaction, contextNote, maxSteps, skills, visionConfig } = resolved;
      const gate = createGate(worldId, conversationId);
      // ADR-0050 D3 — the dispatch capability riding the ToolContext. The
      // (only) conversational role — the Orchestrator — gets the LIVE
      // runner bound to THIS conversation as the parent link; subagent runs
      // (and any non-conversational kind) get the throwing stub: they never
      // register dispatch_subagent (D1's exactly-one delegation level).
      // Like the bound model, the runner closes over the modelResolver
      // captured at Agent-construction time — a Settings change takes
      // effect for the next Space window (same ADR-0024 cache lifecycle).
      const subagentRunner =
        getRoleDefinition(data.conversation.agentConfigName)?.kind ===
        "conversational"
          ? createSubagentRunner(
              worldId,
              conversationId,
              modelResolver,
              onPersistError,
            )
          : SUBAGENT_RUNNER_STUB;
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
          shellToolEnabled,
          contextCompaction,
          contextNote,
          maxSteps,
          skills,
          visionConfig,
          subagentRunner,
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

    // ── User-initiated message mutations (ADR-0047) ───────────────
    // Shared guards for deleteMessage / editMessage. Returns the live
    // runtime data + Agent, or null (already logged). Mutations are
    // rejected while a run is in flight — mutating a thread the loop is
    // actively appending to would corrupt the Persisted Thread.
    const resolveMutableRuntime = (
      worldId: string,
      conversationId: string,
    ): { data: ConversationRuntimeData; agent: Agent } | null => {
      const data = getData(get(), worldId, conversationId);
      if (!data) {
        logger.warn("chat.message_mutation.no_runtime", {
          conversation_id: conversationId,
          world_id: worldId,
        });
        return null;
      }
      if (data.view.isRunning || data.runHandle !== null) {
        logger.warn("chat.message_mutation.rejected", {
          reason: "running",
          conversation_id: conversationId,
        });
        return null;
      }
      if (!data.agent) {
        logger.warn("chat.message_mutation.no_agent", {
          conversation_id: conversationId,
          world_id: worldId,
        });
        return null;
      }
      return { data, agent: data.agent };
    };

    // Post-await re-check for the mutation TOCTOU window: a `send` may
    // have flipped the runtime to running while deleteMessage/editMessage
    // were awaiting IPC. True ⇒ the caller must NOT touch the Agent
    // thread mid-run (ADR-0047 §7 — runs append, user mutations, strictly
    // serial).
    const runStartedMeanwhile = (
      worldId: string,
      conversationId: string,
    ): boolean => {
      const data = getData(get(), worldId, conversationId);
      return !!data && (data.view.isRunning || data.runHandle !== null);
    };

    /**
     * Shared post-durable removal patch for deleteMessage. Called ONLY
     * after the DB delete resolved — the in-memory thread
     * (`agent.removeMessages`) and the reactive view (fresh `messages`
     * array via `agent.getMessages()`, usage entries for deleted ids
     * dropped, `lastTurnUsage` + `lastStepInputTokens` invalidated only
     * when the deletion touches the last turn) move together. `draft` /
     * `draftAttachments` / `stream` (null while idle) / `stopReason` are
     * intentionally untouched.
     */
    const applyMemoryRemoval = (
      worldId: string,
      conversationId: string,
      agent: Agent,
      ids: readonly string[],
    ): void => {
      agent.removeMessages(new Set(ids));
      patchData(worldId, conversationId, (d) => {
        const messageUsages: Record<string, MessageUsage> = {
          ...d.view.messageUsages,
        };
        for (const id of ids) delete messageUsages[id];

        // Scope the lastTurnUsage invalidation: the annotation describes
        // the MOST RECENT turn — the tail starting at the thread's last
        // user message. A deletion strictly BEFORE that boundary leaves
        // the annotation accurate, so it is preserved; with no user
        // message in the thread there is no boundary and any deletion
        // counts as touching.
        const oldMessages = d.view.messages;
        let lastUserIndex = -1;
        for (let i = oldMessages.length - 1; i >= 0; i--) {
          if (oldMessages[i]?.role === "user") {
            lastUserIndex = i;
            break;
          }
        }
        const deleted = new Set(ids);
        const touchesLastTurn =
          lastUserIndex === -1 ||
          oldMessages.some((m, i) => i >= lastUserIndex && deleted.has(m.id));

        return {
          ...d,
          view: {
            ...d.view,
            messages: [...agent.getMessages()],
            messageUsages,
            lastTurnUsage: touchesLastTurn
              ? undefined
              : d.view.lastTurnUsage,
            lastStepInputTokens: touchesLastTurn
              ? undefined
              : d.view.lastStepInputTokens,
          },
        };
      });
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
      send: async (worldId, conversationId, content, modelResolver, onPersistError, autoTitle, imageInputSupportedResolver) => {
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

        // ADR-0044 §D9 step 2 — resolve the bound model's vision capability
        // PER-SEND (live resolution, ADR-0023): switching models between
        // turns just works. `undefined` (unknown) passes image parts
        // through unchanged; only a catalog-confirmed `false` downgrades.
        const imageInputSupported = imageInputSupportedResolver(
          data.conversation.agentConfigName,
        );

        // One event path for BOTH user sends and subagent runs (ADR-0050
        // D3): the shared run driver (`driveRun`, defined above the action
        // map) owns the running-state patch, the streaming batch buffer,
        // handleEvent, and run finalization. The subagent dispatch runtime
        // drives child runs through the same function — the drill-in UI
        // reads the child slot's live stream exactly like a user
        // conversation's.
        driveRun(worldId, conversationId, agent, content, {
          imageInputSupported,
          autoTitle,
        });
      },

      // ── deleteMessage (ADR-0047) ──
      deleteMessage: async (worldId, conversationId, messageId) => {
        const resolved = resolveMutableRuntime(worldId, conversationId);
        if (!resolved) return;
        const { data, agent } = resolved;

        const ids = expandDeleteIds(data.view.messages, messageId);
        if (ids === null) {
          logger.warn("chat.message_mutation.target_not_found", {
            conversation_id: conversationId,
            message_id: messageId,
          });
          return;
        }

        // Durable-first (ADR-0047): the DB rows go BEFORE the in-memory
        // thread. On throw, memory is NOT mutated — the error propagates so
        // the hook caller can toast.
        await deleteMessagesIpc(spaceId, worldId as WorldId, {
          conversationId: conversationId as ConversationId,
          ids,
        });

        // TOCTOU re-check: a `send` may have started inside the IPC
        // window. The durable delete stands, but the in-memory removal
        // is skipped — never mutate the Agent thread mid-run (ADR-0047
        // §7). Memory converges with the DB on the next runtime resolve.
        if (runStartedMeanwhile(worldId, conversationId)) {
          logger.warn("chat.message_mutation.memory_skip", {
            reason: "run_started_mid_delete",
            conversation_id: conversationId,
            count: ids.length,
          });
          return;
        }

        applyMemoryRemoval(worldId, conversationId, agent, ids);
        logger.info("chat.message_mutation.deleted", {
          conversation_id: conversationId,
          count: ids.length,
        });
      },

      // ── editMessage (ADR-0047 — in-place edit, nothing is re-run) ──
      editMessage: async (
        worldId,
        conversationId,
        messageId,
        partIndex,
        newText,
      ): Promise<boolean> => {
        const resolved = resolveMutableRuntime(worldId, conversationId);
        if (!resolved) return false;
        const { data, agent } = resolved;

        const original = data.view.messages.find((m) => m.id === messageId);
        if (!original) {
          logger.warn("chat.message_mutation.target_not_found", {
            conversation_id: conversationId,
            message_id: messageId,
          });
          return false;
        }

        // In-memory replacement (hydrated shape — data-URL file parts).
        const nextInMemory = replaceMessageText(original, partIndex, newText);
        if (!nextInMemory) {
          logger.warn("chat.message_mutation.target_not_found", {
            reason: "not_editable",
            conversation_id: conversationId,
            message_id: messageId,
          });
          return false;
        }

        // Durable-first RAW-BODY surgery. The persisted row's `body`
        // carries `attachment://` refs the hydrated in-memory copy no
        // longer has (ADR-0044 sidecar hydration), so the body to persist
        // is computed against the RAW row: same pure function, same
        // targeting, opaque file-part data passes through untouched.
        const rawRows = await loadMessagesIpc(
          spaceId,
          worldId as WorldId,
          conversationId as ConversationId,
        );
        // TOCTOU re-check (pre-write): a `send` that started during the
        // read makes the whole edit a clean no-op — nothing durable has
        // happened yet, so bail before writing.
        if (runStartedMeanwhile(worldId, conversationId)) {
          logger.warn("chat.message_mutation.rejected", {
            reason: "run_started_mid_edit",
            conversation_id: conversationId,
          });
          return false;
        }
        const rawRow = rawRows.find((row) => row.id === messageId);
        if (!rawRow) {
          // Memory/DB drift — the view has the message but the DB does
          // not. Never write memory ahead of a missing durable row.
          logger.warn("chat.message_mutation.target_not_found", {
            reason: "raw_row_missing",
            conversation_id: conversationId,
            message_id: messageId,
          });
          return false;
        }
        // Boundary cast: `body` is the persisted ModelMessage JSON, typed
        // `unknown` at the types layer (same justification as the
        // TauriSessionStore boundary cast — the runtime layer owns the
        // narrowing).
        const rawPseudo: SessionMessage = {
          ...(rawRow.body as ModelMessage),
          id: rawRow.id,
          sessionId: conversationId,
          createdAt: rawRow.createdAt,
        };
        const nextRaw = replaceMessageText(rawPseudo, partIndex, newText);
        if (!nextRaw) {
          logger.warn("chat.message_mutation.target_not_found", {
            reason: "not_editable",
            conversation_id: conversationId,
            message_id: messageId,
          });
          return false;
        }

        // On throw: memory untouched, rethrow (the hook caller toasts).
        // The pseudo session envelope is stripped — only `{role, content}`
        // is the persisted body.
        await updateMessageIpc(spaceId, worldId as WorldId, {
          conversationId: conversationId as ConversationId,
          id: messageId,
          body: { role: nextRaw.role, content: nextRaw.content },
        });

        // TOCTOU re-check (post-write): the durable edit is committed.
        // If a run slipped into the write window, skip the in-memory
        // swap — never mutate the Agent thread mid-run (ADR-0047 §7).
        // Memory converges with the DB on the next runtime resolve.
        if (runStartedMeanwhile(worldId, conversationId)) {
          logger.warn("chat.message_mutation.memory_skip", {
            reason: "run_started_mid_edit",
            conversation_id: conversationId,
          });
          return true;
        }

        // The id existed in step 2, so this must succeed; a false means
        // view/agent drift (defensive — logged, nothing else to undo: the
        // durable edit is already committed).
        if (!agent.replaceMessage(messageId, nextInMemory)) {
          logger.warn("chat.message_mutation.target_not_found", {
            reason: "agent_thread_drift",
            conversation_id: conversationId,
            message_id: messageId,
          });
          return false;
        }

        // Content edits don't change token accounting: `messageUsages` is
        // untouched (usage columns preserved by the Rust command) and
        // `lastTurnUsage` too.
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: {
            ...d.view,
            messages: [...agent.getMessages()],
          },
        }));
        logger.info("chat.message_mutation.edited", {
          conversation_id: conversationId,
          entity_id: messageId,
        });
        return true;
      },

      // ── abort ──
      abort: (worldId, conversationId) => {
        // Idempotent — AgentRunHandle.abort no-ops if already settled. The
        // SUBAGENT_STOP_REASON string marks user-initiated stops: when the
        // target is a subagent run's slot (the Unit D Stop button path),
        // the dispatch runtime's source listener maps it to status
        // "stopped", while parent-cascade aborts (which abort the child
        // reason-less) map to "aborted" (ADR-0050 D4). Harmless elsewhere —
        // the reason only rides the abort event.
        getData(get(), worldId, conversationId)?.runHandle?.abort(
          SUBAGENT_STOP_REASON,
        );
      },

      // ── setDraft ──
      setDraft: (worldId, conversationId, text) => {
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: { ...d.view, draft: text },
        }));
      },

      // ── addDraftAttachments ──
      addDraftAttachments: (worldId, conversationId, items) => {
        patchData(worldId, conversationId, (d) => {
          const current = d.view.draftAttachments;
          // Count cap backstop (plan D6): keep at most
          // MAX_DRAFT_ATTACHMENTS total; overflow items are IGNORED — the
          // UI pre-validates, so this branch is purely defensive. `d` is
          // returned unchanged when there is no room, so zustand sees the
          // same data reference and skips the re-render.
          const room = MAX_DRAFT_ATTACHMENTS - current.length;
          if (room <= 0 || items.length === 0) return d;
          const accepted = items.slice(0, room);
          return {
            ...d,
            view: {
              ...d.view,
              draftAttachments: [...current, ...accepted],
            },
          };
        });
      },

      // ── removeDraftAttachment ──
      removeDraftAttachment: (worldId, conversationId, id) => {
        patchData(worldId, conversationId, (d) => ({
          ...d,
          view: {
            ...d.view,
            draftAttachments: d.view.draftAttachments.filter(
              (a) => a.id !== id,
            ),
          },
        }));
      },

      // ── removeConversation ──
      removeConversation: (worldId, conversationId) => {
        /** True for hidden subagent run slots parented by `conversationId`. */
        const isChildRunOf = (d: ConversationRuntimeData): boolean =>
          d.conversation.meta.kind === "subagent" &&
          d.conversation.meta.parentConversationId === conversationId;
        // Abort any in-flight run BEFORE dropping the slot, so the pending
        // result.then() finds no data and no-ops. Hidden child run slots go
        // with the parent: Rust's delete_conversation now cascades the
        // hidden run rows (F4-Rust), and the in-memory map must stay
        // consistent with the DB — a stale slot would linger as a drill-in
        // ghost. Aborting the children is defensive (the dispatch cascade
        // normally settles them before the parent can be deleted).
        for (const d of get().worlds.get(worldId)?.values() ?? []) {
          if (isChildRunOf(d)) d.runHandle?.abort();
        }
        getData(get(), worldId, conversationId)?.runHandle?.abort();
        set((state) => {
          const worldMap = state.worlds.get(worldId);
          if (!worldMap) return {};
          const newWorldMap = new Map(worldMap);
          for (const [id, d] of worldMap) {
            if (isChildRunOf(d)) newWorldMap.delete(id);
          }
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
        resolveApprovalInSlot(worldId, conversationId, toolCallId, approved);
      },

      // ── approveAllForRun (ADR-0050 D5) ──
      approveAllForRun: (worldId, runId) => {
        const pending = getData(get(), worldId, runId)?.view.stream?.pendingApprovals;
        if (!pending) return;
        // Snapshot the keys first: each resolution patches the record, and
        // approvals that land mid-loop are NOT auto-approved (the next
        // gesture picks them up — same one-shot semantics as the banner's
        // approve-all).
        for (const toolCallId of Object.keys(pending)) {
          resolveApprovalInSlot(worldId, runId, toolCallId, true);
        }
      },
    };
  });
}
