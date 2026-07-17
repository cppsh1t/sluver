import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addPhase,
  createCharacter,
  deleteCharacter,
  deletePhase,
  getCharacter,
  listCharacters,
  reorderPhases,
  updateCharacter,
  updatePhase,
} from "@/api";
import type {
  CreateCharacterInput,
  CreatePhaseInput,
  UpdateCharacterInput,
  UpdatePhaseInput,
} from "@/api";
import type { CharacterId, PhaseId, WorldId } from "@/types";

// ─── Character queries ──────────────────────────────────────────────────────

export const useCharacters = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["characters", spaceId, worldId],
    queryFn: () => listCharacters(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

export const useCharacter = (spaceId: string, worldId: WorldId, id: CharacterId) =>
  useQuery({
    queryKey: ["characters", spaceId, worldId, id],
    queryFn: () => getCharacter(spaceId, worldId, id),
    enabled: !!spaceId && !!worldId && !!id,
  });

// ─── Character mutations ───────────────────────────────────────────────────

export const useCreateCharacter = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCharacterInput) =>
      createCharacter(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};

export const useUpdateCharacter = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: CharacterId; input: UpdateCharacterInput }) =>
      updateCharacter(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};

export const useDeleteCharacter = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: CharacterId) => deleteCharacter(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};

// ─── Phase mutations ──────────────────────────────────────────────────────

export const useAddPhase = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, input }: { characterId: CharacterId; input: CreatePhaseInput }) =>
      addPhase(spaceId, worldId, characterId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};

export const useUpdatePhase = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ phaseId, input }: { phaseId: PhaseId; input: UpdatePhaseInput }) =>
      updatePhase(spaceId, worldId, phaseId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};

export const useDeletePhase = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (phaseId: PhaseId) => deletePhase(spaceId, worldId, phaseId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};

export const useReorderPhases = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, phaseIds }: { characterId: CharacterId; phaseIds: PhaseId[] }) =>
      reorderPhases(spaceId, worldId, characterId, phaseIds),
    // onSettled (not onSuccess) so failed reorders also refetch → rollback the
    // optimistic local override in the detail page.
    onSettled: () =>
      qc.invalidateQueries({ queryKey: ["characters", spaceId, worldId] }),
  });
};
