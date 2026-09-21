/**
 * Subagent block — the specialized `dispatch_subagent` ToolCard renderer
 * (ADR-0050 D10).
 *
 * One block per dispatch tool call: role name + live status in the header,
 * the full dispatched task prompt in a content section below the header,
 * per-run Stop, approve-all, and click-to-drill into the run's own
 * transcript. N parallel dispatches render as N blocks in tool-call
 * order (each anchors on its own `parentToolCallId` back-link while live,
 * on the persisted `runId` once the tool result lands).
 *
 * ## States (live → terminal)
 *
 * While the parent's tool call is `running`, the child run's conversation
 * already exists in the runtime store (created by the dispatch runtime
 * before execute blocks). The block finds it by scanning the world's slots
 * for `meta.kind === "subagent"` + `meta.parentToolCallId === toolCallId`
 * — the redundant back-link ADR-0050 D3 defines for exactly this purpose —
 * and derives live state from it: 运行中 / 待审批 (N) + Stop + Approve-all.
 * Once the tool result persists, status/usage/finalMessage come from the
 * result contract (`completed | stopped | aborted | error | unconfigured`).
 * Historical blocks (app restarted, no live slot) render purely from the
 * persisted result and still drill in via the IPC-fetched conversation.
 *
 * ## Drill-in
 *
 * The header body raises {@link SubagentDrillInContext} (provided by the
 * chat route) — never a route param: drill-in is session-local state, not
 * a deep-linkable surface (ADR-0021 spirit, ADR-0050 D10). The buttons
 * (Stop / Approve-all) stop propagation — they act on the run without
 * navigating.
 *
 * Visual language mirrors the generic ToolCard exactly (status ring /
 * checkmark / destructive marker, monospace badge, hover + focus ring,
 * same oklch semantic tokens) — a consistency extension, not a redesign.
 */

import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ChevronRightIcon,
  ShieldAlert,
} from "@hugeicons/core-free-icons";

import { useAbort, useApproveAllForRun, useConversationStore } from "@/lib/conversation-runtime";
import { formatTokenCount } from "@/lib/format";
import type { WorldId } from "@/types";
import { cn } from "@/lib/utils";
import type { ToolBlockData } from "./message-render";
import { asString, isRecord, unwrapToolOutput } from "./tool-summary";
import { ToolDurationLabel } from "./tool-cards/tool-body";

// ─── Drill-in context (provided by the chat route, D10) ────────────────────

/** Terminal statuses of the dispatch result contract (ADR-0050 D3). */
export type SubagentRunStatus =
  | "completed"
  | "aborted"
  | "stopped"
  | "error"
  | "unconfigured";

/** What a block hands the chat route when the user drills in. */
export interface SubagentDrillInTarget {
  /** The run's conversation id — the ConversationView key. */
  readonly runId: string;
  /** The dispatched role's registry name (header + localization). */
  readonly role: string;
  /** First line of the task brief (breadcrumb digest). */
  readonly taskDigest: string;
  /** Terminal status when drilled from a persisted block; `undefined` live. */
  readonly status?: SubagentRunStatus;
}

/**
 * Drill-in notifier — the chat route provides this; blocks raise it on
 * header click. Default is a no-op so the block renders harmlessly outside
 * the chat route (nothing is currently rendered there, but the component
 * stays route-agnostic).
 */
export const SubagentDrillInContext = createContext<
  (target: SubagentDrillInTarget) => void
>(() => {});

// ─── Defensive narrowing (persisted/live payloads are `unknown`) ────────────

/** The dispatch tool_call input: `{ role, task }`. */
interface DispatchInputView {
  readonly role: string;
  readonly task: string;
}

function resolveDispatchInput(tool: ToolBlockData): DispatchInputView | null {
  if (!isRecord(tool.input)) return null;
  const role = asString(tool.input.role);
  const task = asString(tool.input.task);
  if (!role || !task) return null;
  return { role, task };
}

/** The persisted dispatch tool_result contract (ADR-0050 D3). */
interface DispatchResultView {
  readonly runId: string | null;
  readonly status: SubagentRunStatus;
  readonly finalMessage: string;
  readonly usage: { readonly input: number; readonly output: number };
}

function resolveDispatchResult(tool: ToolBlockData): DispatchResultView | null {
  const out = unwrapToolOutput(tool.output);
  if (!isRecord(out)) return null;
  const status = asString(out.status);
  if (
    status !== "completed" &&
    status !== "aborted" &&
    status !== "stopped" &&
    status !== "error" &&
    status !== "unconfigured"
  ) {
    return null;
  }
  const runId = asString(out.runId) ?? null;
  const usageRec = isRecord(out.usage) ? out.usage : {};
  return {
    runId,
    status,
    finalMessage: asString(out.finalMessage) ?? "",
    usage: {
      input: typeof usageRec.input === "number" ? usageRec.input : 0,
      output: typeof usageRec.output === "number" ? usageRec.output : 0,
    },
  };
}

/** Union of display states the block can be in. */
type DisplayState =
  | { readonly key: "running" }
  | { readonly key: "awaitingApproval"; readonly count: number }
  | { readonly key: SubagentRunStatus };

// ─── Component ──────────────────────────────────────────────────────────────

interface SubagentBlockProps {
  /** The unified tool block (persisted or live) for a `dispatch_subagent` call. */
  readonly tool: ToolBlockData;
  readonly worldId: WorldId;
}

export function SubagentBlock({ tool, worldId }: SubagentBlockProps) {
  const { t } = useTranslation("chat");
  const store = useConversationStore();
  const abort = useAbort(worldId);
  const approveAll = useApproveAllForRun(worldId);
  const drillIn = useContext(SubagentDrillInContext);

  const input = resolveDispatchInput(tool);
  const result = tool.status === "running" ? null : resolveDispatchResult(tool);

  // Live anchoring while the dispatch is in flight: the child run's slot
  // exists in the store (created by the dispatch runtime before the execute
  // blocks). Found via the parentToolCallId back-link (ADR-0050 D3); the
  // returned `data` reference is stable across unrelated store patches, so
  // plain `useStore` equality semantics hold. Cached terminal slots also
  // match but are only consulted while `tool.status === "running"`.
  const liveSlot = useStore(store, (state) => {
    const worldMap = state.worlds.get(worldId);
    if (!worldMap) return null;
    for (const data of worldMap.values()) {
      const meta = data.conversation.meta;
      if (meta.kind === "subagent" && meta.parentToolCallId === tool.toolCallId) {
        return data;
      }
    }
    return null;
  });

  const liveView = tool.status === "running" ? liveSlot?.view ?? null : null;
  const liveRunId = tool.status === "running" ? liveSlot?.conversation.id ?? null : null;
  const livePending = liveView?.stream
    ? Object.keys(liveView.stream.pendingApprovals).length
    : 0;
  const liveIsRunning = liveView?.isRunning ?? false;

  // Effective run id: the persisted result's once terminal (the source of
  // truth, D3), else the live slot's.
  const runId = result?.runId ?? liveRunId;

  // Status precedence: terminal states come from the tool result (or the
  // tool-error event — the dispatch execute never rejects, but the SDK can
  // still wrap failures). While the parent's tool call is still "running",
  // a child that already settled shows its OWN terminal state instead of
  // falling through to "running" (the parallel-dispatch window — siblings
  // settle at different times): awaiting-approval beats running; then the
  // live slot's terminalStatus (the dispatch contract's authoritative
  // final word — it distinguishes "stopped" from "aborted"); then the
  // generic abort marker (instant-abort window before terminalStatus
  // lands); the last "running" fallback covers the pre-run micro-window
  // (slot created, driveRun not yet flipped isRunning).
  const state: DisplayState = result
    ? { key: result.status }
    : tool.status === "error"
      ? { key: "error" }
      : livePending > 0 && liveIsRunning
        ? { key: "awaitingApproval", count: livePending }
        : liveIsRunning
          ? { key: "running" }
          : liveView?.terminalStatus != null
            ? { key: liveView.terminalStatus }
            : liveView?.stopReason === "aborted"
              ? { key: "aborted" }
              : { key: "running" };

  // Raw registry role name — deliberately NOT localized (see drill-in-header).
  const roleName = input ? input.role : null;
  const taskDigest = input ? (input.task.split("\n")[0] ?? "").trim() : "";

  const statusLabel =
    state.key === "awaitingApproval"
      ? t("chat:subagent.status.awaitingApproval", { count: state.count })
      : t(`chat:subagent.status.${state.key}`);

  const canDrill = runId !== null && tool.status !== "error";
  const showStop = tool.status === "running" && liveIsRunning && liveRunId !== null;
  const showApproveAll =
    tool.status === "running" && livePending > 0 && liveRunId !== null;

  const handleDrill = () => {
    if (!canDrill || !runId || !input) return;
    drillIn({
      runId,
      role: input.role,
      taskDigest,
      status: result?.status,
    });
  };

  const handleStop = () => {
    if (liveRunId !== null) abort(liveRunId);
  };

  const handleApproveAll = () => {
    if (liveRunId !== null) approveAll(liveRunId);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={handleDrill}
        disabled={!canDrill}
        aria-label={
          input && roleName
            ? t("chat:subagent.openLabel", { role: roleName })
            : t("chat:subagent.runTitle")
        }
        className={cn(
          "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/30",
          canDrill ? "cursor-pointer hover:bg-muted/50" : "cursor-default",
        )}
      >
        <StatusGlyph state={state} label={statusLabel} />
        <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium text-secondary-foreground">
          {roleName ?? tool.toolName}
        </code>
        <span className={cn("ml-auto shrink-0 text-[0.6875rem]", statusLabelClass(state))}>
          {statusLabel}
        </span>
        {/* Dispatch duration naturally equals the whole child-run wall time
            (dispatch_subagent blocks until the child finishes) — desired. */}
        <ToolDurationLabel durationMs={tool.durationMs} />
        {canDrill && (
          <HugeiconsIcon
            icon={ChevronRightIcon}
            strokeWidth={2}
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
      </button>

      {/* Full dispatched task prompt — always visible, scroll-capped only
          (PayloadBlock max-height pattern). The first-line digest lives on
          solely as the drill-in breadcrumb payload. */}
      {input?.task && (
        <div className="border-t border-border/60 px-2.5 py-1.5">
          <div className="max-h-48 overflow-y-auto">
            <p className="whitespace-pre-wrap break-words text-[0.6875rem] leading-relaxed text-muted-foreground">
              {input.task}
            </p>
          </div>
        </div>
      )}

      {(showStop || showApproveAll) && (
        <div className="flex items-center gap-2 border-t border-border/60 px-2.5 py-1.5">
          {showStop && (
            <button
              type="button"
              onClick={handleStop}
              aria-label={t("chat:subagent.stopLabel")}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-0.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-muted"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={2}
                aria-hidden
                className="size-3"
              />
              {t("chat:subagent.stop")}
            </button>
          )}
          {showApproveAll && (
            <button
              type="button"
              onClick={handleApproveAll}
              className="rounded-md bg-primary px-2.5 py-0.5 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t("chat:subagent.approveAll", { count: livePending })}
            </button>
          )}
        </div>
      )}

      {result && (result.usage.input > 0 || result.usage.output > 0 || result.finalMessage) && (
        <div className="flex flex-col gap-0.5 border-t border-border/60 px-2.5 py-1.5">
          {(result.usage.input > 0 || result.usage.output > 0) && (
            <div className="flex items-center gap-3 text-[0.6875rem] tabular-nums text-muted-foreground/70">
              <span
                aria-label={t("chat:token.input")}
                className="flex items-center gap-0.5"
              >
                <span aria-hidden className="translate-y-[0.05em]">
                  ↑
                </span>
                {formatTokenCount(result.usage.input)}
              </span>
              <span
                aria-label={t("chat:token.output")}
                className="flex items-center gap-0.5"
              >
                <span aria-hidden className="translate-y-[0.05em]">
                  ↓
                </span>
                {formatTokenCount(result.usage.output)}
              </span>
            </div>
          )}
          {result.status !== "unconfigured" && result.finalMessage && (
            <p
              className="truncate text-[0.6875rem] leading-relaxed text-muted-foreground"
              title={result.finalMessage}
            >
              {result.finalMessage}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Status presentation (mirrors the generic ToolCard's indicators) ────────

function StatusGlyph({
  state,
  label,
}: {
  readonly state: DisplayState;
  readonly label: string;
}) {
  if (state.key === "running") {
    // Same animated ring as the generic ToolCard's running indicator.
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span className="absolute inline-flex size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-primary" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (state.key === "awaitingApproval") {
    return (
      <HugeiconsIcon
        icon={ShieldAlert}
        strokeWidth={2}
        aria-hidden
        className="size-3.5 shrink-0 text-amber-500"
      />
    );
  }
  if (state.key === "error") {
    return (
      <HugeiconsIcon
        icon={Cancel01Icon}
        strokeWidth={2}
        aria-hidden
        className="size-3.5 shrink-0 text-destructive"
      />
    );
  }
  if (state.key === "unconfigured") {
    return (
      <HugeiconsIcon
        icon={Alert02Icon}
        strokeWidth={2}
        aria-hidden
        className="size-3.5 shrink-0 text-amber-500"
      />
    );
  }
  if (state.key === "completed") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        strokeWidth={2}
        aria-hidden
        className="size-3.5 shrink-0 text-foreground"
      />
    );
  }
  // stopped / aborted — a user-visible but non-erroneous end.
  return (
    <HugeiconsIcon
      icon={Cancel01Icon}
      strokeWidth={2}
      aria-hidden
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

function statusLabelClass(state: DisplayState): string {
  switch (state.key) {
    case "running":
      return "text-muted-foreground animate-pulse";
    case "awaitingApproval":
      return "text-amber-600 dark:text-amber-500";
    case "error":
      return "text-destructive";
    case "unconfigured":
      return "text-amber-600 dark:text-amber-500";
    default:
      return "text-muted-foreground";
  }
}
