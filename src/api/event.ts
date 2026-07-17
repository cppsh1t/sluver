/**
 * Event IPC API.
 *
 * Events are scoped to a Space + World via `spaceId` + `worldId`.
 * Character participation is managed via `characterRefs` junction rows.
 */

import type { Event, EventId, WorldId } from '@/types';
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
