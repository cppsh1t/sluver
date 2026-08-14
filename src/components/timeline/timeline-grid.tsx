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

/**
 * The uniform character-swimlane grid (ADR-0034).
 *
 * One horizontal row per visible Character lane; every entry (Event or Scene)
 * occupies exactly one equal-width column on a shared chronological-order
 * axis — NOT time-proportionate. Column index N = the Nth entry in the
 * backend-sorted array (startAt ASC NULLS LAST). A multi-character entry
 * renders one card per participant lane, all at the same column index, so they
 * auto-align vertically (the "convergence" reading) with no connectors.
 *
 * Layout is pure CSS Grid with explicit cell placement — no hand-rolled
 * coordinate math, no SVG geometry. Zero-participant entries drop into a bottom
 * "Unassigned" lane; undated entries occupy the right-end "Undated" zone
 * (already last in the sorted array) marked by a visual divider.
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

  // Entries WITH participants but where every participant's lane is hidden (or
  // unrecognized). Without intervention these would produce zero cards yet still
  // occupy a column — an unexplained empty cell. They are surfaced as distinct
  // placeholders in the Unassigned lane (Issue 1).
  const hiddenParticipantEntries = useMemo(() => {
    const hidden: TimelineEntry[] = [];
    for (const entry of entries) {
      if (entry.participants.length === 0) continue;
      const anyVisible = entry.participants.some((name) => {
        const laneId = nameToLaneId.get(name);
        return !!laneId && laneRow.has(laneId);
      });
      if (!anyVisible) hidden.push(entry);
    }
    return hidden;
  }, [entries, nameToLaneId, laneRow]);

  const hasUnassignedLane =
    entries.some((e) => e.participants.length === 0) ||
    hiddenParticipantEntries.length > 0;
  const unassignedRow = visibleLanes.length + 2; // row 1 = header

  // Index of the first undated entry — the boundary of the "Undated" zone.
  const undatedStartCol = useMemo(() => {
    const idx = entries.findIndex((e) => e.startAt === null);
    return idx >= 0 ? idx + 2 : -1; // +2: label col + 1-based
  }, [entries]);

  // Flat placement list: one card per (entry × participant-lane). This is what
  // gives multi-character entries their per-lane cards at a shared column.
  const placements = useMemo(() => {
    const cards: Array<{
      key: string;
      entry: TimelineEntry;
      row: number;
      col: number;
      hidden?: boolean;
    }> = [];
    entries.forEach((entry, colIdx) => {
      const col = colIdx + 2; // col 1 = lane labels
      if (entry.participants.length === 0) {
        if (hasUnassignedLane) {
          cards.push({
            key: `${entry.id}-${col}`,
            entry,
            row: unassignedRow,
            col,
          });
        }
        return;
      }
      const placedRows = new Set<number>();
      for (const name of entry.participants) {
        const laneId = nameToLaneId.get(name);
        if (!laneId) continue;
        const row = laneRow.get(laneId);
        if (row === undefined || placedRows.has(row)) continue;
        placedRows.add(row);
        cards.push({ key: `${entry.id}-${row}-${col}`, entry, row, col });
      }
      // All participants hidden — surface a distinct placeholder in the
      // Unassigned lane so the column isn't an unexplained empty cell.
      if (placedRows.size === 0 && hasUnassignedLane) {
        cards.push({
          key: `${entry.id}-hidden-${col}`,
          entry,
          row: unassignedRow,
          col,
          hidden: true,
        });
      }
    });
    return cards;
  }, [entries, hasUnassignedLane, unassignedRow, nameToLaneId, laneRow]);

  const n = entries.length;
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
        className="grid gap-1 p-1"
        style={{ gridTemplateColumns, gridTemplateRows }}
      >
        {/* Header corner */}
        <div
          className="sticky left-0 z-10 flex items-center bg-background px-2 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/70"
          style={{ gridColumn: 1, gridRow: 1 }}
        >
          {t("axis.time")}
        </div>

        {/* Header axis: one time cell per entry column */}
        {entries.map((entry, colIdx) => {
          const col = colIdx + 2;
          const isUndatedBoundary = col === undatedStartCol;
          return (
            <div
              key={`h-${entry.id}`}
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
                {entry.startAt ? (
                  <FormattedTime iso={entry.startAt} />
                ) : (
                  t("card.undated")
                )}
              </span>
            </div>
          );
        })}

        {/* Lane labels (sticky left so they stay visible during horizontal scroll) */}
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

        {/* Cards */}
        {placements.map(({ key, entry, row, col, hidden }) => (
          <div
            key={key}
            className="min-w-0"
            style={{ gridColumn: col, gridRow: row }}
          >
            {hidden ? (
              <div
                title={t("card.lanesHidden")}
                className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 p-2 text-center opacity-70"
              >
                <span className="min-w-0 w-full truncate text-[0.6875rem] font-medium text-muted-foreground">
                  {entry.name}
                </span>
                <span className="text-[0.5625rem] text-muted-foreground/70">
                  {t("kind." + entry.kind)}
                </span>
              </div>
            ) : (
              <TimelineEntryCard
                entry={entry}
                canOpenDetail={canOpenDetail(entry)}
                onOpenDetail={() => onOpenDetail(entry)}
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

export { TimelineGrid };
export type { TimelineGridProps };
