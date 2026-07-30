/**
 * Composer — the message input for one conversation.
 *
 * Consumes the runtime hooks for the draft (`useDraft`), send (`useSend`),
 * abort (`useAbort`), and the running flag (`useConversationView`). Enter
 * sends, Shift+Enter inserts a newline. While a run is in flight the send
 * button becomes a stop button.
 *
 * On send the composer clears the draft and notifies the parent via
 * `onUserSent` so the view can render an optimistic echo (the runtime appends
 * the user message to the Agent thread immediately, but `view.messages` only
 * refreshes on run finalization).
 */

import { useCallback, useTransition, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { Sent02Icon, StopCircleIcon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useAbort,
  useConversationView,
  useDraft,
  useSend,
} from "@/lib/conversation-runtime";
import { cn } from "@/lib/utils";
import type { ConversationId, WorldId } from "@/types";

interface ComposerProps {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  /** Called with the just-sent text so the view can echo it optimistically. */
  readonly onUserSent: (text: string) => void;
}

export function Composer({
  worldId,
  conversationId,
  onUserSent,
}: ComposerProps) {
  const { t } = useTranslation("chat");
  const [draft, setDraft] = useDraft(worldId, conversationId);
  const send = useSend(worldId);
  const abort = useAbort(worldId);
  const { view } = useConversationView(worldId, conversationId);
  const isRunning = view.isRunning;

  // Wrap send in a transition so the input stays responsive while the store
  // kicks off the (async) run; the optimistic echo is set synchronously.
  const [pending, startTransition] = useTransition();

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !isRunning && !pending;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const text = trimmed;
    setDraft("");
    onUserSent(text);
    startTransition(async () => {
      await send(conversationId, text);
    });
  }, [canSend, trimmed, setDraft, onUserSent, send, conversationId]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (or IME composition) inserts a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border bg-background/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        <div
          className={cn(
            "flex items-end gap-2 rounded-xl border border-input bg-input/20 px-2 py-1.5",
            "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
          )}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("chat:composer.placeholder")}
            rows={1}
            aria-label={t("chat:composer.placeholder")}
            className="max-h-40 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          {isRunning ? (
            <Button
              variant="outline"
              size="icon"
              onClick={() => abort(conversationId)}
              aria-label={t("chat:composer.stop")}
            >
              <HugeiconsIcon icon={StopCircleIcon} strokeWidth={2} />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!canSend}
              aria-label={t("chat:composer.send")}
            >
              <HugeiconsIcon icon={Sent02Icon} strokeWidth={2} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
