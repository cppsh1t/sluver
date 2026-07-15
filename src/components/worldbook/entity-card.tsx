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
  BookOpen02Icon,
  Cancel01Icon,
  Delete02Icon,
  MapPinIcon,
  MoreHorizontalIcon,
  Package02Icon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const ENTITY_ICONS = {
  location: MapPinIcon,
  item: Package02Icon,
  lore: BookOpen02Icon,
} as const;

interface EntityCardProps {
  name: string;
  description: string;
  tags: string[];
  updatedAt: string;
  entityType: "location" | "item" | "lore";
  onEdit?: () => void;
  onDelete?: () => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
}

function EntityCard({
  name,
  description,
  tags,
  updatedAt,
  entityType,
  onEdit,
  onDelete,
  selectable,
  selected,
  onSelect,
  onRemove,
}: EntityCardProps) {
  const { t } = useTranslation(["worldbook", "common"]);
  const entityName = t(`worldbook:entityName.${entityType}.singular`);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const Icon = ENTITY_ICONS[entityType];

  const visibleTags = tags.slice(0, 3);
  const extraCount = tags.length - 3;

  return (
    <>
      <Card
        onClick={selectable ? onSelect : undefined}
        className={cn(
          selectable && "relative cursor-pointer",
          selected && "ring-2 ring-primary",
        )}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={Icon}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <span className="truncate">{name}</span>
          </CardTitle>
          {!selectable && (
            <CardAction>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" />
                  }
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  <span className="sr-only">{t("common:actions.moreActions")}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onEdit}>
                    <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                    {t("worldbook:card.editAction")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmOpen(true)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    {t("worldbook:card.deleteAction")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-2">
          <p className="line-clamp-2 min-h-8 flex-1 text-sm text-muted-foreground">
            {description}
          </p>
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

        {selectable && selected && !onRemove && (
          <HugeiconsIcon
            icon={Tick02Icon}
            strokeWidth={2}
            className="absolute top-2 right-2 size-4 text-primary"
          />
        )}
        {selectable && onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
          </button>
        )}
      </Card>

      {!selectable && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("worldbook:card.deleteTitle", { entity: entityName })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("worldbook:card.deleteDescription", { entity: entityName, name })}
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
      )}
    </>
  );
}

export { EntityCard };
