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

export const useLocations = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["locations", spaceId, worldId],
    queryFn: () => listLocations(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

export const useLocation = (spaceId: string, worldId: WorldId, id: LocationId) =>
  useQuery({
    queryKey: ["locations", spaceId, worldId, id],
    queryFn: () => getLocation(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

export const useCreateLocation = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElementInput) =>
      createLocation(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["locations", spaceId, worldId] }),
  });
};

export const useUpdateLocation = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: LocationId; input: UpdateElementInput }) =>
      updateLocation(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["locations", spaceId, worldId] }),
  });
};

export const useDeleteLocation = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: LocationId) => deleteLocation(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["locations", spaceId, worldId] }),
  });
};
