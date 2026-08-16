import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  moveNote,
  reorderNotes,
  updateNote,
} from "@/api";
import type { CreateNoteInput, UpdateNoteInput } from "@/types";
import type { NoteId, WorldId } from "@/types";

// Query keys all start with "notes" — the ENTITY_LIST_KEYS prefix used by the
// `entity-changed` invalidation in __root.tsx (one id space for folders +
// notes, ADR-0038). The ["notes", spaceId, worldId] prefix covers every
// per-note content query below.

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useNotes = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: ["notes", spaceId, worldId],
    queryFn: () => listNotes(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

/** Full note incl. `content` — used by the editor when a note is selected. */
export const useNote = (
  spaceId: string,
  worldId: WorldId,
  noteId: NoteId | null,
) =>
  useQuery({
    queryKey: ["notes", spaceId, worldId, noteId],
    queryFn: () => getNote(spaceId, worldId, noteId as NoteId),
    enabled: !!spaceId && !!worldId && !!noteId,
  });

// ─── Mutations ───────────────────────────────────────────────────────────────

export const useCreateNote = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNoteInput) => createNote(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", spaceId, worldId] }),
  });
};

export const useUpdateNote = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: NoteId; input: UpdateNoteInput }) =>
      updateNote(spaceId, worldId, id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", spaceId, worldId] }),
  });
};

export const useDeleteNote = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: NoteId) => deleteNote(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", spaceId, worldId] }),
  });
};

export const useReorderNotes = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      parentId,
      noteIds,
    }: {
      parentId: NoteId | null;
      noteIds: NoteId[];
    }) => reorderNotes(spaceId, worldId, parentId, noteIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", spaceId, worldId] }),
  });
};

export const useMoveNote = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      newParentId,
      index,
    }: {
      id: NoteId;
      newParentId: NoteId | null;
      index: number;
    }) => moveNote(spaceId, worldId, id, newParentId, index),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notes", spaceId, worldId] }),
  });
};
