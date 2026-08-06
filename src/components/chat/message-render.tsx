/**
 * Message rendering model — flattens persisted `SessionMessage[]` plus a live
 * `StreamState` into a single ordered list of UI blocks.
 *
 * The conversation view consumes {@link buildBlocks} and renders each block by
 * its `kind` discriminator. Keeping the flattening pure (no React) makes the
 * render pass trivial to reason about and test-friendly.
 *
 * ## Block ordering
 *
 * 1. Persisted `messages` (oldest → newest), with `tool`-role messages folded
 *    into the preceding assistant tool-call cards (their `tool-result` parts
 *    are matched by `toolCallId` and attached as the card's output).
 * 2. An optimistic user block for the in-flight turn (the runtime appends the
 *    user message to the Agent thread on `send`, but the reactive
 *    `view.messages` only refreshes on run finalization — this block bridges
 *    that gap so the user sees their message immediately).
 * 3. The live `stream` region: step label, reasoning, tool calls, streaming
 *    assistant text.
 *
 * ## Why defensive content handling
 *
 * `ModelMessage.content` is a discriminated union from the AI SDK v7 — either a
 * plain string or an array of typed parts. Persisted messages round-trip
 * through SQLite JSON, so every part access narrows on `part.type` and falls
 * back gracefully on unrecognized shapes.
 */

import type { PendingApproval, StreamState, ToolCallView } from "@/lib/conversation-runtime";
import type { MessageUsage } from "@/lib/conversation-runtime/store";
import type { LanguageModelUsage, ModelMessage, SessionMessage } from "@/lib/ai";
// ─── Block model ──────────────────────────────────────────────────────────

/** Unified data shape for a single tool card (persisted or live). */
export interface ToolBlockData {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly inputDraft?: string;
  readonly status: "running" | "done" | "error";
  readonly output: unknown;
  readonly error: { code: string; message: string } | null;
  /** Present when this tool call is awaiting user approval. */
  readonly pendingApproval?: PendingApproval;
}

/**
 * Persisted token-usage footer attached beneath an assistant message that
 * carries usage (ADR-0030). Emitted only for the turn's last assistant row —
 * user / tool / non-last-assistant messages have no usage entry and get no
 * footer.
 *
 * `inputTokens` / `outputTokens` come from `view.messageUsages[messageId]`
 * (persisted). `null` ⇒ "provider reported unknown" and renders as an em-dash;
 * `0` ⇒ "real zero" and renders as `0` (ADR-0030 §4 — the distinction must
 * survive end to end).
 *
 * `cacheReadTokens` / `cacheWriteTokens` are populated ONLY for the most
 * recent assistant message AND only when `view.lastTurnUsage` is present
 * (ephemeral, not persisted — ADR-0030 §5). Historical assistant footers omit
 * them, so no cache annotation is shown for past turns.
 */
export interface TokenFooterBlock {
  readonly kind: "token-footer";
  readonly id: string;
  readonly messageId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Cache-read tokens; only on the last assistant of a finalized turn. */
  readonly cacheReadTokens?: number;
  /** Cache-write tokens (Anthropic); only on the last assistant. */
  readonly cacheWriteTokens?: number;
}

/**
 * The discriminated union of renderable blocks. `id` is stable per block so
 * React can key a list without index fallbacks.
 */
export type RenderBlock =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly optimistic?: boolean }
  | { readonly kind: "assistant-text"; readonly id: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly live: boolean }
  | { readonly kind: "tool"; readonly id: string; readonly tool: ToolBlockData }
  | { readonly kind: "step"; readonly id: string; readonly n: number }
  | TokenFooterBlock
  | { readonly kind: "stopped"; readonly id: string };

// ─── Content part narrowing (defensive) ───────────────────────────────────

interface TextPartLike {
  readonly type: "text";
  readonly text: string;
}
interface ReasoningPartLike {
  readonly type: "reasoning";
  readonly text: string;
}
interface ToolCallPartLike {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
}
interface ToolResultPartLike {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly output?: unknown;
}

type ContentPart =
  | TextPartLike
  | ReasoningPartLike
  | ToolCallPartLike
  | ToolResultPartLike
  | { readonly type: string; readonly [key: string]: unknown };

/** `ModelMessage.content` is `string | ContentPart[]` (or the SDK union). */
type Content = ModelMessage["content"];

/** True if the content is a string form (not a parts array). */
function isStringContent(content: Content): content is string {
  return typeof content === "string";
}

/** Coerce an opaque content into a best-effort parts array. */
function asParts(content: Content): readonly ContentPart[] {
  return Array.isArray(content) ? (content as readonly ContentPart[]) : [];
}

/**
 * Extract the plain text of a message — joins `text` parts for assistant/user
 * messages, returns the raw string for string content. Used for user bubbles
 * and as a fallback.
 */
export function messageText(message: ModelMessage): string {
  const { content } = message;
  if (isStringContent(content)) return content;
  return asParts(content)
    .filter((p): p is TextPartLike => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ─── Formatting helpers (for tool cards) ──────────────────────────────────

/**
 * Normalize an AI-SDK tool-result `output` (which is itself a discriminated
 * `{type:'text'|'json'|'image'|...}` shape) into a display string. Falls back
 * to JSON for anything unrecognized.
 */
export function formatToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  // AI SDK ToolResultOutput shapes.
  if (typeof output === "object" && "type" in output) {
    const o = output as { type: string; value?: unknown };
    if (o.type === "text" && typeof o.value === "string") return o.value;
    if (o.type === "json") return safeStringify(o.value);
    // image / binary / etc. — show a placeholder rather than binary noise.
    if (o.type === "image" || o.type === "file") return `(${o.type} output)`;
  }
  return safeStringify(output);
}

/** Pretty JSON for unknown tool inputs; raw string passthrough otherwise. */
export function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return safeStringify(input);
}

/** `JSON.stringify` with indentation that never throws on cycles. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ─── Block construction ───────────────────────────────────────────────────

/**
 * Flatten a message thread into render blocks, folding `tool`-role messages
 * into the preceding assistant tool-call cards.
 *
 * A pre-pass scans every message for `tool-result` parts and builds a lookup
 * by `toolCallId`. Assistant `tool-call` parts then resolve their output from
 * that lookup; standalone `tool`-role messages are skipped (already consumed).
 *
 * A token-usage footer (ADR-0030) is appended after any assistant message
 * that carries an entry in `messageUsages`. The cache-read / cache-write
 * annotation is attached only to the turn's last assistant message, and only
 * when `lastTurnUsage` is present (ephemeral — see {@link TokenFooterBlock}).
 */
function blocksForMessages(
  messages: readonly SessionMessage[],
  messageUsages: Record<string, MessageUsage>,
  lastAssistantId: string | null,
  lastTurnUsage: LanguageModelUsage | undefined,
): RenderBlock[] {
  // Pre-pass: toolCallId → result output (scan tool-role msgs + any stray
  // tool-result parts on assistant messages).
  const results = new Map<string, unknown>();
  for (const msg of messages) {
    if (isStringContent(msg.content)) continue;
    for (const part of asParts(msg.content)) {
      if (part.type === "tool-result") {
        const tr = part as ToolResultPartLike;
        results.set(tr.toolCallId, tr.output);
      }
    }
  }

  const blocks: RenderBlock[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // System messages are never shown in the chat surface.
        continue;
      case "user": {
        blocks.push({
          kind: "user",
          id: msg.id,
          text: messageText(msg),
        });
        continue;
      }
      case "assistant": {
        if (isStringContent(msg.content)) {
          if (msg.content.length > 0) {
            blocks.push({
              kind: "assistant-text",
              id: msg.id,
              text: msg.content,
              streaming: false,
            });
          }
        } else {
          for (const part of asParts(msg.content)) {
            if (part.type === "text") {
              const tp = part as TextPartLike;
              if (tp.text.length > 0) {
                blocks.push({
                  kind: "assistant-text",
                  id: `${msg.id}#text-${blocks.length}`,
                  text: tp.text,
                  streaming: false,
                });
              }
            } else if (part.type === "reasoning") {
              const rp = part as ReasoningPartLike;
              if (rp.text.length > 0) {
                blocks.push({
                  kind: "reasoning",
                  id: `${msg.id}#reasoning-${blocks.length}`,
                  text: rp.text,
                  live: false,
                });
              }
            } else if (part.type === "tool-call") {
              const tc = part as ToolCallPartLike;
              blocks.push({
                kind: "tool",
                id: `${msg.id}#tool-${tc.toolCallId}`,
                tool: {
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  input: tc.input,
                  status: results.has(tc.toolCallId) ? "done" : "running",
                  output: results.get(tc.toolCallId) ?? null,
                  error: null,
                },
              });
            }
            // tool-result parts on an assistant message are folded into cards
            // above; other part types are ignored gracefully.
          }
        }
        // Token-usage footer (ADR-0030). Only the turn's last assistant row
        // carries an entry in `messageUsages`; absence ⇒ no footer. Cache
        // breakdown is ephemeral (§5) — only the last assistant, only when
        // `lastTurnUsage` is live.
        const usage = messageUsages[msg.id];
        if (usage) {
          const details =
            msg.id === lastAssistantId
              ? lastTurnUsage?.inputTokenDetails
              : undefined;
          blocks.push({
            kind: "token-footer",
            id: `${msg.id}#usage`,
            messageId: msg.id,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(details?.cacheReadTokens !== undefined
              ? { cacheReadTokens: details.cacheReadTokens }
              : {}),
            ...(details?.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: details.cacheWriteTokens }
              : {}),
          });
        }
        continue;
      }
      case "tool":
        // Folded into the preceding assistant tool-call cards via the
        // results lookup. Nothing to render directly.
        continue;
      default:
        continue;
    }
  }
  return blocks;
}

/** Convert a live {@link ToolCallView} into a {@link ToolBlockData}. */
function toolBlockFromLive(
  tc: ToolCallView,
  pendingApproval?: PendingApproval,
): ToolBlockData {
  return {
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: tc.input,
    inputDraft: tc.inputDraft,
    status: tc.status,
    output: tc.output,
    error: tc.error,
    pendingApproval,
  };
}

/**
 * Build the complete ordered block list for the conversation view.
 *
 * @param messages  persisted thread (oldest → newest).
 * @param stream    live stream state, or `null` when idle.
 * @param isRunning whether a run is in flight (gates the streaming cursor).
 * @param pendingUserText optimistic user text for the in-flight turn; shown
 *   only when no matching user message is already present in `messages`.
 * @param stopReason why the most recent run ended, when user-visible
 *   (`"aborted"`). Drives the "Stopped" marker both in the live-stream window
 *   (even when partial text exists) and after finalization (when the stream is
 *   gone but the persisted partial message remains).
 * @param messageUsages persisted per-message token usage (ADR-0030). Drives
 *   the `token-footer` block beneath assistant messages that carry an entry.
 * @param lastTurnUsage ephemeral usage for the most recent finalized turn
 *   (ADR-0030 §5/§6). Supplies the cache-read / cache-write annotation
 *   attached to the turn's last assistant message; `undefined` between turns
 *   and on first load ⇒ historical footers render without the cache paren.
 */
export function buildBlocks(
  messages: readonly SessionMessage[],
  stream: StreamState | null,
  isRunning: boolean,
  pendingUserText: string | null,
  stopReason: "aborted" | null = null,
  messageUsages: Record<string, MessageUsage> = {},
  lastTurnUsage?: LanguageModelUsage,
): RenderBlock[] {
  // Last persisted assistant id — gates which footer (if any) gets the
  // ephemeral cache annotation. Reverse scan; `null` when there is none.
  let lastAssistantId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantId = messages[i].id;
      break;
    }
  }

  const blocks = blocksForMessages(
    messages,
    messageUsages,
    lastAssistantId,
    lastTurnUsage,
  );

  // Optimistic user echo for the in-flight turn. The runtime appends the user
  // message to the Agent thread on send but `view.messages` only refreshes on
  // finalization, so without this the user's message vanishes while streaming.
  if (pendingUserText) {
    const alreadyShown = messages.some(
      (m) => m.role === "user" && messageText(m) === pendingUserText,
    );
    if (!alreadyShown) {
      blocks.push({
        kind: "user",
        id: "__pending_user__",
        text: pendingUserText,
        optimistic: true,
      });
    }
  }

  if (stream) {
    // Live region — render segments in TRUE ARRIVAL ORDER so a tool called
    // after some text appears BELOW that text (not above all text). The
    // chronological order is preserved by `handleEvent` in the store.
    let hasContent = false;
    for (const seg of stream.segments) {
      switch (seg.kind) {
        case "step":
          blocks.push({
            kind: "step",
            id: `__step_${seg.stepNumber}__`,
            n: seg.stepNumber + 1,
          });
          break;
        case "reasoning":
          if (seg.text.length > 0) {
            blocks.push({
              kind: "reasoning",
              id: `__live_reasoning_${seg.stepNumber}__`,
              text: seg.text,
              live: true,
            });
          }
          break;
        case "text":
          if (seg.text.length > 0) {
            hasContent = true;
            // Cursor is flipped on only for the LAST assistant-text block
            // after the loop (see below).
            blocks.push({
              kind: "assistant-text",
              id: `__live_text_${seg.stepNumber}__`,
              text: seg.text,
              streaming: false,
            });
          }
          break;
        case "tool":
          hasContent = true;
          blocks.push({
            kind: "tool",
            id: `__live_tool_${seg.toolCallId}__`,
            tool: toolBlockFromLive(seg, stream.pendingApprovals[seg.toolCallId]),
          });
          break;
      }
    }
    // Blinking cursor lands on the LAST assistant-text block while the run
    // is live — there can be more than one (text → tool → more text).
    if (isRunning) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.kind === "assistant-text") {
          blocks[i] = { ...block, streaming: true };
          break;
        }
      }
    }
    // Abort window: show "Stopped" when the run ended without producing any
    // text/tool content, OR when it was explicitly aborted (stopReason set) —
    // in the latter case partial text may exist, and the marker should still
    // appear below it.
    if (!isRunning && (!hasContent || stopReason === "aborted")) {
      blocks.push({ kind: "stopped", id: "__stopped__" });
    }
  } else if (stopReason === "aborted") {
    // Finalized abort: the live stream is gone but the run was aborted. The
    // persisted partial assistant message (salvaged by the loop) is already in
    // `blocks` via blocksForMessages; append the marker so the user can tell
    // the response was cut short.
    blocks.push({ kind: "stopped", id: "__stopped__" });
  }

  return blocks;
}
