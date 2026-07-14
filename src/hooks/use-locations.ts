import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLocation,
  deleteLocation,
  getLocation,
  listLocations,
  updateLocation,
} from "@/api";
import type { CreateElementInput, UpdateElementInput } from "@/api";
import type { LocationId, WorldId } from "@/types";

export const useLocations = (worldId: WorldId) =>
  useQuery({
    queryKey: ["locations", worldId],
    queryFn: () => listLocations(worldId),
    enabled: !!worldId,
  });

export const useLocation = (worldId: WorldId, id: LocationId) =>
  useQuery({
    queryKey: ["locations", worldId, id],
    queryFn: () => getLocation(worldId, id),
    enabled: !!worldId && !!id,
  });

export const useCreateLocation = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElementInput) => createLocation(worldId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations", worldId] }),
  });
};

export const useUpdateLocation = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: LocationId; input: UpdateElementInput }) =>
      updateLocation(worldId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations", worldId] }),
  });
};

export const useDeleteLocation = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: LocationId) => deleteLocation(worldId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations", worldId] }),
  });
};
