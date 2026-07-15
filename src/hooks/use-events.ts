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

export const useEvents = (worldId: WorldId) =>
  useQuery({
    queryKey: ["events", worldId],
    queryFn: () => listEvents(worldId),
    enabled: !!worldId,
  });

export const useEvent = (worldId: WorldId, id: EventId) =>
  useQuery({
    queryKey: ["events", worldId, id],
    queryFn: () => getEvent(worldId, id),
    enabled: !!worldId && !!id,
  });

// ─── Event mutations ─────────────────────────────────────────────────────────

export const useCreateEvent = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) => createEvent(worldId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events", worldId] }),
  });
};

export const useUpdateEvent = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: EventId; input: UpdateEventInput }) =>
      updateEvent(worldId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events", worldId] }),
  });
};

export const useDeleteEvent = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: EventId) => deleteEvent(worldId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events", worldId] }),
  });
};
