import { useState } from "react";

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
                <span className="sr-only">更多操作</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                  编辑世界
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
                  删除世界
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
            {world.description || "暂无简介"}
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
            <AlertDialogTitle>删除「{world.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销。该世界下的所有角色、地点、物品、传说、事件及小说数据将被永久删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => onDelete(world)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { WorldCard };
