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

export const useItems = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["items", spaceId, worldId],
    queryFn: () => listItems(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

export const useItem = (spaceId: string, worldId: WorldId, id: ItemId) =>
  useQuery({
    queryKey: ["items", spaceId, worldId, id],
    queryFn: () => getItem(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

export const useCreateItem = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElementInput) => createItem(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["items", spaceId, worldId] }),
  });
};

export const useUpdateItem = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: ItemId; input: UpdateElementInput }) =>
      updateItem(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["items", spaceId, worldId] }),
  });
};

export const useDeleteItem = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ItemId) => deleteItem(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["items", spaceId, worldId] }),
  });
};
