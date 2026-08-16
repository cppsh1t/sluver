/**
 * Chat route — world-scoped AI assistant workspace.
 *
 * Two-pane layout: conversation list (left) + conversation view with composer
 * (right). Selection is local route state; the conversation runtime lives in
 * the Space-level provider (`_space.tsx`), so in-flight runs survive
 * navigation between conversations and worlds.
 *
 * The optimistic `pendingUserText` bridges the runtime's send→finalize gap:
 * `send` appends the user message to the Agent thread immediately, but the
 * reactive `view.messages` only refreshes on run finalization. The view echoes
 * the text optimistically and clears it once the persisted thread catches up.
 */

import { useEffect, useMemo, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { worldLayoutRoute } from "./_world";

import { Composer } from "@/components/chat/composer";
import { ConsentBanner } from "@/components/chat/consent-banner";
import { ConversationList } from "@/components/chat/conversation-list";
import { ConversationView } from "@/components/chat/conversation-view";
import { TokenStatusBar } from "@/components/chat/token-status-bar";
import { useConversations } from "@/hooks";
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
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);

  // Resolve the full conversation object for the selection (needed to
  // construct/ensure the runtime). Falls back to null when absent.
  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

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
    setPendingUserText(null);
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
              pendingUserText={pendingUserText}
              onPendingUserConsumed={() => setPendingUserText(null)}
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
              onUserSent={setPendingUserText}
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
