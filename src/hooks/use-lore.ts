import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLore,
  deleteLore,
  getLore,
  listLores,
  updateLore,
} from "@/api";
import type { CreateElementInput, UpdateElementInput } from "@/api";
import type { LoreId, WorldId } from "@/types";

export const useLores = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["lores", spaceId, worldId],
    queryFn: () => listLores(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

export const useLore = (spaceId: string, worldId: WorldId, id: LoreId) =>
  useQuery({
    queryKey: ["lores", spaceId, worldId, id],
    queryFn: () => getLore(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

export const useCreateLore = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElementInput) => createLore(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["lores", spaceId, worldId] }),
  });
};

export const useUpdateLore = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: LoreId; input: UpdateElementInput }) =>
      updateLore(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["lores", spaceId, worldId] }),
  });
};

export const useDeleteLore = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: LoreId) => deleteLore(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["lores", spaceId, worldId] }),
  });
};
