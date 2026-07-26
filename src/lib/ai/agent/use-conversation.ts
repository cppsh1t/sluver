/**
 * `useConversation` — React hook that wraps a {@link ToolLoopAgent} into a
 * streaming, UI-friendly conversation loop. The counterpart of `useChat`
 * from `@ai-sdk/react`, but built in-tree because sluver deliberately does
 * NOT depend on `@ai-sdk/react` (ADR-0017).
 *
 * Pipeline:
 *
 *     sendMessage(text)
 *       → append user UIMessage
 *       → createAgentUIStream({ agent, uiMessages, abortSignal, onError })
 *       → readUIMessageStream({ stream, onError })   // yields the GROWING assistant msg
 *       → replace last message in state on each yield
 *
 * The hook owns three pieces of state: `messages`, `status`, `error`.
 * `status` distinguishes `idle` / `streaming` / `error` / `aborted` so the
 * UI can render cancel-vs-fail differently (mirrors pi-agent's stopReason
 * hard-stop semantics for `error`/`aborted`, see ADR-0017 references).
 *
 * Error handling philosophy (aligned with pi-agent's three-layer defense
 * documented in docs/pi-agent/第5章 §四):
 *
 * - **Tool execution errors** — handled automatically by AI SDK v7: a
 *   thrown `execute()` becomes a `{ type: 'tool-error' }` part fed back to
 *   the model. The loop continues. This hook does NOT need to wrap tools.
 * - **Stream chunk errors** — surfaced via the `onError` callbacks below.
 *   `createAgentUIStream`'s `onError` returns the raw error message so the
 *   user sees the actual cause (no i18n wrapping, by design — AI errors
 *   are presented verbatim). `readUIMessageStream`'s `onError` is
 *   observer-only and logs at WARN for diagnostics.
 * - **Fatal stream errors / aborts** — caught by the surrounding
 *   try/catch. Abort → `status: "aborted"` (partial assistant message
 *   KEPT, see `stop()` doc). Other errors → `status: "error"` + log at ERROR.
 *
 * Field names in all `logger.*` calls are snake_case per ADR-0016.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAgentUIStream,
  generateId,
  readUIMessageStream,
  type ToolLoopAgent,
  type UIMessage,
} from "ai";

import { logger } from "@/lib/logger";

export type ConversationStatus = "idle" | "streaming" | "error" | "aborted";

/**
 * Result of {@link useConversation.sendMessage}. The hook never throws from
 * `sendMessage` — rejections would leak out of React event handlers and
 * crash the app. Instead, failures land in `status: "error"` + `error`.
 *
 * The sentinel lets callers distinguish "ignored because already streaming"
 * (M4: previously silently swallowed) from "started successfully".
 */
export type SendMessageResult =
  | { ok: true }
  | { ok: false; reason: "streaming" | "no_last_message" | "interrupted" };

export interface UseConversationResult {
  /** Full conversation history (user + assistant messages), in order. */
  messages: UIMessage[];
  /** Current lifecycle state of the loop. */
  status: ConversationStatus;
  /** Set when an unrecoverable error occurred; `null` otherwise. */
  error: Error | null;
  /**
   * Append a user message and stream the assistant reply.
   *
   * Returns `{ ok: false, reason: "streaming" }` if a stream is already in
   * flight — the call is otherwise a no-op, but the caller can surface UX
   * (e.g. shake the input, show a toast) based on the sentinel.
   */
  sendMessage: (text: string) => Promise<SendMessageResult>;
  /**
   * Abort the in-flight stream (if any). Status becomes `"aborted"`.
   *
   * **Partial assistant content is KEPT** in `messages` (M3). This matches
   * pi-agent's design: the user clicked stop, so they probably want to see
   * what was being generated. Call {@link reset} or {@link retry} to clear.
   */
  stop: () => void;
  /**
   * Clear `error`/`aborted` status back to `"idle"` WITHOUT touching
   * `messages`. Use this when the user wants to continue chatting after a
   * failure (rare — typically they want {@link retry} instead).
   */
  clearError: () => void;
  /**
   * Nuclear reset — clear `messages`, `error`, and reset status to
   * `"idle"`. The hook is then in a fresh state as if just mounted.
   */
  reset: () => void;
  /**
   * Pop the last user message + any (partial or complete) assistant reply
   * that came after it, then re-stream using the stored user text. Use to
   * recover from `status: "error"` or `status: "aborted"`.
   *
   * Returns `{ ok: false, reason: "no_last_message" }` if no prior turn
   * exists, or `"streaming"` if a stream is already in flight.
   */
  retry: () => Promise<SendMessageResult>;
}

/**
 * Wrap a {@link ToolLoopAgent} into a streaming conversation hook.
 *
 * Pass a **memoized** agent (`useMemo(() => createAgent(...), [config, opts])`)
 * — `sendMessage`'s identity changes when `agent` changes, which churns
 * downstream `useCallback`/`useMemo` consumers if the agent is recreated
 * every render. An agent swap also aborts any in-flight stream (see M5).
 */
export function useConversation(agent: ToolLoopAgent): UseConversationResult {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  // `messagesRef` is the synchronous source of truth for the async streaming
  // loop. React does NOT guarantee that a `setMessages` updater runs before
  // the next `await`, so we cannot rely on the updater pattern to capture
  // values for use after an await. The ref is updated imperatively alongside
  // every `setMessages` call; `setMessages` itself only triggers re-renders.
  //
  // All mutations to `messagesRef` MUST be mirrored by a `setMessages` call
  // with the same value, or the ref and state will desync (M2).
  const messagesRef = useRef<UIMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  // Last user text — powers `retry()`. `null` when no turn has been sent.
  const lastUserTextRef = useRef<string | null>(null);
  // Generation counter — bumped on agent swap (M5) and unmount (B1). Stale
  // `sendMessage` closures read this after every await and bail silently if
  // the counter has moved on, so they don't write state owned by a newer
  // turn or a different agent.
  const generationRef = useRef(0);

  // Abort in-flight stream when the agent swaps OR the component unmounts.
  // Without this, unmount leaks the stream (B1) and an agent swap leaves an
  // orphan stream on the OLD agent (M5). Runs cleanup before re-running on
  // `agent` change, and again on unmount.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      streamingRef.current = false;
      // Drop status back to idle — without this, an orphan sendMessage takes
      // the stale-catch branch and returns without touching state, leaving
      // `status` stuck at "streaming" indefinitely. `setStatus("idle")` is a
      // no-op when no stream was active (React bails on identical primitives).
      setStatus("idle");
    };
  }, [agent]);

  const sendMessage = useCallback(
    async (text: string): Promise<SendMessageResult> => {
      // Reentrancy guard — return a sentinel rather than silently dropping
      // (M4). The caller can surface UX (input shake, toast) based on this.
      if (streamingRef.current) {
        logger.warn("ai.conversation.send_ignored", { reason: "streaming" });
        return { ok: false, reason: "streaming" };
      }

      const userMessage: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
      };

      // Build the full conversation snapshot synchronously from the ref.
      const nextMessages = [...messagesRef.current, userMessage];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      lastUserTextRef.current = text;

      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;
      const myGeneration = generationRef.current;
      setStatus("streaming");
      setError(null);

      try {
        const stream = await createAgentUIStream({
          agent,
          uiMessages: nextMessages,
          abortSignal: controller.signal,
          // Chunk-level error handler. The SDK's default masks the real
          // cause with "An error occurred." — we instead return the raw
          // message so the user sees what actually went wrong (no i18n
          // wrapping on AI errors, by design). Also log at WARN for
          // diagnostics (H1).
          onError: (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("ai.stream.chunk_error", {
              error_name: err instanceof Error ? err.name : "unknown",
              error_message: message,
            });
            return message;
          },
        });

        // Each yield produces the ever-growing assistant UIMessage. The
        // message id is stable across yields, so we compare ids to decide
        // append-vs-replace — a pure check, no outer mutation needed.
        for await (const assistantMessage of readUIMessageStream({
          stream,
          // Observer-only — logs framing errors (e.g. out-of-sequence
          // chunks) without affecting the loop. Fatal errors still throw
          // from the iterator and hit the catch below.
          onError: (err: unknown) => {
            logger.warn("ai.stream.read_error", {
              error_name: err instanceof Error ? err.name : "unknown",
              error_message: err instanceof Error ? err.message : String(err),
            });
          },
        })) {
          // Stale check — agent swapped or unmounted mid-stream. The
          // cleanup effect already aborted the controller and bumped the
          // generation; bail without touching state owned by the new turn.
          if (myGeneration !== generationRef.current) {
            return { ok: false, reason: "interrupted" };
          }
          const prev = messagesRef.current;
          const last = prev[prev.length - 1];
          const updated =
            last && last.id === assistantMessage.id
              ? [...prev.slice(0, -1), assistantMessage]
              : [...prev, assistantMessage];
          messagesRef.current = updated;
          setMessages(updated);
        }

        if (myGeneration === generationRef.current) {
          setStatus("idle");
        }
      } catch (err) {
        // Stale — newer sendMessage or agent swap owns state now. The
        // abort fired by cleanup will land here; bail without overwriting.
        if (myGeneration !== generationRef.current) {
          return { ok: false, reason: "interrupted" };
        }

        // User-initiated abort → status "aborted" (NOT "error"). Partial
        // assistant content is intentionally kept (M3, see `stop()` doc).
        const isAbort =
          controller.signal.aborted ||
          (err as { name?: string } | null)?.name === "AbortError";
        if (isAbort) {
          setStatus("aborted");
          logger.info("ai.conversation.aborted", {
            message_count: messagesRef.current.length,
          });
          return { ok: true };
        }

        const normalized = err instanceof Error ? err : new Error(String(err));
        setStatus("error");
        setError(normalized);
        logger.error("ai.stream.failed", {
          error_name: normalized.name,
          error_message: normalized.message,
        });
      } finally {
        // Only release the lock if we still own the current generation.
        // A stale turn leaves the new turn's setup to manage these refs.
        if (myGeneration === generationRef.current) {
          streamingRef.current = false;
          abortRef.current = null;
        }
      }

      return { ok: true };
    },
    [agent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearError = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  const reset = useCallback(() => {
    // Bump generation FIRST — the orphan sendMessage's catch path will then
    // take the stale branch and bail without overwriting the state we're
    // about to clear. Without this, the catch's `setStatus("aborted")` runs
    // after our `setStatus("idle")` and wins.
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    messagesRef.current = [];
    lastUserTextRef.current = null;
    setMessages([]);
    setStatus("idle");
    setError(null);
  }, []);

  const retry = useCallback(async (): Promise<SendMessageResult> => {
    if (streamingRef.current) {
      return { ok: false, reason: "streaming" };
    }
    const text = lastUserTextRef.current;
    if (text === null) {
      return { ok: false, reason: "no_last_message" };
    }

    // Pop trailing assistant messages (including any partial reply from an
    // aborted/error turn), then the user message we're retrying. The ref
    // and state stay in sync because we mutate both with the same value.
    const msgs = [...messagesRef.current];
    while (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
      msgs.pop();
    }
    if (msgs.length > 0 && msgs[msgs.length - 1].role === "user") {
      msgs.pop();
    }
    messagesRef.current = msgs;
    setMessages(msgs);

    // `sendMessage` will re-stamp `lastUserTextRef` to the same value and
    // re-attach the user message at the end of the trimmed list.
    return sendMessage(text);
  }, [sendMessage]);

  return { messages, status, error, sendMessage, stop, clearError, reset, retry };
}
