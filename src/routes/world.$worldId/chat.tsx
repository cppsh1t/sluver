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
 */

import { useEffect, useMemo, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { worldLayoutRoute } from "./_world";

import { Composer } from "@/components/chat/composer";
import { ConsentBanner } from "@/components/chat/consent-banner";
import { ConversationList } from "@/components/chat/conversation-list";
import { ConversationView } from "@/components/chat/conversation-view";
import type { PendingTurn } from "@/components/chat/message-render";
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

  const { data: conversations = [] } = useConversations(sid, wid);

  const [selectedId, setSelectedId] = useState<ConversationId | null>(null);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);

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
    const modelId =
      agentConfigsData?.find((a) => a.name === selectedRole)?.modelId ?? null;
    return imageInputSupportedForModel(catalogData, modelId) === false;
  }, [agentConfigsData, catalogData, selectedRole]);

  // Auto-select the most-recently-updated conversation when nothing is chosen.
  useEffect(() => {
    if (selectedId !== null) return;
    if (conversations.length === 0) return;
    const newest = [...conversations].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )[0];
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

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
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
            <p className="max-w-xs text-sm text-muted-foreground">
              {t("chat:list.empty")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export const chatRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "chat",
  component: ChatPage,
});
