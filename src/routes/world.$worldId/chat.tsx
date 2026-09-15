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

import { useEffect, useMemo, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { worldLayoutRoute } from "./_world";

import { Composer } from "@/components/chat/composer";
import { ConsentBanner } from "@/components/chat/consent-banner";
import { ConversationList } from "@/components/chat/conversation-list";
import { ConversationView } from "@/components/chat/conversation-view";
import { DrillInHeader, useDrillInRun } from "@/components/chat/drill-in-header";
import type { PendingTurn } from "@/components/chat/message-render";
import { SubagentDrillInContext } from "@/components/chat/subagent-block";
import { TokenStatusBar } from "@/components/chat/token-status-bar";
import { useAgentConfigs, useConversations, useModelsDevCatalog } from "@/hooks";
import { imageInputSupportedForModel } from "@/lib/conversation-runtime";
import type { ConversationId, SpaceId, WorldId } from "@/types";

function ChatPage() {
  const { t } = useTranslation(["chat", "common"]);
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const sid = spaceId as SpaceId;
  const wid = worldId as WorldId;

  const { data: conversations = [], isFetching } = useConversations(sid, wid);

  const [selectedId, setSelectedId] = useState<ConversationId | null>(null);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);

  // ── Subagent drill-in (ADR-0050 D10) ────────────────────────────────────
  // Session-local state + by-id run fetch live in the shared hook (see
  // components/chat/drill-in-header.tsx); cleared by the breadcrumb's back
  // button, or by an explicit conversation-list selection below.
  const { drillIn, setDrillIn, handleDrillIn, handleBack, runConversation, runLoadFailed } =
    useDrillInRun(sid, wid);

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
  // the auto-select effect can pick a successor. Skipped while the list could
  // be stale (refetch in flight after ConversationList's create/delete
  // invalidation): the freshly created id is absent from the stale list, and
  // resetting in that window would clobber the new selection — auto-select
  // would fall back to the OLD newest conversation.
  useEffect(() => {
    if (isFetching) return;
    if (selectedId !== null && selected === null && conversations.length > 0) {
      // Only clear once the list has settled (selected resolves after a tick).
      setSelectedId(null);
    }
  }, [selectedId, selected, conversations.length, isFetching]);

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
