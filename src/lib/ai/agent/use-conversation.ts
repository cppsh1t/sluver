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
 *       → createAgentUIStream({ agent, uiMessages, abortSignal })
 *       → readUIMessageStream({ stream })   // yields the GROWING assistant msg
 *       → replace last message in state on each yield
 *
 * The hook owns three pieces of state: `messages`, `status`, `error`.
 * The currently-active AbortController lives in a ref so `stop()` can
 * cancel an in-flight stream.
 */
import { useCallback, useRef, useState } from "react";
import {
  createAgentUIStream,
  generateId,
  readUIMessageStream,
  type ToolLoopAgent,
  type UIMessage,
} from "ai";

export type ConversationStatus = "idle" | "streaming" | "error";

export interface UseConversationResult {
  /** Full conversation history (user + assistant messages), in order. */
  messages: UIMessage[];
  /** Current lifecycle state of the loop. */
  status: ConversationStatus;
  /** Set when an unrecoverable error occurred; `null` otherwise. */
  error: Error | null;
  /** Append a user message and stream the assistant reply. No-op if already streaming. */
  sendMessage: (text: string) => Promise<void>;
  /** Abort the in-flight stream (if any). Status returns to "idle". */
  stop: () => void;
}

/**
 * Wrap a {@link ToolLoopAgent} into a streaming conversation hook.
 *
 * Pass a **memoized** agent (`useMemo(() => createAgent(...), [config, opts])`)
 * — `sendMessage`'s identity changes when `agent` changes, which churns
 * downstream `useCallback`/`useMemo` consumers if the agent is recreated
 * every render.
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
  const messagesRef = useRef<UIMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const sendMessage = useCallback(
    async (text: string) => {
      // Reentrancy guard — ignore calls while a stream is in flight.
      if (streamingRef.current) return;

      const userMessage: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
      };

      // Build the full conversation snapshot synchronously from the ref.
      const nextMessages = [...messagesRef.current, userMessage];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);

      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;
      setStatus("streaming");
      setError(null);

      try {
        const stream = await createAgentUIStream({
          agent,
          uiMessages: nextMessages,
          abortSignal: controller.signal,
        });

        // Each yield produces the ever-growing assistant UIMessage. The
        // message id is stable across yields, so we compare ids to decide
        // append-vs-replace — a pure check, no outer mutation needed.
        for await (const assistantMessage of readUIMessageStream({ stream })) {
          const prev = messagesRef.current;
          const last = prev[prev.length - 1];
          const updated =
            last && last.id === assistantMessage.id
              ? [...prev.slice(0, -1), assistantMessage]
              : [...prev, assistantMessage];
          messagesRef.current = updated;
          setMessages(updated);
        }

        setStatus("idle");
      } catch (err) {
        // User-initiated abort → return to idle, NOT error.
        const isAbort =
          controller.signal.aborted ||
          (err as { name?: string } | null)?.name === "AbortError";
        if (isAbort) {
          setStatus("idle");
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        streamingRef.current = false;
        abortRef.current = null;
      }
    },
    [agent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, status, error, sendMessage, stop };
}
