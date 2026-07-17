import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createWorld, deleteWorld, getWorld, listWorlds, updateWorld } from "@/api";
import type { CreateWorldInput, UpdateWorldInput } from "@/api";
import type { WorldId } from "@/types";

// `spaceId` leads every query key so switching Space refetches (no stale
// cross-Space data) and so mutations only invalidate the active Space's cache.

export const useWorlds = (spaceId: string) =>
  useQuery({
    queryKey: ["worlds", spaceId],
    queryFn: () => listWorlds(spaceId),
    enabled: !!spaceId,
  });

export const useWorld = (spaceId: string, id: WorldId) =>
  useQuery({
    queryKey: ["worlds", spaceId, id],
    queryFn: () => getWorld(spaceId, id),
    enabled: !!spaceId && !!id,
  });

export const useCreateWorld = (spaceId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorldInput) => createWorld(spaceId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worlds", spaceId] }),
  });
};

export const useUpdateWorld = (spaceId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: WorldId; input: UpdateWorldInput }) =>
      updateWorld(spaceId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worlds", spaceId] }),
  });
};

export const useDeleteWorld = (spaceId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: WorldId) => deleteWorld(spaceId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worlds", spaceId] }),
  });
};
