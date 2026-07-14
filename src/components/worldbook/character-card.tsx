import { useState } from "react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { formatRelativeTime } from "@/lib/format";

interface CharacterCardProps {
  name: string;
  aliases: string[];
  description: string;
  tags: string[];
  phaseCount: number;
  updatedAt: string;
  onClick: () => void;
  onDelete: () => void;
}

function CharacterCard({
  name,
  aliases,
  description,
  tags,
  phaseCount,
  updatedAt,
  onClick,
  onDelete,
}: CharacterCardProps) {
  const { t } = useTranslation(["character", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const visibleTags = tags.slice(0, 3);
  const extraCount = tags.length - 3;

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={UserMultiple02Icon}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <span className="truncate">{name}</span>
          </CardTitle>
          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                onClick={(e) => e.stopPropagation()}
                render={
                  <Button variant="ghost" size="icon-sm" />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                <span className="sr-only">{t("common:actions.moreActions")}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick();
                  }}
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                  {t("character:card.editAction")}
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
                  {t("character:card.deleteAction")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-2">
          {aliases.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("character:card.aliasesLabel")}: {aliases.join(", ")}
            </p>
          )}
          <p className="line-clamp-2 min-h-8 flex-1 text-sm text-muted-foreground">
            {description}
          </p>
          <span className="inline-flex w-fit items-center rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {t("character:card.phaseCount", { count: phaseCount })}
          </span>
          {tags.length > 0 && (
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
            {formatRelativeTime(updatedAt)}
          </p>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("character:card.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("character:card.deleteDescription", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
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

export { CharacterCard };
