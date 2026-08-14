import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { FormattedTime } from "@/components/timemapper/formatted-time";
import { TimelineEntryCard } from "./timeline-entry-card";
import { TimelineLaneHeader } from "./timeline-lane-header";
import { cn } from "@/lib/utils";
import type { Character, TimelineEntry, TimelineLane, WorldId } from "@/types";

interface TimelineGridProps {
  entries: TimelineEntry[];
  lanes: TimelineLane[];
  visibleLaneIds: Set<string>;
  charactersById: Map<string, Character>;
  spaceId: string;
  worldId: WorldId;
  canOpenDetail: (entry: TimelineEntry) => boolean;
  onOpenDetail: (entry: TimelineEntry) => void;
}

/** Lane-label column width (CSS) — wide enough for the compact character card. */
const LANE_LABEL_COL = "14rem";
/** Fixed min width of each entry column. */
const ENTRY_COL_MIN = "13rem";
/** Sentinel grouping key for all undated (null-startAt) entries. */
const UNDATED_KEY = "__undated__";

interface EntryGroup {
  key: string;
  entries: TimelineEntry[];
  isUndated: boolean;
}

/**
 * The uniform character-swimlane grid (ADR-0034).
 *
 * One horizontal row per visible Character lane; every distinct `startAt`
 * occupies exactly one equal-width column on a shared chronological-order
 * axis — NOT time-proportionate. Column index N = the Nth distinct time in
 * the backend-sorted array (startAt ASC NULLS LAST). Entries sharing a
 * `startAt` collapse into ONE column; within a lane's cell, ONE card paginates
 * through the stacked entries. A multi-character entry renders one card per
 * participant lane, all at the same column index, so they auto-align
 * vertically (the "convergence" reading) with no connectors.
 *
 * Layout is pure CSS Grid with explicit cell placement — no hand-rolled
 * coordinate math, no SVG geometry. Zero-participant entries drop into a
 * bottom "Unassigned" lane; undated entries occupy the right-end "Undated"
 * zone (already last in the sorted array) marked by a visual divider.
 */
function TimelineGrid({
  entries,
  lanes,
  visibleLaneIds,
  charactersById,
  spaceId,
  worldId,
  canOpenDetail,
  onOpenDetail,
}: TimelineGridProps) {
  const { t } = useTranslation("timeline");

  // name → characterId (Character.name is unique within a World, so this is safe).
  const nameToLaneId = useMemo(() => {
    const m = new Map<string, string>();
    for (const lane of lanes) m.set(lane.name, lane.characterId);
    return m;
  }, [lanes]);

  // Visible lanes preserve the backend's participation-DESC ordering.
  const visibleLanes = useMemo(
    () => lanes.filter((l) => visibleLaneIds.has(l.characterId)),
    [lanes, visibleLaneIds],
  );

  // characterId → grid row (header is row 1; lanes start at row 2).
  const laneRow = useMemo(() => {
    const m = new Map<string, number>();
    visibleLanes.forEach((l, i) => m.set(l.characterId, i + 2));
    return m;
  }, [visibleLanes]);

  // Group entries by distinct startAt, preserving first-occurrence order from
  // the already-sorted array (startAt ASC NULLS LAST). All null-startAt entries
  // collapse into a single undated bucket. One column per group.
  const groups = useMemo(() => {
    const result: EntryGroup[] = [];
    const indexByKey = new Map<string, number>();
    for (const entry of entries) {
      const isUndated = entry.startAt === null;
      const key = entry.startAt ?? UNDATED_KEY;
      const idx = indexByKey.get(key);
      if (idx !== undefined) {
        result[idx].entries.push(entry);
      } else {
        indexByKey.set(key, result.length);
        result.push({ key, entries: [entry], isUndated });
      }
    }
    return result;
  }, [entries]);

  // True when ANY entry is zero-participant OR has only hidden-participant
  // lanes. Such entries surface in a bottom "Unassigned" lane so their column
  // isn't an unexplained empty cell.
  const hasUnassignedLane = useMemo(
    () =>
      entries.some((e) => {
        if (e.participants.length === 0) return true;
        return !e.participants.some((name) => {
          const laneId = nameToLaneId.get(name);
          return !!laneId && laneRow.has(laneId);
        });
      }),
    [entries, nameToLaneId, laneRow],
  );

  const unassignedRow = visibleLanes.length + 2; // row 1 = header

  // Index of the first undated group — the boundary of the "Undated" zone.
  const undatedStartCol = useMemo(() => {
    const idx = groups.findIndex((g) => g.isUndated);
    return idx >= 0 ? idx + 2 : -1; // +2: label col + 1-based
  }, [groups]);

  // Flat placement list: ONE card per (group × lane) cell, carrying the
  // cell's stacked entries. This is what gives multi-character entries their
  // per-lane cards at a shared column, and collapses same-time entries into
  // one paginated card.
  const placements = useMemo(() => {
    const cards: Array<{
      key: string;
      entries: TimelineEntry[];
      row: number;
      col: number;
      hidden?: boolean;
    }> = [];

    for (const lane of visibleLanes) {
      const row = laneRow.get(lane.characterId);
      if (row === undefined) continue;
      groups.forEach((group, colIdx) => {
        const col = colIdx + 2;
        const cellEntries = group.entries.filter((e) =>
          e.participants.some(
            (name) => nameToLaneId.get(name) === lane.characterId,
          ),
        );
        if (cellEntries.length > 0) {
          cards.push({
            key: `${group.key}-${lane.characterId}-${col}`,
            entries: cellEntries,
            row,
            col,
          });
        }
      });
    }

    // Unassigned lane: zero-participant entries + all-hidden-participant entries.
    if (hasUnassignedLane) {
      groups.forEach((group, colIdx) => {
        const col = colIdx + 2;
        const unassignedEntries = group.entries.filter((e) => {
          if (e.participants.length === 0) return true;
          return !e.participants.some((name) => {
            const laneId = nameToLaneId.get(name);
            return !!laneId && laneRow.has(laneId);
          });
        });
        if (unassignedEntries.length === 0) return;
        // Mark `hidden` when EVERY entry in the cell is an all-hidden-participant
        // entry (has participants but none visible) — uses the dashed placeholder.
        // A cell with any zero-participant entry renders as a normal card.
        const allHidden = unassignedEntries.every(
          (e) => e.participants.length > 0,
        );
        cards.push({
          key: `${group.key}-unassigned-${col}`,
          entries: unassignedEntries,
          row: unassignedRow,
          col,
          hidden: allHidden || undefined,
        });
      });
    }

    return cards;
  }, [
    groups,
    visibleLanes,
    laneRow,
    nameToLaneId,
    hasUnassignedLane,
    unassignedRow,
  ]);

  const n = groups.length;
  const contentRowCount = visibleLanes.length + (hasUnassignedLane ? 1 : 0);

  if (contentRowCount === 0) {
    // No visible lanes and nothing unassigned — entries exist but every lane
    // is hidden. Surface a hint rather than a bare header strip.
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t("lane.selectNone")}
      </div>
    );
  }

  const gridTemplateColumns = `${LANE_LABEL_COL} repeat(${n}, minmax(${ENTRY_COL_MIN}, 1fr))`;
  const gridTemplateRows = `2.25rem repeat(${contentRowCount}, minmax(5rem, auto))`;

  return (
    <div className="overflow-x-auto rounded-lg border">
      <div
        className="relative z-0 grid gap-1 p-1"
        style={{ gridTemplateColumns, gridTemplateRows }}
      >
        {/* ─── Guide lines (graph-paper feel) ─────────────────────────────── */}
        {/* Vertical column rules — PRIMARY time-axis aid. One per entry column,
            full height, behind cards. Skip the undated-boundary column (the
            heavier dashed divider marks it) and the label column (label cells
            carry their own border-r). */}
        {groups.map((_, colIdx) => {
          const col = colIdx + 2;
          if (col === undatedStartCol) return null;
          return (
            <div
              key={`vrule-${col}`}
              aria-hidden
              className={cn(
                "pointer-events-none border-l border-border/30 -z-10",
                col >= undatedStartCol && undatedStartCol > 0 && "bg-muted/20",
              )}
              style={{ gridColumn: col, gridRow: "1 / -1" }}
            />
          );
        })}
        {/* Horizontal lane separators — secondary, very subtle. One per content
            row boundary, full width, behind cards. */}
        {Array.from({ length: contentRowCount }).map((_, i) => (
          <div
            key={`hsep-${i}`}
            aria-hidden
            className="pointer-events-none border-t border-border/20 -z-10"
            style={{ gridColumn: "1 / -1", gridRow: i + 2 }}
          />
        ))}

        {/* ─── Header ─────────────────────────────────────────────────────── */}
        {/* Header corner */}
        <div
          className="sticky left-0 z-10 flex items-center bg-background px-2 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/70"
          style={{ gridColumn: 1, gridRow: 1 }}
        >
          {t("axis.time")}
        </div>

        {/* Header axis: one time cell per GROUP column */}
        {groups.map((group, colIdx) => {
          const col = colIdx + 2;
          const isUndatedBoundary = col === undatedStartCol;
          const first = group.entries[0];
          return (
            <div
              key={`h-${group.key}`}
              className={cn(
                "flex min-w-0 items-center px-1.5 text-[0.6875rem] text-muted-foreground",
                col >= undatedStartCol && undatedStartCol > 0 && "bg-muted/30",
              )}
              style={{ gridColumn: col, gridRow: 1 }}
            >
              {isUndatedBoundary && (
                <span className="mr-1 shrink-0 rounded bg-muted px-1 py-px text-[0.5625rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("axis.undated")}
                </span>
              )}
              <span className="min-w-0 truncate">
                {first.startAt ? (
                  <FormattedTime iso={first.startAt} />
                ) : (
                  t("card.undated")
                )}
              </span>
            </div>
          );
        })}

        {/* ─── Lane labels (sticky left) ──────────────────────────────────── */}
        {visibleLanes.map((lane, i) => (
          <div
            key={`lab-${lane.characterId}`}
            className="sticky left-0 z-10 min-w-0 border-r bg-background"
            style={{ gridColumn: 1, gridRow: i + 2 }}
          >
            <TimelineLaneHeader
              lane={lane}
              character={charactersById.get(lane.characterId)}
              spaceId={spaceId}
              worldId={worldId}
            />
          </div>
        ))}

        {/* Unassigned lane label */}
        {hasUnassignedLane && (
          <div
            className="sticky left-0 z-10 flex items-center truncate border-r bg-background/80 px-2 text-xs italic text-muted-foreground"
            style={{ gridColumn: 1, gridRow: unassignedRow }}
          >
            {t("lane.unassigned")}
          </div>
        )}

        {/* ─── Cards ──────────────────────────────────────────────────────── */}
        {placements.map(({ key, entries: cellEntries, row, col, hidden }) => (
          <div
            key={key}
            className="relative min-w-0"
            style={{ gridColumn: col, gridRow: row }}
          >
            {hidden ? (
              <HiddenStackPlaceholder entries={cellEntries} />
            ) : (
              <TimelineEntryCard
                entries={cellEntries}
                canOpenDetail={canOpenDetail}
                onOpenDetail={onOpenDetail}
              />
            )}
          </div>
        ))}

        {/* Undated-zone vertical divider overlay (full height) */}
        {undatedStartCol > 0 && (
          <div
            aria-hidden
            className="pointer-events-none relative border-l-2 border-dashed border-border"
            style={{ gridColumn: undatedStartCol, gridRow: `1 / -1` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Lightweight stack-aware placeholder for cells where every entry's
 * participant lanes are hidden. No popover — just the current entry's name +
 * kind + a count pill when multiple, with the dashed "hidden" treatment.
 */
function HiddenStackPlaceholder({ entries }: { entries: TimelineEntry[] }) {
  const { t } = useTranslation("timeline");
  const current = entries[0];
  const isMultiple = entries.length > 1;

  return (
    <div
      title={t("card.lanesHidden")}
      className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 p-2 text-center opacity-70"
    >
      <div className="flex w-full items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-muted-foreground">
          {current.name}
        </span>
        {isMultiple && (
          <span className="shrink-0 rounded bg-muted px-1 text-[0.625rem] font-medium text-muted-foreground">
            ×{entries.length}
          </span>
        )}
      </div>
      <span className="text-[0.5625rem] text-muted-foreground/70">
        {t(`kind.${current.kind}`)}
      </span>
    </div>
  );
}

export { TimelineGrid };
export type { TimelineGridProps };
