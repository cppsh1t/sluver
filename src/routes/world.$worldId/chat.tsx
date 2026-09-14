/**
 * Chat route — world-scoped AI assistant workspace.
 *
 * Two-pane layout: conversation list (left) + conversation view with composer
 * (right). Selection is local route state; the conversation runtime lives in
 * the Space-level provider (`_space.tsx`), so in-flight runs survive
 * navigation between conversations and worlds.
 *
 * The optimistic `pendingTurn` (text + attachments, plan D7) bridges the
 * runtime's send→finalize gap: `send` appends the user message to the Agent
 * thread immediately, but the reactive `view.messages` only refreshes on run
 * finalization. The view echoes the turn optimistically and clears it once
 * the persisted thread catches up.
 *
 * `imageDeliveryDisabled` (plan D9 step 4) joins the selected conversation's
 * AgentConfig model with the models.dev catalog — the same shared react-query
 * data + pure helper the runtime Provider resolves per-send — to badge image
 * attachments when the currently-bound model is catalog-confirmed to lack
 * image input. `undefined` (unknown/custom models) NEVER badges.
 *
 * ## Subagent drill-in (ADR-0050 D10)
 *
 * Clicking a subagent block's body swaps the right pane to the run's own
 * transcript: breadcrumb header (back + role + task digest + status chip) →
 * `ConversationView` keyed by runId, ConsentBanner bound to the run's
 * pendingApprovals, NO composer (the user's only interventions in a run are
 * stop and approve). Live runs render through the existing per-runtime
 * stream machinery — a run is just another runtime slot (ADR-0050 D2);
 * historical runs (no slot, e.g. after an app restart) are fetched by id
 * via `get_conversation` and ensured through the normal `useEnsureRuntime`
 * path, then stay read-only. `drillInRunId` is session-local state —
 * deliberately NOT a route param (ADR-0021 spirit): a run transcript is
 * reachable only through its parent conversation's dispatch block, never a
 * deep link.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";

import { worldLayoutRoute } from "./_world";

import { getConversation } from "@/api";
import { Composer } from "@/components/chat/composer";
import { ConsentBanner } from "@/components/chat/consent-banner";
import { ConversationList } from "@/components/chat/conversation-list";
import { ConversationView } from "@/components/chat/conversation-view";
import type { PendingTurn } from "@/components/chat/message-render";
import {
  SubagentDrillInContext,
  type SubagentDrillInTarget,
} from "@/components/chat/subagent-block";
import { TokenStatusBar } from "@/components/chat/token-status-bar";
import { useAgentConfigs, useConversations, useModelsDevCatalog } from "@/hooks";
import { logger } from "@/lib/logger";
import {
  EMPTY_VIEW,
  imageInputSupportedForModel,
  useConversationView,
} from "@/lib/conversation-runtime";
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
function DrillInHeader({
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

function ChatPage() {
  const { t } = useTranslation(["chat", "common"]);
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const sid = spaceId as SpaceId;
  const wid = worldId as WorldId;

  const { data: conversations = [] } = useConversations(sid, wid);

  const [selectedId, setSelectedId] = useState<ConversationId | null>(null);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);

  // ── Subagent drill-in (ADR-0050 D10) ────────────────────────────────────
  // Session-local state, NOT a route param (ADR-0021 spirit): a run
  // transcript is reachable only through its parent conversation's dispatch
  // block, never a deep link. Cleared by the breadcrumb's back button.
  const [drillIn, setDrillIn] = useState<SubagentDrillInTarget | null>(null);
  // The run's Conversation object — fetched by id on drill-in. Live runs
  // already have a runtime slot (the fetch is redundant but harmless and
  // keeps ONE uniform load path); historical runs need the row so
  // `useEnsureRuntime` can create the slot and replay the transcript.
  const [runConversation, setRunConversation] = useState<Conversation | null>(null);
  const [runLoadFailed, setRunLoadFailed] = useState(false);

  useEffect(() => {
    if (!drillIn) return;
    let cancelled = false;
    setRunConversation(null);
    setRunLoadFailed(false);
    getConversation(sid, wid, drillIn.runId as ConversationId)
      .then((c) => {
        if (!cancelled) setRunConversation(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setRunLoadFailed(true);
        // Metadata only — never the task content (redaction policy, ADR-0016).
        logger.warn("chat.subagent_drill_in.load_failed", {
          run_id: drillIn.runId,
          world_id: wid,
          error: String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [drillIn, sid, wid]);

  const handleDrillIn = useCallback((target: SubagentDrillInTarget) => {
    setDrillIn(target);
  }, []);

  const handleBack = useCallback(() => {
    setDrillIn(null);
  }, []);

  // Resolve the full conversation object for the selection (needed to
  // construct/ensure the runtime). Falls back to null when absent.
  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  // Vision capability join for the SELECTED conversation's bound model
  // (plan D9 step 4). Same shared queries the runtime Provider uses — no
  // extra IPC. `=== false` only: unknown (undefined) never badges.
  const agentConfigs = useAgentConfigs(sid);
  const modelsDevCatalog = useModelsDevCatalog();
  const agentConfigsData = agentConfigs.data;
  const catalogData = modelsDevCatalog.data;
  const selectedRole = selected?.agentConfigName;
  const imageDeliveryDisabled = useMemo(() => {
    if (!selectedRole) return false;
    const modelId = agentConfigsData?.find((a) => a.name === selectedRole)?.modelId ?? null;
    return imageInputSupportedForModel(catalogData, modelId) === false;
  }, [agentConfigsData, catalogData, selectedRole]);

  // Auto-select the most-recently-updated conversation when nothing is chosen.
  useEffect(() => {
    if (selectedId !== null) return;
    if (conversations.length === 0) return;
    const newest = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (newest) setSelectedId(newest.id);
  }, [conversations, selectedId]);

  // If the selected conversation was deleted elsewhere, drop the selection so
  // the auto-select effect can pick a successor.
  useEffect(() => {
    if (selectedId !== null && selected === null && conversations.length > 0) {
      // Only clear once the list has settled (selected resolves after a tick).
      setSelectedId(null);
    }
  }, [selectedId, selected, conversations.length]);

  const handleSelect = (conv: { id: ConversationId }) => {
    // An explicit conversation-list click escapes the drill-in view — the
    // user's selection wins over the session-local run transcript, and the
    // right pane returns to the (newly) selected conversation.
    setDrillIn(null);
    setSelectedId(conv.id);
    setPendingTurn(null);
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ConversationList
        spaceId={sid}
        worldId={wid}
        selectedId={selectedId}
        onSelect={handleSelect}
      />

      {/* Drill-in context: subagent blocks inside ANY rendered conversation
          (the parent's dispatch blocks) raise drill-in through this. Runs
          never contain dispatch calls themselves (ADR-0050 D1 — subagents
          don't receive the tool), so no recursion is possible. */}
      <SubagentDrillInContext.Provider value={handleDrillIn}>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {drillIn ? (
            <>
              <DrillInHeader worldId={wid} target={drillIn} onBack={handleBack} />
              {runConversation ? (
                <>
                  <ConversationView
                    key={runConversation.id}
                    worldId={wid}
                    conversation={runConversation}
                    pendingTurn={null}
                    onPendingUserConsumed={() => {}}
                    imageDeliveryDisabled={false}
                  />
                  {/* Approvals still surface inside the drill-in — the
                      banner binds to the RUN's pendingApprovals so the user
                      approves without leaving the transcript. Same no-key
                      rule as the parent banner (facebook/react#24871). */}
                  <ConsentBanner worldId={wid} conversationId={runConversation.id} />
                  {/* NO Composer: the user's only interventions in a run are
                      stop and approve (ADR-0050 D10). */}
                </>
              ) : runLoadFailed ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="max-w-xs text-sm text-muted-foreground">
                    {t("chat:subagent.notFound")}
                  </p>
                  <button
                    type="button"
                    onClick={handleBack}
                    className="rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {t("chat:subagent.back")}
                  </button>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <span className="inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-foreground" />
                  {t("common:loading")}
                </div>
              )}
            </>
          ) : selected ? (
            <>
              <ConversationView
                key={selected.id}
                worldId={wid}
                conversation={selected}
                pendingTurn={pendingTurn}
                onPendingUserConsumed={() => setPendingTurn(null)}
                imageDeliveryDisabled={imageDeliveryDisabled}
              />
              {/* Do NOT add a `key={selected.id}` here: it would duplicate the
                  keyed ConversationView's key value among siblings. Duplicate
                  keys are undefined behavior in React — the reconciler drops
                  DOM tracking on key change and orphan conversation DOM stacks
                  up on every switch (facebook/react#24871; not fixed by React
                  upgrades). The banner resets its carousel index internally on
                  conversation change instead. */}
              <ConsentBanner worldId={wid} conversationId={selected.id} />
              <Composer
                worldId={wid}
                conversationId={selected.id}
                onUserSent={(text, attachments) =>
                  setPendingTurn({
                    text,
                    attachments: attachments.map((a) => ({
                      kind: a.kind,
                      mime: a.mime,
                      filename: a.filename,
                      dataUrl: a.dataUrl,
                    })),
                  })
                }
                imageDeliveryDisabled={imageDeliveryDisabled}
                prefix={
                  <TokenStatusBar
                    spaceId={sid}
                    worldId={wid}
                    conversationId={selected.id}
                    agentConfigName={selected.agentConfigName}
                  />
                }
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <p className="max-w-xs text-sm text-muted-foreground">{t("chat:list.empty")}</p>
            </div>
          )}
        </section>
      </SubagentDrillInContext.Provider>
    </div>
  );
}

export const chatRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "chat",
  component: ChatPage,
});
