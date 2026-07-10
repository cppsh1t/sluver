/**
 * Event IPC API.
 *
 * Events are scoped to a world DB via `worldId`.
 * Character participation is managed via `characterRefs` junction rows.
 */

import type { Event, EventId, WorldId } from '@/types';
import { call } from './client';
import type { CreateEventInput, UpdateEventInput } from './types';

export function createEvent(worldId: WorldId, input: CreateEventInput): Promise<Event> {
  return call<Event>('create_event', { worldId, input });
}

export function getEvent(worldId: WorldId, id: EventId): Promise<Event> {
  return call<Event>('get_event', { worldId, id });
}

export function listEvents(worldId: WorldId): Promise<Event[]> {
  return call<Event[]>('list_events', { worldId });
}

export function updateEvent(
  worldId: WorldId,
  id: EventId,
  input: UpdateEventInput,
): Promise<Event> {
  return call<Event>('update_event', { worldId, id, input });
}

export function deleteEvent(worldId: WorldId, id: EventId): Promise<void> {
  return call<void>('delete_event', { worldId, id });
}
