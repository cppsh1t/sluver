/**
 * Conversation list — the left-pane picker for one world's conversations.
 *
 * Server state via React Query (`useConversations` / `useCreateConversation` /
 * `useDeleteConversation`); selection is lifted to the parent route. Creating
 * a conversation first picks a role (explorer / writer) via a dropdown, since
 * the role fixes the conversation's bound agent config.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Compass01Icon,
  Delete02Icon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";

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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useConversations,
  useCreateConversation,
  useDeleteConversation,
} from "@/hooks";
import { useRemoveConversation } from "@/lib/conversation-runtime";
import { formatRelativeTime } from "@/lib/format";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationId, SpaceId, WorldId } from "@/types";

const ROLES = ["explorer", "writer"] as const;
type Role = (typeof ROLES)[number];

interface ConversationListProps {
  readonly spaceId: SpaceId;
  readonly worldId: WorldId;
  readonly selectedId: ConversationId | null;
  readonly onSelect: (conversation: Conversation) => void;
}

/** Compact role badge for a list row. */
function RoleBadge({ role }: { readonly role: Role }) {
  const { t } = useTranslation("chat");
  const icon = role === "explorer" ? Compass01Icon : Edit02Icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-secondary px-1 py-px text-[0.625rem] font-medium text-secondary-foreground">
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-2.5" />
      {t(`chat:role.${role}`)}
    </span>
  );
}

export function ConversationList({
  spaceId,
  worldId,
  selectedId,
  onSelect,
}: ConversationListProps) {
  const { t } = useTranslation(["chat", "common"]);
  const { data: conversations = [], isLoading } = useConversations(spaceId, worldId);
  const createMut = useCreateConversation(spaceId, worldId);
  const deleteMut = useDeleteConversation(spaceId, worldId);
  const removeConversation = useRemoveConversation(worldId);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

  // Most-recently-updated first.
  const sorted = useMemo(
    () =>
      [...conversations].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      ),
    [conversations],
  );

  async function handleCreate(role: Role) {
    try {
      const conv = await createMut.mutateAsync({
        agentConfigName: role,
        kind: "world",
      });
      onSelect(conv);
    } catch (e) {
      toast.error(t("chat:error.sendFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleConfirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    // Abort any in-flight run + drop the runtime slot BEFORE the IPC delete,
    // so the pending result.then() finds no data and no-ops — otherwise the
    // doomed run keeps consuming tokens and its final persist hits an FK
    // violation on the already-deleted conversation row.
    removeConversation(target.id);
    try {
      await deleteMut.mutateAsync(target.id);
    } catch (e) {
      toast.error(t("common:actions.delete"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{t("chat:title")}</h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" aria-label={t("chat:list.new")}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("chat:list.new")}
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>{t("chat:role.pickerLabel")}</DropdownMenuLabel>
            {ROLES.map((role) => (
              <DropdownMenuItem
                key={role}
                onClick={() => handleCreate(role)}
                disabled={createMut.isPending}
              >
                <HugeiconsIcon
                  icon={role === "explorer" ? Compass01Icon : Edit02Icon}
                  strokeWidth={2}
                />
                {t(`chat:role.${role}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading ? (
          <div className="flex flex-col gap-1 px-1 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md bg-muted/50"
              />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t("chat:list.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sorted.map((conv) => {
              const active = conv.id === selectedId;
              const role = conv.agentConfigName === "writer" ? "writer" : "explorer";
              return (
                <li key={conv.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(conv)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(conv);
                      }
                    }}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "group relative flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 outline-none transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-ring/30",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground/90 hover:bg-accent/60",
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-primary"
                      />
                    )}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "flex-1 truncate text-sm",
                          active ? "font-medium" : "font-normal",
                        )}
                      >
                        {conv.title ?? t("chat:list.untitled")}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(conv);
                        }}
                        aria-label={t("common:actions.delete")}
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/30 group-hover:opacity-100"
                      >
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          strokeWidth={2}
                          className="size-3.5"
                        />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <RoleBadge role={role} />
                      <span className="text-[0.625rem] text-muted-foreground">
                        {formatRelativeTime(conv.updatedAt)}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
