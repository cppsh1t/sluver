import { useEffect, useState } from "react";
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
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  MapPinIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { TimelineEntry } from "@/types";

interface TimelineEntryCardProps {
  /** One or more entries collapsed into this (column, lane) cell. */
  entries: TimelineEntry[];
  /** Whether the "Open detail" action has a valid destination. */
  canOpenDetail: (entry: TimelineEntry) => boolean;
  onOpenDetail: (entry: TimelineEntry) => void;
}

/**
 * One compact card on the swimlane grid. Per ADR-0034 (refinement): entries
 * sharing the same `startAt` collapse into one column, so a single cell may
 * stack multiple entries. The card paginates through the stack with a count
 * badge + offset "stack" cue on the face, and a prev/next flipper in the
 * popover. A single-entry cell behaves exactly like the legacy card.
 *
 * Clicking opens a Popover with the full entry context and an explicit "Open
 * detail" action — the card itself never navigates (prevents accidental jumps
 * from the dense grid).
 */
function TimelineEntryCard({
  entries,
  canOpenDetail,
  onOpenDetail,
}: TimelineEntryCardProps) {
  const { t } = useTranslation(["timeline", "common"]);
  const [index, setIndex] = useState(0);

  const isMultiple = entries.length > 1;

  // Clamp the index whenever the entries array identity changes or shrinks so
  // the card can NEVER read `entries[undefined]`. Guarded with `entries.length`
  // to stay safe against an empty array (defensive — callers always pass 1+).
  useEffect(() => {
    setIndex((prev) => {
      if (entries.length === 0) return 0;
      return prev >= entries.length ? 0 : prev;
    });
  }, [entries]);

  const current = entries[Math.min(index, entries.length - 1)] ?? entries[0];
  const isEvent = current.kind === "event";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "relative flex h-full w-full flex-col gap-1 rounded-md border bg-card p-2 text-left outline-none transition-colors",
              "hover:border-primary/40 hover:bg-accent/40",
              "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
            )}
          />
        }
      >
        {/* Stacked-card cue: a second offset edge behind the card so the cell
            visibly reads as a stack when multiple entries share this time. */}
        {isMultiple && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 translate-x-1 translate-y-1 rounded-md border border-border/50 bg-muted/30 -z-10"
          />
        )}
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[0.625rem] font-medium",
              isEvent
                ? "bg-primary/10 text-primary"
                : "bg-secondary text-secondary-foreground",
            )}
          >
            {t(`timeline:kind.${current.kind}`)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {current.name}
          </span>
          {isMultiple && (
            <span className="shrink-0 rounded bg-primary/10 px-1 text-[0.625rem] font-medium text-primary">
              ×{entries.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <HugeiconsIcon
            icon={isEvent ? Calendar03Icon : AlignLeftIcon}
            strokeWidth={2}
            className="size-3 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">
            {current.startAt ? (
              <FormattedTime iso={current.startAt} />
            ) : (
              t("timeline:card.undated")
            )}
          </span>
        </div>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" align="start" sideOffset={6}>
        <div className="flex flex-col gap-2 p-3">
          {isMultiple && (
            <Flipper
              index={index}
              total={entries.length}
              onPrev={() =>
                setIndex((i) => (i - 1 + entries.length) % entries.length)
              }
              onNext={() => setIndex((i) => (i + 1) % entries.length)}
              hint={t("timeline:popover.multipleHint", {
                count: entries.length,
              })}
            />
          )}

          <div className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
                isEvent
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              {t(`timeline:kind.${current.kind}`)}
            </span>
            <h3 className="flex-1 text-sm font-semibold leading-tight">
              {current.name}
            </h3>
          </div>

          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={Calendar03Icon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
              />
              {current.startAt ? (
                <FormattedTime iso={current.startAt} />
              ) : (
                t("timeline:card.undated")
              )}
              {current.startAt && current.endAt && (
                <>
                  <span aria-hidden>–</span>
                  <FormattedTime iso={current.endAt} />
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={MapPinIcon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
              />
              {current.locationName ?? t("timeline:card.noLocation")}
            </div>
          </div>

          {current.descriptionExcerpt && (
            <p className="line-clamp-3 text-xs text-muted-foreground">
              {current.descriptionExcerpt}
            </p>
          )}

          {current.participants.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("timeline:card.participants")}
              </span>
              <div className="flex flex-wrap gap-1">
                {current.participants.map((name) => (
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

          <CrossReferences entry={current} />

          <Separator className="my-1" />

          <Button
            size="sm"
            variant={isEvent ? "default" : "secondary"}
            disabled={!canOpenDetail(current)}
            onClick={() => onOpenDetail(current)}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            {canOpenDetail(current)
              ? t("timeline:popover.openDetail")
              : t("timeline:popover.openDetailDisabled")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Prev/next flipper shown above the detail block when a cell stacks entries. */
function Flipper({
  index,
  total,
  onPrev,
  onNext,
  hint,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  hint: string;
}) {
  const { t } = useTranslation("timeline");
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onPrev}
        aria-label={t("popover.prev")}
        className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-3.5" />
      </button>
      <span className="shrink-0 text-[0.6875rem] font-medium text-muted-foreground">
        {t("popover.entryOf", { current: index + 1, total })}
      </span>
      <button
        type="button"
        onClick={onNext}
        aria-label={t("popover.next")}
        className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
      </button>
      <span className="min-w-0 flex-1 truncate text-[0.625rem] text-muted-foreground/70">
        {hint}
      </span>
    </div>
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
          <span className="font-medium">{t("card.novel")}:</span> {entry.novelTitle}
        </div>
      )}
      {narratedBy && narratedBy.length > 0 && (
        <div>
          <span className="font-medium">{t("card.narratedBy")}:</span>{" "}
          {narratedBy.join(", ")}
        </div>
      )}
      {narrates && narrates.length > 0 && (
        <div>
          <span className="font-medium">{t("card.narrates")}:</span>{" "}
          {narrates.join(", ")}
        </div>
      )}
    </div>
  );
}

export { TimelineEntryCard };
export type { TimelineEntryCardProps };
