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
  type TimelineFilterOption,
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
import type { Character, TimelineEntry, TimelineQuery, WorldId } from "@/types";

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

  const locationOptions: TimelineFilterOption[] = useMemo(
    () =>
      locations.map((l) => ({
        id: l.id,
        label: l.name,
        description: l.description,
        avatarKind: "location" as const,
      })),
    [locations],
  );
  const novelOptions: TimelineFilterOption[] = useMemo(
    () =>
      novels.map((n) => ({
        id: n.id,
        label: n.title,
        description: n.description,
      })),
    [novels],
  );
  const itemOptions: TimelineFilterOption[] = useMemo(
    () =>
      items.map((i) => ({
        id: i.id,
        label: i.name,
        description: i.description,
        avatarKind: "item" as const,
      })),
    [items],
  );

  // ─── Filter state → TimelineQuery ─────────────────────────────────────────
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);

  const query = useMemo<TimelineQuery>(
    () => ({
      locationId: filters.locationId ?? undefined,
      novelId: filters.novelId ?? undefined,
      itemId: filters.itemId ?? undefined,
      from: filters.from,
      to: filters.to,
      includeScenes: filters.includeScenes,
      // Always fetch the max window; lane visibility is client-side (ADR-0034).
      limit: 100,
    }),
    [filters],
  );

  function handleFilterChange(patch: TimelineFilterPatch) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }
  function handleClearFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  const hasActiveFilters =
    filters.locationId !== null ||
    filters.novelId !== null ||
    filters.itemId !== null ||
    filters.from !== undefined ||
    filters.to !== undefined ||
    !filters.includeScenes;

  // ─── Data ─────────────────────────────────────────────────────────────────
  const { data: response, isLoading } = useTimeline(spaceId, wid, query);
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
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-10">
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
        </div>

        {/* Toolbar */}
        <TimelineToolbar
          locationId={filters.locationId}
          novelId={filters.novelId}
          itemId={filters.itemId}
          from={filters.from}
          to={filters.to}
          includeScenes={filters.includeScenes}
          locations={locationOptions}
          novels={novelOptions}
          items={itemOptions}
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

        {/* Truncation banner */}
        {truncated && entries.length > 0 && (
          <div
            role="status"
            className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
          >
            {t("timeline:truncation.message", {
              shown: entries.length,
              total,
            })}
          </div>
        )}

        {/* Body */}
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
