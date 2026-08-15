/**
 * Timeline IPC API.
 *
 * The Timeline is a derived, read-only chronological projection of a World's
 * Events and Scenes (ADR-0033). It is never persisted — the `query_timeline`
 * Rust command computes the cross-entity join on demand. See `@/types/timeline`
 * for the data contract.
 */

import type { TimelineLane, TimelineQuery, TimelineResponse, WorldId } from '@/types';
import { call } from './client';

/**
 * Query the Timeline — a flat, time-ordered chronology of the World's Events
 * and (optionally) Scenes. Entries are sorted ascending by `startAt` (undated
 * entries last), each carrying resolved location/participant names, a
 * description excerpt, and cross-reference annotations.
 *
 * @param spaceId  The Space owning the World.
 * @param worldId  The World to query.
 * @param query    Optional filters (character, location, time window, novel,
 *                 `includeScenes`, `limit`). An empty/absent query returns the
 *                 whole chronology up to `limit` (default 50, max
 *                 `TIMELINE_LIMIT_MAX`).
 */
export function queryTimeline(
  spaceId: string,
  worldId: WorldId,
  query?: TimelineQuery,
): Promise<TimelineResponse> {
  return call<TimelineResponse>('query_timeline', { spaceId, worldId, input: query });
}

/**
 * List every Character in the World with a Timeline participation count —
 * DISTINCT Events + Scenes they appear in. Sorted by `participationCount`
 * DESC, then `name` ASC. Characters with zero participation are excluded.
 *
 * Drives the Timeline UI's default lane selection (`participationCount > 2`)
 * and the character multiselect.
 *
 * @param spaceId  The Space owning the World.
 * @param worldId  The World to query.
 */
export function listTimelineLanes(
  spaceId: string,
  worldId: WorldId,
): Promise<TimelineLane[]> {
  return call<TimelineLane[]>('list_timeline_lanes', { spaceId, worldId });
}
