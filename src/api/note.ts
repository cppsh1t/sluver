/**
 * Notes IPC API.
 *
 * Folders and notes live in one `notes` table (single-table tree storage,
 * ADR-0038): a `kind` discriminator tells structural folders from content
 * notes, sibling order is maintained at the application layer via
 * `reorder_notes`, and cross-parent moves go through `move_note` (which
 * hosts ancestor-walk cycle detection). `grep_notes` is the notes-scoped
 * ADR-0035 surface (ADR-0037). All scoped to a Space + World.
 */

import type {
  CreateNoteInput,
  GrepNotesInput,
  GrepNotesResponse,
  Note,
  NoteId,
  NoteSummary,
  UpdateNoteInput,
  WorldId,
} from '@/types';
import { call } from './client';

/** The whole tree as flat summaries (no `content`) — group client-side by `parentId`. */
export function listNotes(spaceId: string, worldId: WorldId): Promise<NoteSummary[]> {
  return call<NoteSummary[]>('list_notes', { spaceId, worldId });
}

/** One note incl. `content` (folders carry `""`). */
export function getNote(spaceId: string, worldId: WorldId, noteId: NoteId): Promise<Note> {
  return call<Note>('get_note', { spaceId, worldId, id: noteId });
}

export function createNote(
  spaceId: string,
  worldId: WorldId,
  input: CreateNoteInput,
): Promise<Note> {
  return call<Note>('create_note', { spaceId, worldId, input });
}

/** Full replacement of `title` + `content` — never `parentId`/`position`. */
export function updateNote(
  spaceId: string,
  worldId: WorldId,
  noteId: NoteId,
  input: UpdateNoteInput,
): Promise<Note> {
  return call<Note>('update_note', { spaceId, worldId, id: noteId, input });
}

/** Delete a note or folder (cascades to all descendants). */
export function deleteNote(spaceId: string, worldId: WorldId, noteId: NoteId): Promise<void> {
  return call<void>('delete_note', { spaceId, worldId, id: noteId });
}

/** Complete sibling list under `parentId` (`null` = root) — writes `position = index`. */
export function reorderNotes(
  spaceId: string,
  worldId: WorldId,
  parentId: NoteId | null,
  noteIds: NoteId[],
): Promise<void> {
  return call<void>('reorder_notes', { spaceId, worldId, parentId, noteIds });
}

/** Cross-parent move + insert at `index`; rejects cycles (folder into itself/descendant). */
export function moveNote(
  spaceId: string,
  worldId: WorldId,
  noteId: NoteId,
  newParentId: NoteId | null,
  index: number,
): Promise<Note> {
  return call<Note>('move_note', { spaceId, worldId, id: noteId, newParentId, index });
}

/** Match-centric retrieval over note title + content + folder title (ADR-0035 semantics). */
export function grepNotes(
  spaceId: string,
  worldId: WorldId,
  input: GrepNotesInput,
): Promise<GrepNotesResponse> {
  return call<GrepNotesResponse>('grep_notes', { spaceId, worldId, input });
}
