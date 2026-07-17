import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  updateEvent,
} from "@/api";
import type { CreateEventInput, UpdateEventInput } from "@/api";
import type { EventId, WorldId } from "@/types";

// ─── Event queries ───────────────────────────────────────────────────────────

export const useEvents = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["events", spaceId, worldId],
    queryFn: () => listEvents(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

export const useEvent = (spaceId: string, worldId: WorldId, id: EventId) =>
  useQuery({
    queryKey: ["events", spaceId, worldId, id],
    queryFn: () => getEvent(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

// ─── Event mutations ─────────────────────────────────────────────────────────

export const useCreateEvent = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) => createEvent(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["events", spaceId, worldId] }),
  });
};

export const useUpdateEvent = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: EventId; input: UpdateEventInput }) =>
      updateEvent(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["events", spaceId, worldId] }),
  });
};

export const useDeleteEvent = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: EventId) => deleteEvent(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["events", spaceId, worldId] }),
  });
};
