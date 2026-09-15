/**
 * ChapterChatPanel — the right-side agent chat panel for the chapter
 * editor's EDIT mode.
 *
 * A compact single-surface chat: conversation switching and creation live
 * in a dropdown menu opened from the panel header's TOP-RIGHT corner
 * button — there is no dedicated list sidebar (the editor's center column
 * must stay the primary surface). Chapter-anchored conversations
 * (`kind: "chapter"` + `chapterId` in meta) are created orchestrator-bound;
 * the agent receives the chapter context automatically via the backend's
 * `<chapter_context>` prompt injection — this panel passes no context
 * itself.
 *
 * Composition mirrors `routes/world.$worldId/chat.tsx` (the canonical chat
 * surface): keyed ConversationView (duplicate-key bug, facebook/react#24871
 * — see the comment at the ConsentBanner below), un-keyed ConsentBanner,
 * Composer with the optimistic `pendingTurn` bridge, the same
 * `imageDeliveryDisabled` catalog join, and the SubagentDrillIn provider
 * (ADR-0050 D10) — the panel body swaps to the run transcript with a
 * breadcrumb header and NO composer.
 *
 * The conversation runtime lives in the Space-level provider (`_space.tsx`),
 * so in-flight runs survive panel collapse/expand and mode switches.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

import { toErrorPayload } from "@/api/client";
import { Composer } from "@/components/chat/composer";
import { ConsentBanner } from "@/components/chat/consent-banner";
import { ConversationView } from "@/components/chat/conversation-view";
import { DrillInHeader, useDrillInRun } from "@/components/chat/drill-in-header";
import type { PendingTurn } from "@/components/chat/message-render";
import { SubagentDrillInContext } from "@/components/chat/subagent-block";
import { TokenStatusBar } from "@/components/chat/token-status-bar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import {
  useAgentConfigs,
  useChapterConversations,
  useCreateConversation,
  useDeleteConversation,
  useModelsDevCatalog,
  useRenameConversation,
} from "@/hooks";
import {
  imageInputSupportedForModel,
  useRemoveConversation,
} from "@/lib/conversation-runtime";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  ChapterId,
  Conversation,
  ConversationId,
  NovelId,
  SpaceId,
  WorldId,
} from "@/types";

// ─── Panel ──────────────────────────────────────────────────────────────────

interface ChapterChatPanelProps {
  readonly spaceId: string;
  readonly worldId: WorldId;
  /** Accepted for API completeness; chapter anchoring only needs chapterId. */
  readonly novelId: NovelId;
  readonly chapterId: ChapterId;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
}

export function ChapterChatPanel({
  spaceId,
  worldId,
  chapterId,
  collapsed,
  onToggleCollapsed,
}: ChapterChatPanelProps) {
  const { t } = useTranslation(["chat", "common"]);
  const sid = spaceId as SpaceId;

  const { data: conversations = [], isFetching, isLoading } =
    useChapterConversations(spaceId, worldId, chapterId);
  const createMut = useCreateConversation(spaceId, worldId);
  const deleteMut = useDeleteConversation(spaceId, worldId);
  const renameMut = useRenameConversation(spaceId, worldId);
  const removeConversation = useRemoveConversation(worldId);

  const [selectedId, setSelectedId] = useState<ConversationId | null>(null);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);

  // ── Corner dropdown menu (conversation switching + creation) ────────────
  // Controlled so row clicks can close it programmatically; closing also
  // cancels any in-flight inline rename.
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

  // ── Subagent drill-in (ADR-0050 D10, shared with the chat route) ─────────
  // Session-local state + by-id run fetch live in the shared hook (see
  // drill-in-header.tsx); historical runs need the row so
  // `useEnsureRuntime` (inside ConversationView) can create the slot and
  // replay the transcript.
  const { drillIn, setDrillIn, handleDrillIn, handleBack, runConversation, runLoadFailed } =
    useDrillInRun(sid, worldId);

  // Resolve the full conversation object for the selection.
  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  // Vision capability join for the SELECTED conversation's bound model —
  // same shared queries the runtime Provider uses (plan D9 step 4);
  // `=== false` only: unknown (undefined) never badges.
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

  // Auto-select the first (newest) chapter conversation whenever nothing is
  // chosen — the backend orders the list `updated_at DESC`.
  useEffect(() => {
    if (selectedId !== null) return;
    if (conversations.length === 0) return;
    setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  // If the selected conversation was deleted (here or elsewhere), drop the
  // selection so the auto-select effect can pick a successor (after a panel
  // delete this lands on the newest remaining; deleting the last one leaves
  // the empty state). Gated on list freshness: right after `handleCreate`
  // the invalidated list is briefly stale (new id absent, refetch in
  // flight) — resetting in that window would clobber the new selection and
  // auto-select would fall back to the OLD newest conversation.
  useEffect(() => {
    if (isFetching || createMut.isPending) return;
    if (selectedId !== null && selected === null && conversations.length > 0) {
      setSelectedId(null);
    }
  }, [selectedId, selected, conversations.length, isFetching, createMut.isPending]);

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Create a new chapter-anchored conversation. Every user-facing
   * conversation is orchestrator-bound (ADR-0050 D1); `kind: "chapter"` +
   * `chapterId` make the backend inject `<chapter_context>` into prompts.
   * Async callback → global `i18n.t` (project rule).
   */
  async function handleCreate() {
    try {
      const conv = await createMut.mutateAsync({
        agentConfigName: "orchestrator",
        kind: "chapter",
        chapterId,
      });
      setDrillIn(null);
      setSelectedId(conv.id);
      setPendingTurn(null);
    } catch (e) {
      toast.error(i18n.t("chat:panel.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleConfirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    // Abort any in-flight run + drop the runtime slot BEFORE the IPC delete,
    // so the pending result.then() finds no data and no-ops (same reasoning
    // as conversation-list.tsx).
    removeConversation(target.id);
    try {
      await deleteMut.mutateAsync(target.id);
    } catch (e) {
      toast.error(i18n.t("common:actions.delete"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  /**
   * Commit the inline rename. No-op when the draft is empty or unchanged
   * after trimming (same guard as conversation-list.tsx). Async callbacks
   * use the global `i18n.t`, not the hook `t` (project rule).
   */
  async function commitRename(conv: Conversation) {
    const target = renaming;
    if (!target || target.id !== conv.id) return;
    setRenaming(null);
    const title = target.draft.trim();
    if (!title || title === (conv.title ?? "")) return;
    try {
      await renameMut.mutateAsync({ conversationId: conv.id, title });
      toast.success(i18n.t("chat:toast.renameSuccess"));
    } catch (e) {
      toast.error(i18n.t("chat:toast.renameFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  const handleRowSelect = useCallback((conv: Conversation) => {
    setDrillIn(null);
    setSelectedId(conv.id);
    setPendingTurn(null);
    setMenuOpen(false);
    // `setDrillIn` is the drill-in hook's useState setter — referentially
    // stable, listed only to satisfy exhaustive-deps.
  }, [setDrillIn]);

  // ── Collapsed rail (same idea as scene-ref-sidebar) ─────────────────────
  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l bg-background py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={t("chat:panel.expand")}
          title={t("chat:panel.expand")}
          className="text-xs text-muted-foreground [writing-mode:vertical-lr] hover:text-foreground"
        >
          {t("chat:panel.title")}
        </button>
      </div>
    );
  }

  return (
    <aside className="flex w-[clamp(24rem,30vw,34rem)] shrink-0 flex-col border-l bg-background">
      {/* ── Header: title + collapse + corner conversation menu ─────────── */}
      <div className="flex items-center justify-between gap-1 border-b px-3 py-1.5">
        <h2 className="truncate text-sm font-semibold tracking-tight">
          {t("chat:panel.title")}
        </h2>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={t("chat:panel.collapse")}
            title={t("chat:panel.collapse")}
            className="rounded p-1 text-xs text-muted-foreground hover:text-foreground"
          >
            »
          </button>
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (!open) setRenaming(null);
            }}
          >
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              <span className="sr-only">{t("chat:panel.menuLabel")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem
                onClick={() => handleCreate()}
                disabled={createMut.isPending}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("chat:list.new")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* base-ui: MenuGroupLabel requires an ancestor Menu.Group —
                  a bare label crashes the menu on open. The group also wires
                  aria-labelledby to the label. Children keep their indent to
                  keep this hotfix diff minimal. */}
              <DropdownMenuGroup>
              <DropdownMenuLabel>{t("chat:panel.conversationsLabel")}</DropdownMenuLabel>
              {conversations.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("chat:panel.menuEmpty")}
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {conversations.map((conv) => {
                    const active = conv.id === selectedId;
                    const isRenaming = renaming?.id === conv.id;
                    return (
                      <div key={conv.id}>
                        {isRenaming ? (
                          <Input
                            autoFocus
                            value={renaming?.draft ?? ""}
                            maxLength={100}
                            onChange={(e) => {
                              // Read `currentTarget` synchronously BEFORE the
                              // state update (React nulls it after dispatch —
                              // same note as conversation-list.tsx).
                              const value = e.currentTarget.value;
                              setRenaming((r) =>
                                r && r.id === conv.id
                                  ? { ...r, draft: value }
                                  : r,
                              );
                            }}
                            onBlur={() => commitRename(conv)}
                            onKeyDown={(e) => {
                              // Stop EVERY keystroke from bubbling: base-ui
                              // menus own arrow-key navigation and typeahead
                              // at the popup level — typing in the rename
                              // field must stay in the field.
                              e.stopPropagation();
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename(conv);
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setRenaming(null);
                              }
                            }}
                            className="h-6 min-w-0 px-1 text-xs"
                          />
                        ) : (
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => handleRowSelect(conv)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleRowSelect(conv);
                              }
                            }}
                            aria-current={active ? "true" : undefined}
                            className={cn(
                              "group/conv-row flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 outline-none transition-colors",
                              "focus-visible:ring-2 focus-visible:ring-ring/30",
                              active
                                ? "bg-accent text-accent-foreground"
                                : "text-foreground/90 hover:bg-accent/60",
                            )}
                          >
                            <HugeiconsIcon
                              icon={Tick02Icon}
                              strokeWidth={2}
                              className={cn(
                                "size-3.5 shrink-0 text-primary",
                                !active && "invisible",
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {conv.title ?? t("chat:list.untitled")}
                            </span>
                            <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                              {formatRelativeTime(conv.updatedAt)}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenaming({
                                  id: conv.id,
                                  draft: conv.title ?? "",
                                });
                              }}
                              aria-label={t("chat:list.rename")}
                              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/30 group-hover/conv-row:opacity-100"
                            >
                              <HugeiconsIcon
                                icon={PencilEdit01Icon}
                                strokeWidth={2}
                                className="size-3.5"
                              />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpen(false);
                                setPendingDelete(conv);
                              }}
                              aria-label={t("common:actions.delete")}
                              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/30 group-hover/conv-row:opacity-100"
                            >
                              <HugeiconsIcon
                                icon={Delete02Icon}
                                strokeWidth={2}
                                className="size-3.5"
                              />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Body: conversation view / drill-in transcript / empty ────────── */}
      {/* Drill-in context: dispatch blocks inside the rendered conversation
          raise drill-in through this. Without a provider the context's
          no-op default would leave the block header a dead button, so the
          panel provides the swap-with-back-button behavior itself. */}
      <SubagentDrillInContext.Provider value={handleDrillIn}>
        <div className="flex min-h-0 flex-1 flex-col">
          {drillIn ? (
            <>
              <DrillInHeader worldId={worldId} target={drillIn} onBack={handleBack} />
              {runConversation ? (
                <>
                  <ConversationView
                    key={runConversation.id}
                    worldId={worldId}
                    conversation={runConversation}
                    pendingTurn={null}
                    onPendingUserConsumed={() => {}}
                    imageDeliveryDisabled={false}
                  />
                  {/* No `key` here — same duplicate-key rule as the banner
                      below; the banner resets its carousel index internally
                      on conversation change. */}
                  <ConsentBanner worldId={worldId} conversationId={runConversation.id} />
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
          ) : isLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <span className="inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-foreground" />
              {t("common:loading")}
            </div>
          ) : selected ? (
            <>
              <ConversationView
                key={selected.id}
                worldId={worldId}
                conversation={selected}
                pendingTurn={pendingTurn}
                onPendingUserConsumed={() => setPendingTurn(null)}
                imageDeliveryDisabled={imageDeliveryDisabled}
              />
              {/* Do NOT add a `key={selected.id}` here: it would duplicate the
                  keyed ConversationView's key value among siblings — the
                  reconciler drops DOM tracking on key change and orphan
                  conversation DOM stacks up on every switch
                  (facebook/react#24871). The banner resets its carousel
                  index internally on conversation change instead. */}
              <ConsentBanner worldId={worldId} conversationId={selected.id} />
              <Composer
                worldId={worldId}
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
                    worldId={worldId}
                    conversationId={selected.id}
                    agentConfigName={selected.agentConfigName}
                  />
                }
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="max-w-xs text-sm text-muted-foreground">
                {t("chat:panel.empty")}
              </p>
              <Button onClick={() => handleCreate()} disabled={createMut.isPending}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                {t("chat:panel.emptyAction")}
              </Button>
            </div>
          )}
        </div>
      </SubagentDrillInContext.Provider>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:list.deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.title ?? t("chat:list.untitled")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleConfirmDelete}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

export type { ChapterChatPanelProps };
