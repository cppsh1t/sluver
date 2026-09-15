/**
 * Drill-in surface shared by the two chat surfaces — the world chat route
 * (`routes/world.$worldId/chat.tsx`) and the chapter editor's chat panel
 * (`chapter-chat-panel.tsx`).
 *
 * `DrillInHeader` is the breadcrumb header (back + role + task digest +
 * status chip) shown when a surface swaps to a subagent run's transcript
 * (ADR-0050 D10). `useDrillInRun` owns the session-local drill-in state
 * and the by-id fetch of the run's Conversation row: live runs already
 * have a runtime slot (the fetch is redundant but harmless and keeps ONE
 * uniform load path); historical runs need the row so `useEnsureRuntime`
 * can create the slot and replay the transcript. `drillIn` is
 * deliberately NOT a route param (ADR-0021 spirit): a run transcript is
 * reachable only through its parent conversation's dispatch block, never
 * a deep link.
 *
 * The chip's status-precedence chain is the drift-prone core both reviews
 * flagged — keep this module the single source of truth for it.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";

import { getConversation } from "@/api";
import type { SubagentDrillInTarget } from "@/components/chat/subagent-block";
import {
  EMPTY_VIEW,
  useConversationView,
} from "@/lib/conversation-runtime";
import { logger } from "@/lib/logger";
import type { Conversation, ConversationId, SpaceId, WorldId } from "@/types";
import { cn } from "@/lib/utils";

/** Breadcrumb status chip for the drill-in header. */
interface DrillInChip {
  readonly key:
    | "running"
    | "awaitingApproval"
    | "completed"
    | "stopped"
    | "aborted"
    | "error"
    | "unconfigured";
  readonly count?: number;
}

/**
 * Drill-in header — back button, role name, task digest, and a status chip
 * derived (in precedence order) from the run's LIVE slot when one exists —
 * isRunning / pendingApprovals, `view.error`, then the slot's
 * `terminalStatus` (the dispatch contract's authoritative terminal state,
 * which alone distinguishes "stopped" from "aborted") — falling back to the
 * generic abort marker for the instant-abort window and to the target's
 * persisted terminal status for historical replay.
 */
export function DrillInHeader({
  worldId,
  target,
  onBack,
}: {
  readonly worldId: WorldId;
  readonly target: SubagentDrillInTarget;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation(["chat", "ai"]);
  const { view } = useConversationView(worldId, target.runId);

  const pendingCount = view.stream
    ? Object.keys(view.stream.pendingApprovals).length
    : 0;
  // Chip precedence: (1) live stream wins while the slot runs;
  // (2) a stream-terminating error beats everything terminal (an errored
  // live run must not fall through to "completed"); (3) the dispatch
  // runtime's authoritative terminalStatus (written after driveRun's
  // finalization — knows stopped vs aborted vs error); (4) the target's
  // persisted status (historical replay, no live slot); (5) the generic
  // abort marker (instant-abort window before terminalStatus lands);
  // (6) an existing slot with nothing else to say completed; `null` =
  // slot still loading (no chip yet).
  let chip: DrillInChip | null;
  if (view.isRunning) {
    chip =
      pendingCount > 0
        ? { key: "awaitingApproval", count: pendingCount }
        : { key: "running" };
  } else if (view.error !== null) {
    chip = { key: "error" };
  } else if (view.terminalStatus !== null) {
    chip = { key: view.terminalStatus };
  } else if (target.status !== undefined) {
    chip = { key: target.status };
  } else if (view.stopReason === "aborted") {
    chip = { key: "aborted" };
  } else if (view !== EMPTY_VIEW) {
    chip = { key: "completed" };
  } else {
    chip = null;
  }

  const roleName = t(`ai:agentConfigs.name.${target.role}`, {
    defaultValue: target.role,
  });
  const chipKey = chip === null ? null : chip.key;
  const chipLabel =
    chipKey === null
      ? null
      : chipKey === "awaitingApproval"
        ? t("chat:subagent.status.awaitingApproval", { count: chip?.count ?? 0 })
        : t(`chat:subagent.status.${chipKey}`);

  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        aria-label={t("chat:subagent.back")}
        title={t("chat:subagent.back")}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} className="size-3.5" />
      </button>
      <span className="shrink-0 text-sm font-semibold">{roleName}</span>
      <span
        className="min-w-0 truncate text-xs text-muted-foreground"
        title={target.taskDigest}
      >
        {target.taskDigest}
      </span>
      {chipKey !== null && chipLabel && (
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-medium",
            chipKey === "awaitingApproval" || chipKey === "unconfigured"
              ? "border-amber-500/40 text-amber-600 dark:text-amber-500"
              : chipKey === "error"
                ? "border-destructive/40 text-destructive"
                : "border-border text-muted-foreground",
            chipKey === "running" && "animate-pulse",
          )}
        >
          {chipLabel}
        </span>
      )}
    </div>
  );
}

/**
 * Session-local subagent drill-in state for a chat surface: the drill-in
 * target, the fetched run Conversation row (null while loading /
 * historical), and the load-failure flag. Returns the raw `setDrillIn` so
 * surfaces can escape the drill-in view from their own selection actions
 * (an explicit conversation click wins over the run transcript).
 */
export function useDrillInRun(spaceId: SpaceId, worldId: WorldId) {
  const [drillIn, setDrillIn] = useState<SubagentDrillInTarget | null>(null);
  const [runConversation, setRunConversation] = useState<Conversation | null>(null);
  const [runLoadFailed, setRunLoadFailed] = useState(false);

  useEffect(() => {
    if (!drillIn) return;
    let cancelled = false;
    setRunConversation(null);
    setRunLoadFailed(false);
    getConversation(spaceId, worldId, drillIn.runId as ConversationId)
      .then((c) => {
        if (!cancelled) setRunConversation(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setRunLoadFailed(true);
        // Metadata only — never the task content (redaction policy, ADR-0016).
        logger.warn("chat.subagent_drill_in.load_failed", {
          run_id: drillIn.runId,
          world_id: worldId,
          error: String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [drillIn, spaceId, worldId]);

  const handleDrillIn = useCallback((target: SubagentDrillInTarget) => {
    setDrillIn(target);
  }, []);

  const handleBack = useCallback(() => {
    setDrillIn(null);
  }, []);

  return {
    drillIn,
    setDrillIn,
    handleDrillIn,
    handleBack,
    runConversation,
    runLoadFailed,
  };
}
