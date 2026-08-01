/**
 * Consent banner — shown above the composer when one or more tool calls are
 * awaiting user approval. Mirrors the Cursor/Cline pattern: a prominent bar
 * that blocks the conversation until the user approves or denies.
 *
 * Reads `pendingApprovals` from the conversation-runtime store; each pending
 * approval is summarized via {@link summarizeToolCall} so the user sees a
 * human-readable action ("创建角色「张三」") plus key parameter rows, not just a
 * bare tool name. Renders nothing when there are no pending approvals.
 */

import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { ShieldAlert } from "@hugeicons/core-free-icons";

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

  const pending = view.stream
    ? Object.values(view.stream.pendingApprovals)
    : [];

  if (pending.length === 0) return null;

  return (
    <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-2">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
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
        {pending.map((p) => {
          // No output yet (pending) — summarize from the input only.
          const summary = summarizeToolCall(p.toolName, p.input, undefined);
          const hasStructuredSummary =
            summary.entityType !== null || summary.action === "getTime";
          return (
            <div
              key={p.toolCallId}
              className="flex items-start justify-between gap-2 rounded-md border border-amber-500/20 bg-background/50 px-2.5 py-1.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  {hasStructuredSummary ? (
                    <span className="min-w-0 truncate text-sm font-medium text-amber-700 dark:text-amber-400">
                      <ToolSummaryLine summary={summary} />
                    </span>
                  ) : (
                    <span className="min-w-0 truncate text-sm font-medium text-amber-700 dark:text-amber-400">
                      {p.toolName}
                    </span>
                  )}
                  <code className="shrink-0 rounded bg-amber-500/10 px-1 py-0.5 font-mono text-[0.625rem] text-amber-700/70 dark:text-amber-400/70">
                    {p.toolName}
                  </code>
                </div>
                {summary.paramRows.map((row, i) => (
                  <span
                    key={`${row.label}-${i}`}
                    className="truncate text-xs text-muted-foreground"
                  >
                    {t(`chat:tool.param.${row.label}`)}: {row.value}
                  </span>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => resolveApproval(conversationId, p.toolCallId, true)}
                  className="rounded-md bg-primary px-2.5 py-0.5 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {t("chat:consent.approve")}
                </button>
                <button
                  type="button"
                  onClick={() => resolveApproval(conversationId, p.toolCallId, false)}
                  className="rounded-md border border-border bg-background px-2.5 py-0.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {t("chat:consent.deny")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
