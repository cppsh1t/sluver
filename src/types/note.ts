import { z } from "zod";

/**
 * Notes — single-table tree storage (ADR-0038).
 *
 * Folders and notes share one `notes` table with a `kind` discriminator:
 * one id space, NULL-safe sibling title uniqueness across both kinds, and
 * arbitrary depth via `parentId` (NULL = root). Position truth is maintained
 * at the application layer (`reorder_notes` writes `position = index`);
 * there is deliberately NO `UNIQUE(parent, position)` — the scene_images
 * precedent.
 *
 * Notes are World-scoped (persisted in world.db) per CONTEXT.md; agent
 * access policy is ADR-0037 (`grep_notes` is the notes-scoped ADR-0035
 * surface — notes are excluded from the general `grep` corpus).
 */

// ─── Branded IDs ──────────────────────────────────────────────────────────

/**
 * Note id — brands BOTH folders and notes (one table, one id space per
 * ADR-0038 §1; the `kind` discriminator, not the id, tells them apart).
 */
export const noteIdSchema = z.string().brand<"NoteId">();
export type NoteId = z.infer<typeof noteIdSchema>;

// ─── Kind ─────────────────────────────────────────────────────────────────

/**
 * `folder` — structural container, `content` always `""`.
 * `note` — content leaf. Display label is `title` (the writing family:
 * Novel/Chapter/Scene), not `name`.
 */
export const noteKindSchema = z.enum(["folder", "note"]);
export type NoteKind = z.infer<typeof noteKindSchema>;

// ─── Note Summary ─────────────────────────────────────────────────────────

/**
 * Lightweight Note row — everything except `content`.
 *
 * Returned by `list_notes`: the whole tree as a flat list (no N+1),
 * grouped client-side by `parentId`, ordered by `position` within siblings.
 */
export const noteSummarySchema = z.object({
  id: noteIdSchema,
  /** `null` = root-level sibling. */
  parentId: noteIdSchema.nullable(),
  kind: noteKindSchema,
  title: z.string(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type NoteSummary = z.infer<typeof noteSummarySchema>;

// ─── Note ─────────────────────────────────────────────────────────────────

/**
 * Full Note incl. `content`. For folders `content` is always `""`.
 * Fetched via `get_note`; mutations are full replacement of `title` +
 * `content` only (never `parentId`/`position` — structural moves go
 * through `move_note` / `reorder_notes`).
 */
export const noteSchema = noteSummarySchema.extend({
  content: z.string(),
});

export type Note = z.infer<typeof noteSchema>;

// ─── Inputs ───────────────────────────────────────────────────────────────

/**
 * `create_note` input. `parentId` null/undefined = root. Parent-exists
 * pre-check on the Rust side → business `NotFound` (scene-image precedent).
 */
export const createNoteInputSchema = z.object({
  parentId: noteIdSchema.nullish(),
  kind: noteKindSchema,
  title: z.string().min(1),
  content: z.string().optional(),
});

export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

/** `update_note` input — full replacement; title/content only (ADR-0038 §6). */
export const updateNoteInputSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
});

export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>;

// ─── grep_notes (notes-scoped ADR-0035 retrieval — ADR-0037/0038) ─────────

/** Query input: 50-group offset pages (`offset` 0, 50, 100, …). */
export const grepNotesInputSchema = z.object({
  query: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
});

export type GrepNotesInput = z.infer<typeof grepNotesInputSchema>;

/**
 * One match occurrence as three parts — the matched substring with context
 * on each side, no marker glyphs (ADR-0035 §4 semantics).
 */
export const noteSnippetSchema = z.object({
  before: z.string(),
  match: z.string(),
  after: z.string(),
});

export type NoteSnippet = z.infer<typeof noteSnippetSchema>;

/**
 * All matches within one (note, field) pair over the notes corpus
 * (note title + note content + folder title). Carries `path` (ancestor
 * titles joined `/`) because note titles repeat and tree position is
 * semantic (ADR-0038 §6).
 */
export const noteMatchGroupSchema = z.object({
  noteId: noteIdSchema,
  kind: noteKindSchema,
  title: z.string(),
  /** Ancestor titles joined `/`, e.g. `"大纲/第一卷/序幕"`. */
  path: z.string(),
  /** Field the matches were found in (`"title"` or `"content"`). */
  fieldName: z.string(),
  matchCount: z.number().int(),
  snippets: z.array(noteSnippetSchema),
});

export type NoteMatchGroup = z.infer<typeof noteMatchGroupSchema>;

/**
 * One page of a deterministically ordered `grep_notes` result set. Walk
 * `offset` while `truncated` is `true`; `groupCount` is the FULL count
 * before pagination.
 */
export const grepNotesResponseSchema = z.object({
  groups: z.array(noteMatchGroupSchema),
  groupCount: z.number().int(),
  truncated: z.boolean(),
});

export type GrepNotesResponse = z.infer<typeof grepNotesResponseSchema>;

// ─── Tree node (UI projection) ────────────────────────────────────────────

/**
 * Recursive UI tree node — built client-side from the flat `list_notes`
 * payload (never crosses IPC). No `content`; no `parentId` (implied by
 * nesting).
 */
export type NoteTreeNode = {
  id: NoteId;
  kind: NoteKind;
  title: string;
  position: number;
  children: NoteTreeNode[];
};

export const noteTreeNodeSchema: z.ZodType<NoteTreeNode> = z.lazy(() =>
  z.object({
    id: noteIdSchema,
    kind: noteKindSchema,
    title: z.string(),
    position: z.number().int(),
    children: z.array(noteTreeNodeSchema),
  }),
);
