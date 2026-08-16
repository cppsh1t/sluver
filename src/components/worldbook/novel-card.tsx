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
  BookDownloadIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { formatCompactCount, formatRelativeTime } from "@/lib/format";
import { EntityAvatar } from "@/components/ui/entity-avatar";
import { ExportNovelDialog } from "@/components/worldbook/export-novel-dialog";
import type { Novel, SpaceId, WorldId } from "@/types";

interface NovelCardProps {
  novel: Novel;
  spaceId: string;
  worldId: WorldId;
  onDelete?: () => void;
}

function NovelCard({ novel, spaceId, worldId, onDelete }: NovelCardProps) {
  const { t, i18n } = useTranslation(["novel", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
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

  const wordCountText = t("novel:card.wordCount", {
    count: formatCompactCount(novel.wordCount, i18n.language),
  });

  return (
    <>
      <Link
        to={"/space/$spaceId/world/$worldId/novels/$novelId" as const}
        params={{ spaceId, worldId, novelId: novel.id }}
        className="block h-full"
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <EntityAvatar
                kind="novel"
                spaceId={spaceId as SpaceId}
                worldId={worldId}
                id={novel.id}
                alt={novel.title}
                fallbackIcon={
                  <HugeiconsIcon
                    icon={BookOpen01Icon}
                    strokeWidth={2}
                    className="size-5 text-muted-foreground"
                  />
                }
                className="size-9 shrink-0 rounded-md"
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
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setExportOpen(true);
                    }}
                  >
                    <HugeiconsIcon icon={BookDownloadIcon} strokeWidth={2} />
                    {t("novel:export.menuItem")}
                  </DropdownMenuItem>
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
            <p className="text-xs text-muted-foreground">
              {chaptersText} · {wordCountText}
            </p>
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

      <ExportNovelDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        novel={{ id: novel.id, title: novel.title }}
        spaceId={spaceId}
        worldId={worldId}
      />
    </>
  );
}

export { NovelCard };
