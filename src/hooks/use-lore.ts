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

export const useLores = (worldId: WorldId) =>
  useQuery({
    queryKey: ["lores", worldId],
    queryFn: () => listLores(worldId),
    enabled: !!worldId,
  });

export const useLore = (worldId: WorldId, id: LoreId) =>
  useQuery({
    queryKey: ["lores", worldId, id],
    queryFn: () => getLore(worldId, id),
    enabled: !!worldId && !!id,
  });

export const useCreateLore = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElementInput) => createLore(worldId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lores", worldId] }),
  });
};

export const useUpdateLore = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: LoreId; input: UpdateElementInput }) =>
      updateLore(worldId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lores", worldId] }),
  });
};

export const useDeleteLore = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: LoreId) => deleteLore(worldId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lores", worldId] }),
  });
};
