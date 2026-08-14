import { useQuery } from "@tanstack/react-query";

import { listTimelineLanes, queryTimeline } from "@/api";
import type { TimelineQuery } from "@/types";
import type { WorldId } from "@/types";

/** Stable query-key factory for Timeline queries. */
export const timelineKeys = {
  all: ["timeline"] as const,
  list: (spaceId: string, worldId: WorldId, query: TimelineQuery | undefined) =>
    ["timeline", spaceId, worldId, query] as const,
  lanes: (spaceId: string, worldId: WorldId) =>
    ["timeline-lanes", spaceId, worldId] as const,
};

/**
 * Fetch the Timeline — a derived, time-ordered chronology of the World's
 * Events and Scenes (ADR-0033). React Query data layer for the Timeline UI.
 *
 * @param spaceId  The Space owning the World.
 * @param worldId  The World to query.
 * @param query    Optional filters (character, location, time window, novel,
 *                 `includeScenes`, `limit`).
 */
export const useTimeline = (
  spaceId: string,
  worldId: WorldId,
  query?: TimelineQuery,
) =>
  useQuery({
    queryKey: timelineKeys.list(spaceId, worldId, query),
    queryFn: () => queryTimeline(spaceId, worldId, query),
    enabled: !!spaceId && !!worldId,
  });

/**
 * Fetch the Timeline lane candidates — every Character in the World with a
 * participation count (DISTINCT Events + Scenes), sorted by count DESC then
 * name ASC. Drives the Timeline UI's default lane set
 * (`participationCount > 2`) and the character multiselect.
 *
 * @param spaceId  The Space owning the World.
 * @param worldId  The World to query.
 */
export const useTimelineLanes = (
  spaceId: string,
  worldId: WorldId,
) =>
  useQuery({
    queryKey: timelineKeys.lanes(spaceId, worldId),
    queryFn: () => listTimelineLanes(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });
