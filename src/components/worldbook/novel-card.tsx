import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
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
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  BookOpen01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { formatRelativeTime } from "@/lib/format";
import type { Novel, WorldId } from "@/types";

interface NovelCardProps {
  novel: Novel;
  worldId: WorldId;
  onDelete?: () => void;
}

function NovelCard({ novel, worldId, onDelete }: NovelCardProps) {
  const { t } = useTranslation(["novel", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const entityName = t("novel:entityName.singular");

  const visibleTags = novel.tags.slice(0, 3);
  const extraCount = novel.tags.length - 3;
  const chapterCount = novel.chapterIds.length;

  const chaptersText =
    chapterCount === 0
      ? t("novel:card.noChapters")
      : chapterCount === 1
        ? t("novel:card.oneChapter")
        : t("novel:card.chaptersCount", { count: chapterCount });

  return (
    <>
      <Link
        to={"/world/$worldId/novels/$novelId" as const}
        params={{ worldId, novelId: novel.id }}
        className="block h-full"
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon
                icon={BookOpen01Icon}
                strokeWidth={2}
                className="text-muted-foreground"
              />
              <span className="truncate">{novel.title}</span>
            </CardTitle>
            <CardAction>
              <DropdownMenu>
                <DropdownMenuTrigger
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  <span className="sr-only">{t("common:actions.moreActions")}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setConfirmOpen(true);
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    {t("novel:card.deleteAction")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-2">
            <p className="text-xs text-muted-foreground">{chaptersText}</p>
            <p className="line-clamp-2 min-h-8 flex-1 text-sm text-muted-foreground">
              {novel.description}
            </p>
            {novel.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
                {extraCount > 0 && (
                  <span className="px-1.5 py-0.5 text-xs text-muted-foreground/70">
                    +{extraCount}
                  </span>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground/70">
              {formatRelativeTime(novel.updatedAt)}
            </p>
          </CardContent>
        </Card>
      </Link>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("novel:card.deleteTitle", { entity: entityName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {chapterCount > 0
                ? t("novel:card.deleteDescription", {
                    name: novel.title,
                    count: chapterCount,
                  })
                : t("novel:card.deleteDescription", {
                    name: novel.title,
                    count: 0,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete?.();
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { NovelCard };
