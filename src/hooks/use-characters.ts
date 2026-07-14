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

export const useCharacters = (worldId: WorldId) =>
  useQuery({
    queryKey: ["characters", worldId],
    queryFn: () => listCharacters(worldId),
    enabled: !!worldId,
  });

export const useCharacter = (worldId: WorldId, id: CharacterId) =>
  useQuery({
    queryKey: ["characters", worldId, id],
    queryFn: () => getCharacter(worldId, id),
    enabled: !!worldId && !!id,
  });

// ─── Character mutations ───────────────────────────────────────────────────

export const useCreateCharacter = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCharacterInput) => createCharacter(worldId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};

export const useUpdateCharacter = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: CharacterId; input: UpdateCharacterInput }) =>
      updateCharacter(worldId, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};

export const useDeleteCharacter = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: CharacterId) => deleteCharacter(worldId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};

// ─── Phase mutations ──────────────────────────────────────────────────────

export const useAddPhase = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, input }: { characterId: CharacterId; input: CreatePhaseInput }) =>
      addPhase(worldId, characterId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};

export const useUpdatePhase = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ phaseId, input }: { phaseId: PhaseId; input: UpdatePhaseInput }) =>
      updatePhase(worldId, phaseId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};

export const useDeletePhase = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (phaseId: PhaseId) => deletePhase(worldId, phaseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};

export const useReorderPhases = (worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ characterId, phaseIds }: { characterId: CharacterId; phaseIds: PhaseId[] }) =>
      reorderPhases(worldId, characterId, phaseIds),
    // onSettled (not onSuccess) so failed reorders also refetch → rollback the
    // optimistic local override in the detail page.
    onSettled: () => qc.invalidateQueries({ queryKey: ["characters", worldId] }),
  });
};
