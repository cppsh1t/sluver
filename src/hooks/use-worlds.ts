import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createWorld, deleteWorld, getWorld, listWorlds, updateWorld } from "@/api";
import type { CreateWorldInput, UpdateWorldInput } from "@/api";
import type { WorldId } from "@/types";

export const useWorlds = () =>
  useQuery({ queryKey: ["worlds"], queryFn: listWorlds });

export const useWorld = (id: WorldId) =>
  useQuery({
    queryKey: ["worlds", id],
    queryFn: () => getWorld(id),
    enabled: !!id,
  });

export const useCreateWorld = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorldInput) => createWorld(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worlds"] }),
  });
};

export const useUpdateWorld = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: WorldId; input: UpdateWorldInput }) =>
      updateWorld(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worlds"] }),
  });
};

export const useDeleteWorld = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: WorldId) => deleteWorld(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worlds"] }),
  });
};
