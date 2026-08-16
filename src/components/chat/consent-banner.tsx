/**
 * Consent banner — shown above the composer when one or more tool calls are
 * awaiting user approval. Mirrors the Cursor/Cline pattern: a prominent bar
 * that blocks the conversation until the user approves or denies.
 *
 * Pending approvals render as a single-slide carousel: exactly one approval
 * is visible at a time (chevron buttons, an "N / M" counter, and ArrowLeft/
 * ArrowRight keys navigate), so the banner keeps a stable height no matter
 * how many tool calls are queued. Approve/Deny act on the active slide only;
 * "Approve all" (rendered for 2+ pending) resolves every queued approval.
 *
 * Reads `pendingApprovals` from the conversation-runtime store; each pending
 * approval is summarized via {@link summarizeToolCall} so the user sees a
 * human-readable action ("创建角色「张三」") plus key parameter rows (capped at
 * two with a "+N more" indicator), not just a bare tool name. Renders nothing
 * when there are no pending approvals.
 */

import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ShieldAlert,
} from "@hugeicons/core-free-icons";

import { useConversationView, useResolveApproval } from "@/lib/conversation-runtime";
import type { ConversationId, WorldId } from "@/types";
import { summarizeToolCall } from "./tool-summary";
import { ToolSummaryLine } from "./tool-cards/tool-body";

interface ConsentBannerProps {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
}

export function ConsentBanner({ worldId, conversationId }: ConsentBannerProps) {
  const { t } = useTranslation("chat");
  const { view } = useConversationView(worldId, conversationId);
  const resolveApproval = useResolveApproval(worldId);
  const [index, setIndex] = useState(0);

  const pending = view.stream
    ? Object.values(view.stream.pendingApprovals)
    : [];

  // A new batch must open at slide 1 even if a previous batch left the index
  // mid-queue (e.g. 4 approvals resolved, a later batch arrives). Conversation
  // switches are covered separately by the `key` remount in chat.tsx.
  useEffect(() => {
    if (pending.length === 0) setIndex(0);
  }, [pending.length]);

  if (pending.length === 0) return null;

  // Clamp after a resolve removes an item: the same index now points at the
  // next queued approval, or falls back to the last one when the tail was
  // resolved. Full clearance (abort auto-deny) exits via the guard above.
  const activeIndex = Math.min(index, pending.length - 1);
  const active = pending[activeIndex];
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex < pending.length - 1;

  // No output yet (pending) — summarize from the input only.
  const summary = summarizeToolCall(active.toolName, active.input, undefined);
  const hasStructuredSummary =
    summary.entityType !== null || summary.action === "getTime";

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft" && hasPrev) {
      e.preventDefault();
      setIndex(activeIndex - 1);
    } else if (e.key === "ArrowRight" && hasNext) {
      e.preventDefault();
      setIndex(activeIndex + 1);
    }
  }

  return (
    <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-2">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        {/* Header row: pending count on the left; "Approve all" and the
            carousel nav (chevrons + counter, 2+ pending only) on the right. */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={ShieldAlert}
              strokeWidth={2}
              className="size-3.5 text-amber-500"
            />
            <span className="text-[0.6875rem] font-medium text-amber-600 dark:text-amber-500">
              {t("chat:consent.pendingCount", { count: pending.length })}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {pending.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  for (const p of pending) {
                    resolveApproval(conversationId, p.toolCallId, true);
                  }
                }}
                className="rounded-md border border-amber-500/40 px-2.5 py-0.5 text-[0.6875rem] font-medium text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
              >
                {t("chat:consent.approveAll")}
              </button>
            )}
            {pending.length > 1 && (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setIndex(activeIndex - 1)}
                  disabled={!hasPrev}
                  aria-label={t("chat:consent.prev")}
                  title={t("chat:consent.prev")}
                  className="flex size-6 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-500/10 disabled:pointer-events-none disabled:opacity-40 dark:text-amber-500"
                >
                  <HugeiconsIcon
                    icon={ArrowLeft02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                </button>
                <span className="px-0.5 text-[0.6875rem] font-medium tabular-nums text-amber-600 dark:text-amber-500">
                  {activeIndex + 1} / {pending.length}
                </span>
                <button
                  type="button"
                  onClick={() => setIndex(activeIndex + 1)}
                  disabled={!hasNext}
                  aria-label={t("chat:consent.next")}
                  title={t("chat:consent.next")}
                  className="flex size-6 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-500/10 disabled:pointer-events-none disabled:opacity-40 dark:text-amber-500"
                >
                  <HugeiconsIcon
                    icon={ArrowRight02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* The slide — one pending approval at a time. Focusable so
            ArrowLeft/ArrowRight cycle slides without reaching for the
            chevrons; focus survives slide switches because the region
            itself is not keyed, only its content re-renders. */}
        <div
          role="group"
          aria-roledescription="carousel"
          aria-label={t("chat:consent.pendingCount", { count: pending.length })}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="flex items-start justify-between gap-2 rounded-md border border-amber-500/20 bg-background/50 px-2.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {hasStructuredSummary ? (
                <span className="min-w-0 truncate text-sm font-medium text-amber-700 dark:text-amber-400">
                  <ToolSummaryLine summary={summary} />
                </span>
              ) : (
                <span className="min-w-0 truncate text-sm font-medium text-amber-700 dark:text-amber-400">
                  {active.toolName}
                </span>
              )}
              <code className="shrink-0 rounded bg-amber-500/10 px-1 py-0.5 font-mono text-[0.625rem] text-amber-700/70 dark:text-amber-400/70">
                {active.toolName}
              </code>
            </div>
            {/* Height cap: 2 param rows + the "+N more" indicator (3 text-xs
                lines + 2 gaps = 52px); verbose tool inputs stay accounted for
                without ballooning the banner. */}
            <div className="flex max-h-[3.25rem] flex-col gap-0.5 overflow-hidden">
              {summary.paramRows.slice(0, 2).map((row, i) => (
                <span
                  key={`${row.label}-${i}`}
                  className="truncate text-xs text-muted-foreground"
                >
                  {t(`chat:tool.param.${row.label}`)}: {row.value}
                </span>
              ))}
              {summary.paramRows.length > 2 && (
                <span className="truncate text-xs text-muted-foreground/70">
                  {t("chat:consent.moreParams", {
                    count: summary.paramRows.length - 2,
                  })}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                resolveApproval(conversationId, active.toolCallId, true)
              }
              className="rounded-md bg-primary px-2.5 py-0.5 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t("chat:consent.approve")}
            </button>
            <button
              type="button"
              onClick={() =>
                resolveApproval(conversationId, active.toolCallId, false)
              }
              className="rounded-md border border-border bg-background px-2.5 py-0.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-muted"
            >
              {t("chat:consent.deny")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
