import { useTranslation } from "react-i18next";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FormattedTime } from "@/components/timemapper/formatted-time";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlignLeftIcon,
  ArrowRight01Icon,
  Calendar03Icon,
  MapPinIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { TimelineEntry } from "@/types";

interface TimelineEntryCardProps {
  entry: TimelineEntry;
  /** Whether the "Open detail" action has a valid destination. */
  canOpenDetail: boolean;
  onOpenDetail: () => void;
}

/**
 * One compact card on the swimlane grid. Clicking opens a Popover with the
 * full entry context and an explicit "Open detail" action — the card itself
 * never navigates (prevents accidental jumps from the dense grid).
 *
 * Per ADR-0034: multi-character entries render one card per participant lane,
 * all at the same column index, so they auto-align vertically.
 */
function TimelineEntryCard({
  entry,
  canOpenDetail,
  onOpenDetail,
}: TimelineEntryCardProps) {
  const { t } = useTranslation(["timeline", "common"]);
  const isEvent = entry.kind === "event";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex h-full w-full flex-col gap-1 rounded-md border bg-card p-2 text-left outline-none transition-colors",
              "hover:border-primary/40 hover:bg-accent/40",
              "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
            )}
          />
        }
      >
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[0.625rem] font-medium",
              isEvent
                ? "bg-primary/10 text-primary"
                : "bg-secondary text-secondary-foreground",
            )}
          >
            {t(`timeline:kind.${entry.kind}`)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {entry.name}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <HugeiconsIcon
            icon={isEvent ? Calendar03Icon : AlignLeftIcon}
            strokeWidth={2}
            className="size-3 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">
            {entry.startAt ? (
              <FormattedTime iso={entry.startAt} />
            ) : (
              t("timeline:card.undated")
            )}
          </span>
        </div>
      </PopoverTrigger>

      <PopoverContent
        className="w-80 p-0"
        align="start"
        sideOffset={6}
      >
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
                isEvent
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              {t(`timeline:kind.${entry.kind}`)}
            </span>
            <h3 className="flex-1 text-sm font-semibold leading-tight">
              {entry.name}
            </h3>
          </div>

          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={Calendar03Icon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
              />
              {entry.startAt ? (
                <FormattedTime iso={entry.startAt} />
              ) : (
                t("timeline:card.undated")
              )}
              {entry.startAt && entry.endAt && (
                <>
                  <span aria-hidden>–</span>
                  <FormattedTime iso={entry.endAt} />
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={MapPinIcon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
              />
              {entry.locationName ?? t("timeline:card.noLocation")}
            </div>
          </div>

          {entry.descriptionExcerpt && (
            <p className="line-clamp-3 text-xs text-muted-foreground">
              {entry.descriptionExcerpt}
            </p>
          )}

          {entry.participants.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("timeline:card.participants")}
              </span>
              <div className="flex flex-wrap gap-1">
                {entry.participants.map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem]"
                  >
                    <HugeiconsIcon
                      icon={UserMultiple02Icon}
                      strokeWidth={2}
                      className="size-3 text-muted-foreground"
                    />
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          <CrossReferences entry={entry} />

          <Separator className="my-1" />

          <Button
            size="sm"
            variant={isEvent ? "default" : "secondary"}
            disabled={!canOpenDetail}
            onClick={onOpenDetail}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-start" />
            {canOpenDetail
              ? t("timeline:popover.openDetail")
              : t("timeline:popover.openDetailDisabled")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Renders the cross-reference annotations (narrated-by / narrates) + novel. */
function CrossReferences({ entry }: { entry: TimelineEntry }) {
  const { t } = useTranslation("timeline");
  const narratedBy = entry.narratedBySceneNames;
  const narrates = entry.narratedEventNames;

  const hasCrossRefs =
    (narratedBy && narratedBy.length > 0) ||
    (narrates && narrates.length > 0) ||
    entry.novelTitle;

  if (!hasCrossRefs) return null;

  return (
    <div className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
      {entry.novelTitle && (
        <div>
          <span className="font-medium">
            {t("timeline:card.novel")}:
          </span>{" "}
          {entry.novelTitle}
        </div>
      )}
      {narratedBy && narratedBy.length > 0 && (
        <div>
          <span className="font-medium">
            {t("timeline:card.narratedBy")}:
          </span>{" "}
          {narratedBy.join(", ")}
        </div>
      )}
      {narrates && narrates.length > 0 && (
        <div>
          <span className="font-medium">
            {t("timeline:card.narrates")}:
          </span>{" "}
          {narrates.join(", ")}
        </div>
      )}
    </div>
  );
}

export { TimelineEntryCard };
export type { TimelineEntryCardProps };
