import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Globe02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";

import { EditWorldDialog } from "@/components/world-hub/edit-world-dialog";
import { formatRelativeTime } from "@/lib/format";
import type { UpdateWorldInput } from "@/api";
import type { World } from "@/types";

interface WorldCardProps {
  world: World;
  onOpen: (world: World) => void;
  onUpdate: (world: World, input: UpdateWorldInput) => Promise<void>;
  onDelete: (world: World) => void;
}

function WorldCard({ world, onOpen, onUpdate, onDelete }: WorldCardProps) {
  const { t } = useTranslation(["world", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  async function handleUpdate(input: UpdateWorldInput) {
    await onUpdate(world, input);
  }

  return (
    <>
      <Card className="cursor-pointer transition-shadow hover:shadow-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={Globe02Icon}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <span className="truncate">{world.name}</span>
          </CardTitle>
          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => e.stopPropagation()}
                  />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                <span className="sr-only">{t("common:actions.moreActions")}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                  {t("world:card.editAction")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {t("world:card.deleteAction")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>
        <CardContent
          className="flex flex-1 flex-col gap-2"
          onClick={() => onOpen(world)}
        >
          <p className="line-clamp-2 min-h-8 flex-1 text-muted-foreground">
            {world.description || t("world:card.noDescription")}
          </p>
          <p className="text-xs text-muted-foreground/70">
            {formatRelativeTime(world.updatedAt)}
          </p>
        </CardContent>
      </Card>

      <EditWorldDialog
        world={editOpen ? world : null}
        open={editOpen}
        onOpenChange={setEditOpen}
        onUpdate={handleUpdate}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("world:card.deleteTitle", { name: world.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("world:card.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => onDelete(world)}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { WorldCard };
