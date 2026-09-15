/**
 * Event IPC API.
 *
 * Events are scoped to a Space + World via `spaceId` + `worldId`.
 * Character participation is managed via `characterRefs` junction rows.
 */

import type { Event, EventId, EventSummary, SummaryPage, WorldId } from '@/types';
import { call } from './client';
import type { CreateEventInput, UpdateEventInput } from './types';

export function createEvent(spaceId: string, worldId: WorldId, input: CreateEventInput): Promise<Event> {
  return call<Event>('create_event', { spaceId, worldId, input });
}

export function getEvent(spaceId: string, worldId: WorldId, id: EventId): Promise<Event> {
  return call<Event>('get_event', { spaceId, worldId, id });
}

export function listEvents(spaceId: string, worldId: WorldId): Promise<Event[]> {
  return call<Event[]>('list_events', { spaceId, worldId });
}

/** Lightweight event list — `id`, `name`, `tags`, `startAt`, `endAt`. */
export function listEventSummaries(spaceId: string, worldId: WorldId): Promise<EventSummary[]> {
  return call<EventSummary[]>('list_event_summaries', { spaceId, worldId });
}

/**
 * Substring search across name, description, notes, tags, start time,
 * and end time. Returns one PAGE of matching summaries — 50 per page
 * (`totalCount` carries the full match count; `truncated` reports
 * further pages). Deterministic name ordering makes offset pages
 * stable — walk `offset` 0, 50, 100, … while `truncated` is true.
 *
 * @param spaceId The Space owning the World.
 * @param worldId The World to search.
 * @param query   Substring to search for (case-insensitive).
 * @param offset  Pagination offset in results (0-based); omit for 0.
 */
export function searchEvents(
  spaceId: string,
  worldId: WorldId,
  query: string,
  offset?: number,
): Promise<SummaryPage<EventSummary>> {
  return call<SummaryPage<EventSummary>>('search_events', { spaceId, worldId, query, offset });
}

export function updateEvent(
  spaceId: string,
  worldId: WorldId,
  id: EventId,
  input: UpdateEventInput,
): Promise<Event> {
  return call<Event>('update_event', { spaceId, worldId, id, input });
}

export function deleteEvent(spaceId: string, worldId: WorldId, id: EventId): Promise<void> {
  return call<void>('delete_event', { spaceId, worldId, id });
}
