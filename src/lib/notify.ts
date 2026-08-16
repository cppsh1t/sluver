/**
 * Native OS notification helpers (Rust-side notify-rust — ADR-0036).
 *
 * Fire-and-forget by design: callers `void` these promises — the consent
 * gate (ADR-0025) must never block on the OS. The function is no-throw;
 * failures reject with an ErrorPayload from the `show_notification`
 * command and surface as WARN logs only.
 *
 * Burst coalescing is PER CONVERSATION: parallel tool calls in one LLM
 * step each request consent, which used to fire N simultaneous OS
 * toasts. Requests are buffered in a Map keyed by conversationId, each
 * conversation with its own trailing debounce (~1500 ms, restarted on
 * each arrival in that conversation). Each conversation's burst
 * flushes independently into ONE `show_notification` call: a single
 * request (N=1) shows the per-tool body; N>1 shows a count-based body
 * (`toolConsentBodyMulti`). Bursts from different conversations never
 * merge, so the toast and its log line always attribute the right ids
 * and count.
 *
 * Strings come from the GLOBAL `i18n.t` (async non-render context — the
 * hook `t` is for JSX render bodies only, per AGENTS.md). Redaction
 * policy: only ids + tool_name are ever logged — tool input/args may
 * contain user creative content.
 */

import { call } from "@/api/client";
import i18n from "@/i18n";
import { logger } from "@/lib/logger";

interface ToolConsentRequest {
  worldId: string;
  conversationId: string;
  toolName: string;
}

/** Trailing-debounce window over which burst consent requests coalesce. */
const TOOL_CONSENT_DEBOUNCE_MS = 1500;

/** Per-conversation coalescing queue: buffered requests + that queue's timer. */
interface ToolConsentQueue {
  requests: ToolConsentRequest[];
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Module-level pending queues keyed by conversationId (globally unique
 * UUID v7, so no worldId disambiguation is needed). One timer per
 * conversation; the entry is deleted when its timer fires.
 */
const toolConsentQueues = new Map<string, ToolConsentQueue>();

/**
 * Notify the user via the OS that a tool call is awaiting consent.
 *
 * Enqueues the request into its conversation's queue; the actual
 * notification is sent by `flushToolConsents()` once that
 * conversation's debounce window closes. Resolves immediately after
 * enqueueing and never rejects.
 */
export async function notifyToolConsentRequested(args: {
  worldId: string;
  conversationId: string;
  toolName: string;
}): Promise<void> {
  let queue = toolConsentQueues.get(args.conversationId);
  if (queue === undefined) {
    queue = { requests: [] };
    toolConsentQueues.set(args.conversationId, queue);
  }
  queue.requests.push(args);
  if (queue.timer !== undefined) {
    clearTimeout(queue.timer);
  }
  queue.timer = setTimeout(() => {
    // Delete BEFORE flushing so a later burst in this conversation
    // starts a fresh debounce window instead of mutating the flushed
    // queue.
    toolConsentQueues.delete(args.conversationId);
    void flushToolConsents(queue.requests);
  }, TOOL_CONSENT_DEBOUNCE_MS);
}

/**
 * Send ONE coalesced notification for a single conversation's burst.
 * No-throw: failures surface as WARN logs only.
 */
async function flushToolConsents(batch: ToolConsentRequest[]): Promise<void> {
  if (batch.length === 0) return;

  const first = batch[0];
  const isSingle = batch.length === 1;
  try {
    await call("show_notification", {
      title: i18n.t("chat:notification.toolConsentTitle"),
      body: isSingle
        ? i18n.t("chat:notification.toolConsentBody", {
            tool: first.toolName,
          })
        : i18n.t("chat:notification.toolConsentBodyMulti", {
            count: batch.length,
          }),
    });
    logger.info("notify.tool_consent.sent", {
      world_id: first.worldId,
      conversation_id: first.conversationId,
      ...(isSingle ? { tool_name: first.toolName } : {}),
      tool_count: batch.length,
    });
  } catch (e) {
    logger.warn("notify.tool_consent.failed", {
      world_id: first.worldId,
      conversation_id: first.conversationId,
      error: String(e),
    });
  }
}
