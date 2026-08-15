import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { worldLayoutRoute } from "./_world";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Search01Icon,
  Time03Icon,
} from "@hugeicons/core-free-icons";
import { TimelineGrid } from "@/components/timeline/timeline-grid";
import { TimelineLaneSelector } from "@/components/timeline/timeline-lane-selector";
import {
  TimelineToolbar,
  type TimelineFilterPatch,
} from "@/components/timeline/timeline-toolbar";
import { cn } from "@/lib/utils";
import {
  useCharacters,
  useItems,
  useLocations,
  useNovels,
  useTimeline,
  useTimelineLanes,
} from "@/hooks";
import { TIMELINE_LIMIT_MAX, type Character, type TimelineEntry, type TimelineQuery, type WorldId } from "@/types";

/** Internal filter state (subset of TimelineQuery, normalized for UI controls). */
interface TimelineFilters {
  locationId: string | null;
  novelId: string | null;
  itemId: string | null;
  from: string | undefined;
  to: string | undefined;
  includeScenes: boolean;
}

const DEFAULT_FILTERS: TimelineFilters = {
  locationId: null,
  novelId: null,
  itemId: null,
  from: undefined,
  to: undefined,
  includeScenes: true,
};

/** Base result window requested on mount and after any filter change. */
const LIMIT_BASE = 100;
/** Entries added per "load more" click, up to `TIMELINE_LIMIT_MAX`. */
const LIMIT_STEP = 100;

function TimelinePage() {
  const { t } = useTranslation(["timeline", "common"]);
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const wid = worldId as WorldId;
  const navigate = useNavigate();

  // ─── Filter option sources ────────────────────────────────────────────────
  const { data: locations = [] } = useLocations(spaceId, wid);
  const { data: novels = [] } = useNovels(spaceId, wid);
  const { data: items = [] } = useItems(spaceId, wid);
  // Full Character records power the compact lane-header cards (avatar + descriptor).
  const { data: characters = [] } = useCharacters(spaceId, wid);
  const charactersById = useMemo(
    () => new Map<string, Character>(characters.map((c) => [c.id, c])),
    [characters],
  );

  // ─── Filter state → TimelineQuery ─────────────────────────────────────────
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);

  // ─── View state: column density ───────────────────────────────────────────
  // `sparse` lays columns out on a real time scale (see TimelineGrid) so time
  // density is perceptible; default `false` keeps the uniform compact grid.
  const [sparse, setSparse] = useState(false);

  // ─── View state: result window ───────────────────────────────────────────
  // Starts at the base window; each "load more" click steps it up (bounded by
  // TIMELINE_LIMIT_MAX). Reset to base whenever filters change — narrowing
  // the filters is the primary way to fit the chronology in one window.
  const [limit, setLimit] = useState(LIMIT_BASE);

  const query = useMemo<TimelineQuery>(
    () => ({
      locationId: filters.locationId ?? undefined,
      novelId: filters.novelId ?? undefined,
      itemId: filters.itemId ?? undefined,
      from: filters.from,
      to: filters.to,
      includeScenes: filters.includeScenes,
      // Accumulated result window; lane visibility stays client-side
      // (ADR-0034) — toggling lanes never re-queries.
      limit,
    }),
    [filters, limit],
  );

  function handleFilterChange(patch: TimelineFilterPatch) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setLimit(LIMIT_BASE);
  }
  function handleClearFilters() {
    setFilters(DEFAULT_FILTERS);
    setLimit(LIMIT_BASE);
  }

  const hasActiveFilters =
    filters.locationId !== null ||
    filters.novelId !== null ||
    filters.itemId !== null ||
    filters.from !== undefined ||
    filters.to !== undefined ||
    !filters.includeScenes;

  // ─── Data ─────────────────────────────────────────────────────────────────
  const { data: response, isLoading, isFetching } = useTimeline(spaceId, wid, query);
  const { data: lanes = [] } = useTimelineLanes(spaceId, wid);

  const entries = response?.entries ?? [];
  const total = response?.total ?? 0;
  const truncated = response?.truncated === true || total > entries.length;

  // ─── Lane visibility (client-side multi-select; default participationCount > 2) ─
  const [visibleLaneIds, setVisibleLaneIds] = useState<Set<string>>(
    new Set(),
  );
  const lanesSeeded = useRef(false);
  const seededWorldId = useRef(worldId);
  useEffect(() => {
    // Re-seed when the World changes — TanStack Router reuses the component
    // instance across param-only transitions, so the ref survives a worldId
    // change and would otherwise keep the previous World's character ids.
    if (seededWorldId.current !== worldId) {
      seededWorldId.current = worldId;
      lanesSeeded.current = false;
    }
    if (lanesSeeded.current || lanes.length === 0) return;
    const defaults = lanes.filter((l) => l.participationCount > 2);
    const seed = defaults.length > 0 ? defaults : lanes;
    setVisibleLaneIds(new Set(seed.map((l) => l.characterId)));
    lanesSeeded.current = true;
  }, [lanes, worldId]);

  const handleToggleLane = useCallback((id: string) => {
    setVisibleLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ─── Navigation (popover → detail) ────────────────────────────────────────
  const canOpenDetail = useCallback(
    (entry: TimelineEntry) =>
      entry.kind === "event"
        ? true
        : Boolean(entry.novelId && entry.chapterId),
    [],
  );

  const handleOpenDetail = useCallback(
    (entry: TimelineEntry) => {
      if (entry.kind === "event") {
        navigate({
          to: "/space/$spaceId/world/$worldId/events/$eventId",
          params: { spaceId, worldId: wid, eventId: entry.id },
        });
        return;
      }
      if (entry.novelId && entry.chapterId) {
        navigate({
          to: "/space/$spaceId/world/$worldId/novels/$novelId/chapters/$chapterId",
          params: {
            spaceId,
            worldId: wid,
            novelId: entry.novelId,
            chapterId: entry.chapterId,
          },
        });
      }
    },
    [navigate, spaceId, wid],
  );

  // ─── Body (4-state) ───────────────────────────────────────────────────────
  const showEmptyState = !isLoading && entries.length === 0;

  return (
    // The page NEVER scrolls as a whole — the header/toolbar chrome is fixed
    // and the timeline body fills the remaining height, scrolling internally.
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Fixed chrome: header + toolbar + banner */}
      <div className="shrink-0 px-6 pt-6">
        {/* Header */}
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t("timeline:title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("timeline:subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Mode toggle — Scale view reserved but disabled (ADR-0034 MVP) */}
            <div
              className="flex rounded-md bg-muted p-0.5"
              role="group"
              aria-label={t("timeline:title")}
            >
              <button
                type="button"
                aria-pressed={true}
                className="flex items-center gap-1 rounded-sm bg-background px-3 py-1 text-xs font-medium shadow-sm"
              >
                <HugeiconsIcon icon={Time03Icon} strokeWidth={2} className="size-3.5" />
                {t("timeline:mode.swimlane")}
              </button>
              <button
                type="button"
                disabled
                aria-pressed={false}
                title={t("timeline:mode.scaleTooltip")}
                className="flex cursor-not-allowed items-center gap-1 rounded-sm px-3 py-1 text-xs font-medium text-muted-foreground/50"
              >
                {t("timeline:mode.scale")}
              </button>
            </div>
            {/* Column density: compact (uniform) vs sparse (real time scale) */}
            <div
              className="flex rounded-md bg-muted p-0.5"
              role="group"
              aria-label={t("timeline:density.label")}
            >
              <button
                type="button"
                aria-pressed={!sparse}
                onClick={() => setSparse(false)}
                className={cn(
                  "flex items-center gap-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
                  !sparse
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("timeline:density.compact")}
              </button>
              <button
                type="button"
                aria-pressed={sparse}
                onClick={() => setSparse(true)}
                title={t("timeline:density.sparseTooltip")}
                className={cn(
                  "flex items-center gap-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
                  sparse
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("timeline:density.sparse")}
              </button>
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <TimelineToolbar
          locationId={filters.locationId}
          novelId={filters.novelId}
          itemId={filters.itemId}
          from={filters.from}
          to={filters.to}
          includeScenes={filters.includeScenes}
          locations={locations}
          novels={novels}
          items={items}
          hasActiveFilters={hasActiveFilters}
          onChange={handleFilterChange}
          onClear={handleClearFilters}
          laneSelector={
            <TimelineLaneSelector
              lanes={lanes}
              selectedIds={visibleLaneIds}
              onToggle={handleToggleLane}
            />
          }
          spaceId={spaceId}
          worldId={wid}
        />

        {/* Truncation banner — "load more" steps the window up until capped */}
        {truncated && entries.length > 0 && (
          <div
            role="status"
            className="mb-3 flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
          >
            <span className="min-w-0 flex-1">
              {t(
                limit >= TIMELINE_LIMIT_MAX
                  ? "timeline:truncation.messageCapped"
                  : "timeline:truncation.message",
                { shown: entries.length, total },
              )}
            </span>
            {limit < TIMELINE_LIMIT_MAX && (
              <button
                type="button"
                disabled={isFetching}
                onClick={() =>
                  setLimit((prev) =>
                    Math.min(prev + LIMIT_STEP, TIMELINE_LIMIT_MAX),
                  )
                }
                className="shrink-0 rounded-sm border border-amber-500/40 bg-amber-500/15 px-2 py-1 font-medium transition-colors hover:bg-amber-500/25 disabled:pointer-events-none disabled:opacity-50"
              >
                {t("timeline:truncation.loadMore")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Timeline body — fills the remaining height. The grid scrolls
          internally (vertical: hidden scrollbar at the grid root; horizontal:
          pane). The wrapper itself stays scrollable so the skeleton / empty
          states remain reachable on short windows (the grid fits it exactly,
          so no double scrollbar ever appears). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {isLoading ? (
          <TimelineSkeleton />
        ) : showEmptyState && hasActiveFilters ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>{t("timeline:noResults.title")}</EmptyTitle>
              <EmptyDescription>
                {t("timeline:noResults.description")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <button
                type="button"
                onClick={handleClearFilters}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
                {t("timeline:filter.clear")}
              </button>
            </EmptyContent>
          </Empty>
        ) : showEmptyState ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Time03Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>{t("timeline:empty.title")}</EmptyTitle>
              <EmptyDescription>
                {t("timeline:empty.description")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <TimelineGrid
            entries={entries}
            lanes={lanes}
            visibleLaneIds={visibleLaneIds}
            charactersById={charactersById}
            spaceId={spaceId}
            worldId={wid}
            sparse={sparse}
            canOpenDetail={canOpenDetail}
            onOpenDetail={handleOpenDetail}
          />
        )}
      </div>
    </div>
  );
}

/** Loading skeleton — 4 placeholder lanes with pulsing cells. */
function TimelineSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex flex-col">
        {Array.from({ length: 4 }).map((_, row) => (
          <div
            key={row}
            className={cn(
              "flex items-center gap-1 border-b px-2 py-2 last:border-b-0",
            )}
          >
            <div className="h-4 w-24 shrink-0 rounded bg-muted" />
            {Array.from({ length: 6 }).map((__, col) => (
              <div
                key={col}
                className="h-12 w-32 shrink-0 animate-pulse rounded-md bg-muted/60"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export const timelineRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "timeline",
  component: TimelinePage,
});
