import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
  updateItem,
} from "@/api";
import type { CreateElementInput, UpdateElementInput } from "@/api";
import type { ItemId, WorldId } from "@/types";

export const useItems = (worldId: WorldId) =>
  useQuery({
    queryKey: ["items", worldId],
    queryFn: () => listItems(worldId),
    enabled: !!worldId,
  });

export const useItem = (worldId: WorldId, id: ItemId) =>
  useQuery({
    queryKey: ["items", worldId, id],
    queryFn: () => getItem(worldId, id),
    enabled: !!worldId && !!id,
  });

export const useCreateItem = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElementInput) => createItem(worldId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items", worldId] }),
  });
};

export const useUpdateItem = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: ItemId; input: UpdateElementInput }) =>
      updateItem(worldId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items", worldId] }),
  });
};

export const useDeleteItem = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ItemId) => deleteItem(worldId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items", worldId] }),
  });
};
