/**
 * Tool execution card — renders a single tool call (persisted or live).
 *
 * The centerpiece of the "looks like an AI coding tool" requirement. Mirrors
 * the compact, expandable execution display in Cursor / Cline: a status
 * indicator + monospace tool-name badge, with collapsible JSON input/output.
 *
 * States:
 * - `running` — animated ring spinner + live input preview; expanded by
 *   default so the streaming args are visible.
 * - `done`    — checkmark; collapsed by default, click to inspect I/O.
 * - `error`   — destructive marker + error message; input shown on expand.
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
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import {
  formatToolInput,
  formatToolOutput,
  type ToolBlockData,
} from "./message-render";

interface ToolCardProps {
  readonly tool: ToolBlockData;
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

/** Collapsible labeled `<pre>` for tool input/output payloads. */
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

export function ToolCard({ tool }: ToolCardProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(tool.status === "running");

  const statusKey = statusTextKey(tool.status);
  const labelText = t(statusKey);

  const inputText = formatToolInput(tool.input);
  const draftText = tool.inputDraft ?? "";
  // While streaming (no parsed input yet), show the accumulated draft.
  const effectiveInput =
    tool.status === "running" && !inputText && draftText
      ? draftText
      : inputText;
  const outputText = formatToolOutput(tool.output);
  const hasDetails = effectiveInput.length > 0 || outputText.length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        aria-expanded={hasDetails ? open : undefined}
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/30",
          hasDetails && "hover:bg-muted/50",
          !hasDetails && "cursor-default",
        )}
      >
        <StatusIndicator status={tool.status} label={labelText} />
        <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium text-secondary-foreground">
          {tool.toolName || "tool"}
        </code>
        <span className={cn("text-[0.6875rem]", statusLabelClass(tool.status))}>
          {labelText}
        </span>
        {hasDetails && (
          <HugeiconsIcon
            icon={ChevronDownIcon}
            strokeWidth={2}
            className={cn(
              "ml-auto size-3.5 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

      {open && hasDetails && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-2.5 py-2">
          {effectiveInput.length > 0 && (
            <PayloadBlock label={t("chat:tool.input")} value={effectiveInput} />
          )}
          {tool.status === "error" && tool.error ? (
            <PayloadBlock
              label={t("chat:tool.error")}
              value={tool.error.message || tool.error.code}
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
        </div>
      )}
    </div>
  );
}
