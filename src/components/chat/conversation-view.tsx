/**
 * Conversation view — renders the persisted thread plus the live stream for
 * one conversation, with auto-scroll, error/loading/empty states.
 *
 * Consumes the runtime hooks:
 * - {@link useEnsureRuntime} — lazily constructs the Agent + loads history.
 * - {@link useConversationView} — the reactive `view` + `agentLoading`.
 *
 * The optimistic `pendingUserText` prop bridges the gap between `send` (which
 * appends the user message to the Agent thread immediately) and run
 * finalization (which is when `view.messages` finally refreshes). It is
 * cleared by the parent once the persisted thread catches up.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { Brain02Icon, SparklesIcon } from "@hugeicons/core-free-icons";

import {
  useAbort,
  useConversationView,
  useEnsureRuntime,
} from "@/lib/conversation-runtime";
import { cn } from "@/lib/utils";
import type { Conversation, WorldId } from "@/types";

import { Markdown } from "./markdown";
import { MessageTokenFooter } from "./message-token-footer";
import { buildBlocks, type RenderBlock } from "./message-render";
import { ToolCard } from "./tool-card";

interface ConversationViewProps {
  readonly worldId: WorldId;
  readonly conversation: Conversation;
  /** Optimistic user text for the in-flight turn; `null` when idle. */
  readonly pendingUserText: string | null;
  /** Notifies the parent when the optimistic echo is no longer needed. */
  readonly onPendingUserConsumed: () => void;
}

/** Blinking block cursor appended to streaming assistant text. */
function StreamingCursor() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-foreground align-baseline"
    />
  );
}

/** Collapsible reasoning ("thinking") block. */
function ReasoningBlock({
  text,
  live,
}: {
  readonly text: string;
  readonly live: boolean;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(live);
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <HugeiconsIcon
          icon={Brain02Icon}
          strokeWidth={2}
          className="size-3.5 text-muted-foreground"
        />
        <span className="text-[0.6875rem] font-medium italic text-muted-foreground">
          {live ? t("chat:tool.running") : t("chat:tool.done")}
        </span>
      </button>
      {open && text && (
        <p className="whitespace-pre-wrap border-t border-border/50 px-2.5 py-2 text-[0.75rem] italic leading-relaxed text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  );
}

/** Subtle horizontal divider with a centered "Step N" label. */
function StepDivider({ n }: { readonly n: number }) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="h-px flex-1 bg-border/60" />
      <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/60">
        {t("chat:step", { n })}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/** "Stopped" marker shown in the brief abort window before finalization. */
function StoppedMarker() {
  const { t } = useTranslation("chat");
  return (
    <div className="py-1 text-center text-[0.6875rem] italic text-muted-foreground">
      {t("chat:stopped")}
    </div>
  );
}

function renderBlock(
  block: RenderBlock,
  worldId: WorldId,
  conversationId: Conversation["id"],
): ReactNode {
  switch (block.kind) {
    case "user":
      return (
        <div key={block.id} className="flex justify-end">
          <div
            className={cn(
              "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-sm text-primary-foreground",
              block.optimistic && "opacity-90",
            )}
          >
            {block.text}
          </div>
        </div>
      );
    case "assistant-text":
      return (
        <div key={block.id} className="flex flex-col gap-1">
          <Markdown content={block.text} />
          {block.streaming && <StreamingCursor />}
        </div>
      );
    case "reasoning":
      return (
        <ReasoningBlock key={block.id} text={block.text} live={block.live} />
      );
    case "tool":
      return <ToolCard key={block.id} tool={block.tool} worldId={worldId} conversationId={conversationId} />;
    case "token-footer":
      return (
        <MessageTokenFooter
          key={block.id}
          inputTokens={block.inputTokens}
          outputTokens={block.outputTokens}
          cacheReadTokens={block.cacheReadTokens}
          cacheWriteTokens={block.cacheWriteTokens}
        />
      );
    case "step":
      return <StepDivider key={block.id} n={block.n} />;
    case "stopped":
      return <StoppedMarker key={block.id} />;
    default:
      return null;
  }
}

export function ConversationView({
  worldId,
  conversation,
  pendingUserText,
  onPendingUserConsumed,
}: ConversationViewProps) {
  const { t } = useTranslation(["chat", "common"]);
  const agentLoading = useEnsureRuntime(worldId, conversation);
  const { view } = useConversationView(worldId, conversation.id);
  const abort = useAbort(worldId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Auto-scroll: keep the bottom in view while the user is pinned to it.
  // Runs on every render so streaming deltas track the bottom smoothly.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // Clear the optimistic user echo once the persisted thread catches up (the
  // real user message lands in `view.messages` on run finalization) or once an
  // error surfaces (the run never persisted a user message — e.g.
  // model-not-configured). Count-based, NOT content-based: matching by text
  // would false-trigger on a consecutive duplicate send (two "继续" in a row —
  // the second echo matches the first persisted message and flickers away
  // before the new message lands). The baseline user-message count is captured
  // the first time this effect runs for a fresh pending turn (ref is null),
  // then we clear once the count grows past it.
  const baselineUserCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingUserText) {
      baselineUserCountRef.current = null;
      return;
    }
    if (baselineUserCountRef.current === null) {
      baselineUserCountRef.current = view.messages.filter(
        (m) => m.role === "user",
      ).length;
      return; // Captured this turn — count can't have grown yet.
    }
    const currentCount = view.messages.filter((m) => m.role === "user").length;
    if (currentCount > baselineUserCountRef.current || view.error !== null) {
      onPendingUserConsumed();
    }
  }, [pendingUserText, view.messages, view.error, onPendingUserConsumed]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 80;
  };

  const blocks = buildBlocks(
    view.messages,
    view.stream,
    view.isRunning,
    pendingUserText,
    view.stopReason,
    view.messageUsages,
    view.lastTurnUsage,
  );

  const isEmpty =
    blocks.length === 0 && !agentLoading && view.error === null;
  const errorMessage = view.error
    ? view.error.code === "MODEL_NOT_CONFIGURED"
      ? t("chat:error.modelNotConfigured")
      : view.error.message
    : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
          {agentLoading && blocks.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <span className="inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-foreground" />
              {t("common:loading")}
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} className="size-5" />
              </span>
              <p className="max-w-xs text-sm text-muted-foreground">
                {t("chat:view.empty")}
              </p>
            </div>
          ) : (
            blocks.map((b) => renderBlock(b, worldId, conversation.id))
          )}

          {errorMessage && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <span className="flex-1">{errorMessage}</span>
              {view.isRunning && (
                <button
                  type="button"
                  onClick={() => abort(conversation.id)}
                  className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
                >
                  {t("chat:composer.stop")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
