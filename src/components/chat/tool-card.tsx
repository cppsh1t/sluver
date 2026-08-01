/**
 * Tool execution card — renders a single tool call (persisted or live).
 *
 * The centerpiece of the "looks like an AI coding tool" requirement. Mirrors
 * the compact, expandable execution display in Cursor / Cline: a status
 * indicator + monospace tool-name badge, with an entity-shaped preview body
 * (via {@link ToolBody}) and a collapsible raw-JSON fallback for power users.
 *
 * States:
 * - `running` — animated ring spinner + live input preview; EXPANDED by
 *   default so the streaming args + preview are visible.
 * - `pendingApproval` — amber shield; EXPANDED by default with inline
 *   approve/deny. The header shows a one-line human summary
 *   ("创建角色「张三」") next to the tool-name badge so the user sees what
 *   they are approving at a glance.
 * - `done`    — checkmark; collapsed by default, click to inspect preview/JSON.
 * - `error`   — destructive marker + error message; expanded to show failure.
 *
 * All colors reference semantic oklch tokens (no hardcoded hex) so the card
 * adapts to the active color theme + dark mode.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ShieldAlert,
} from "@hugeicons/core-free-icons";

import { useResolveApproval } from "@/lib/conversation-runtime";
import type { ConversationId, WorldId } from "@/types";
import { cn } from "@/lib/utils";
import {
  formatToolInput,
  formatToolOutput,
  type ToolBlockData,
} from "./message-render";
import { summarizeToolCall } from "./tool-summary";
import { ToolBody, ToolSummaryLine } from "./tool-cards/tool-body";

interface ToolCardProps {
  readonly tool: ToolBlockData;
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
}

/** Status dot + label + spinner — the left-edge status indicator. */
function StatusIndicator({
  status,
  label,
}: {
  readonly status: ToolBlockData["status"];
  readonly label: string;
}) {
  if (status === "running") {
    return (
      <span className="relative flex size-3.5 items-center justify-center">
        <span className="absolute inline-flex size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-primary" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (status === "error") {
    return (
      <HugeiconsIcon
        icon={Cancel01Icon}
        strokeWidth={2}
        className="size-3.5 text-destructive"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={CheckmarkCircle02Icon}
      strokeWidth={2}
      className="size-3.5 text-foreground"
    />
  );
}

function statusLabelClass(status: ToolBlockData["status"]): string {
  switch (status) {
    case "running":
      return "text-muted-foreground animate-pulse";
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function statusTextKey(status: ToolBlockData["status"]): string {
  switch (status) {
    case "running":
      return "chat:tool.running";
    case "error":
      return "chat:tool.error";
    default:
      return "chat:tool.done";
  }
}

/** Collapsible labeled `<pre>` for tool input/output payloads (raw-JSON view). */
function PayloadBlock({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "error";
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      <pre
        className={cn(
          "max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground/90",
          tone === "error" && "border-destructive/30 bg-destructive/5",
        )}
      >
        {value || "—"}
      </pre>
    </div>
  );
}

export function ToolCard({ tool, worldId, conversationId }: ToolCardProps) {
  const { t } = useTranslation("chat");
  const isPending = !!tool.pendingApproval;
  // Expanded by default while running or awaiting approval; collapsed when done.
  const [open, setOpen] = useState(tool.status === "running" || isPending);
  const [showRaw, setShowRaw] = useState(false);
  const resolveApproval = useResolveApproval(worldId);

  const summary = summarizeToolCall(tool.toolName, tool.input, tool.output);
  // Recognized tools render an entity-shaped preview; unknown ones fall back
  // to the raw-JSON view as the primary body.
  const hasStructuredPreview = summary.entityType !== null || summary.action === "getTime";

  const statusKey = isPending ? "chat:tool.pendingApproval" : statusTextKey(tool.status);
  const labelText = t(statusKey);

  const inputText = formatToolInput(tool.input);
  const draftText = tool.inputDraft ?? "";
  // While streaming (no parsed input yet), show the accumulated draft.
  const effectiveInput =
    tool.status === "running" && !inputText && draftText
      ? draftText
      : inputText;
  const outputText = formatToolOutput(tool.output);
  const hasRawDetails = effectiveInput.length > 0 || outputText.length > 0;
  const hasError = tool.status === "error" && tool.error != null;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/30",
          "hover:bg-muted/50",
        )}
      >
        {isPending ? (
          <HugeiconsIcon
            icon={ShieldAlert}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-amber-500"
          />
        ) : (
          <StatusIndicator status={tool.status} label={labelText} />
        )}
        <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium text-secondary-foreground">
          {tool.toolName || "tool"}
        </code>
        {hasStructuredPreview && (
          <span className="min-w-0 truncate text-[0.6875rem] text-muted-foreground">
            <ToolSummaryLine summary={summary} />
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 text-[0.6875rem]",
            isPending ? "text-amber-600 dark:text-amber-500" : statusLabelClass(tool.status),
          )}
        >
          {labelText}
        </span>
        <HugeiconsIcon
          icon={ChevronDownIcon}
          strokeWidth={2}
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Approve / Deny buttons when pending user consent */}
      {isPending && (
        <div className="flex items-center gap-2 border-t border-border/60 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => resolveApproval(conversationId, tool.toolCallId, true)}
            className="rounded-md bg-primary px-3 py-1 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("chat:consent.approve")}
          </button>
          <button
            type="button"
            onClick={() => resolveApproval(conversationId, tool.toolCallId, false)}
            className="rounded-md border border-border bg-background px-3 py-1 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t("chat:consent.deny")}
          </button>
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-2.5 py-2">
          {hasStructuredPreview ? (
            <>
              {/* Primary: entity-shaped preview. */}
              <ToolBody tool={tool} />
              {/* Secondary: collapsible raw JSON for power users. */}
              {hasRawDetails && (
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  aria-expanded={showRaw}
                  className="self-start text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                >
                  {t("chat:tool.rawJson")}
                </button>
              )}
              {showRaw && hasRawDetails && (
                <>
                  {effectiveInput.length > 0 && (
                    <PayloadBlock label={t("chat:tool.input")} value={effectiveInput} />
                  )}
                  {hasError ? (
                    <PayloadBlock
                      label={t("chat:tool.error")}
                      value={tool.error?.message || tool.error?.code || ""}
                      tone="error"
                    />
                  ) : (
                    outputText.length > 0 && (
                      <PayloadBlock
                        label={t("chat:tool.output")}
                        value={outputText}
                      />
                    )
                  )}
                </>
              )}
              {hasError && !showRaw && (
                <PayloadBlock
                  label={t("chat:tool.error")}
                  value={tool.error?.message || tool.error?.code || ""}
                  tone="error"
                />
              )}
            </>
          ) : (
            // Unknown tool — raw JSON is the primary body.
            <>
              {effectiveInput.length > 0 && (
                <PayloadBlock label={t("chat:tool.input")} value={effectiveInput} />
              )}
              {hasError ? (
                <PayloadBlock
                  label={t("chat:tool.error")}
                  value={tool.error?.message || tool.error?.code || ""}
                  tone="error"
                />
              ) : (
                outputText.length > 0 && (
                  <PayloadBlock label={t("chat:tool.output")} value={outputText} />
                )
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
