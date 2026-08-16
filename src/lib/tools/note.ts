/**
 * Notes tools — the author's private working material (ADR-0037 / ADR-0038).
 *
 * Six tools over the single-table notes tree (ADR-0038 §6):
 * - reads (`auto`): `list_notes` (tree structure), `get_note` (content),
 *   `grep_notes` (match-centric search scoped to the notes corpus).
 * - `create_note` (`configurable`).
 * - `update_note` / `delete_note` (`always`) — read-merge-write and
 *   best-effort-snapshot patterns per `worldbook/character.ts`.
 *
 * Structural operations (move / reorder) stay UI-only in v1 — `update_note`
 * edits title/content only, never parentId/position.
 *
 * ## Prompt gate (ADR-0037 — load-bearing)
 *
 * Notes are registered statically on BOTH roles; the system prompts carry a
 * hard rule that these tools are used ONLY when the user explicitly asks —
 * never proactively, never as background context gathering. Defense in depth
 * stands even if the model drifts: `create_note` is consent `configurable`
 * and `update_note` / `delete_note` are `always` (ADR-0025), so a drifted
 * write attempt still hits the approval banner.
 *
 * ## grep division of labor (ADR-0035 / ADR-0037)
 *
 * Notes are deliberately EXCLUDED from the `grep` corpus — an ordinary
 * conversation grep must never surface note content. `grep_notes` here is
 * the notes-scoped surface; its description states the split explicitly.
 */

import { z } from "zod";

import {
  createNote,
  deleteNote,
  getNote,
  grepNotes,
  listNotes,
  updateNote,
} from "@/api/note";
import { noteKindSchema, type NoteSummary } from "@/types";
import type { ToolDef } from "./types";

// ─── Tree projection ────────────────────────────────────────────────────────

/** Full pre-delete note payload (same shape `get_note` returns). */
type NoteSnapshot = Awaited<ReturnType<typeof getNote>>;

/**
 * Compact tree node — `id` / `kind` / `title` only, children nested.
 * Timestamps and positions are stripped: the tree is structure for the model
 * to navigate, and repeated per-node timestamps would bloat the payload.
 */
interface CompactNoteNode {
  readonly id: NoteSummary["id"];
  readonly kind: NoteSummary["kind"];
  readonly title: string;
  readonly children: CompactNoteNode[];
}

/**
 * Group the flat `list_notes` payload into a tree client-side (the `list_x`
 * no-N+1 convention): parentId grouping, `position` order within each group.
 * Purely position-based — deliberately NOT kind-grouped, so the tree the
 * model sees is the exact order the user arranged in the UI.
 */
function buildNoteTree(summaries: readonly NoteSummary[]): CompactNoteNode[] {
  // Adjacency map keyed by parentId ("" = root — ids are UUIDs, never empty).
  const childrenOf = new Map<string, NoteSummary[]>();
  for (const s of summaries) {
    const key = s.parentId ?? "";
    const siblings = childrenOf.get(key);
    if (siblings) {
      siblings.push(s);
    } else {
      childrenOf.set(key, [s]);
    }
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.position - b.position);
  }
  const toNode = (s: NoteSummary): CompactNoteNode => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    children: (childrenOf.get(s.id) ?? []).map(toNode),
  });
  return (childrenOf.get("") ?? []).map(toNode);
}

/**
 * Count the notes + folders inside a folder's subtree (exclusive of the
 * folder itself) via a stack walk over the flat sibling list.
 */
function countDescendants(
  summaries: readonly NoteSummary[],
  folderId: string,
): number {
  const childrenOf = new Map<string, NoteSummary[]>();
  for (const s of summaries) {
    const key = s.parentId ?? "";
    const siblings = childrenOf.get(key);
    if (siblings) {
      siblings.push(s);
    } else {
      childrenOf.set(key, [s]);
    }
  }
  let count = 0;
  const stack = [...(childrenOf.get(folderId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    count += 1;
    const kids = childrenOf.get(node.id);
    if (kids) stack.push(...kids);
  }
  return count;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/** All note-domain tools, keyed by `snake_case` name. */
export function noteTools(): Record<string, ToolDef> {
  return {
    // ── Query (auto) ────────────────────────────────────────────
    list_notes: {
      description:
        "List the user's notes as a full tree — every folder and note title with its hierarchy (children nested inside folders). Returns structure only (id, kind, title); call get_note to read a note's content.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) =>
        buildNoteTree(await listNotes(ctx.spaceId, ctx.worldId)),
    },

    get_note: {
      description:
        "Get a single note or folder by ID, including its full markdown content (folders always carry empty content) and its parentId for tree context.",
      inputSchema: z.object({
        noteId: z
          .string()
          .describe("The note's (or folder's) UUID — one id space covers both kinds."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { noteId } = input as { noteId: string };
        return getNote(ctx.spaceId, ctx.worldId, noteId as never);
      },
    },

    grep_notes: {
      description:
        "Search for a substring ONLY in the user's notes — note titles, note markdown content, and folder titles — returning occurrence evidence: match counts plus before/match/after snippets grouped by (note, field), each group carrying a path (ancestor folder titles joined by '/'). " +
        "This is DISTINCT from `grep`, which covers the worldbook entities (characters, locations, items, lore, events, novels, chapters, scenes) and never touches notes. " +
        'When the user asks to find something "in my notes", this is the tool; for the worldbook corpus use `grep` instead. ' +
        "Results are paginated: one call returns up to 50 groups (groupCount carries the full total); when truncated is true, pass offset (50, 100, …) to fetch the next page.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Substring to search for (ASCII case-insensitive)."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Pagination offset — pass 50, 100, … when truncated is true."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query, offset } = input as { query: string; offset?: number };
        return grepNotes(ctx.spaceId, ctx.worldId, { query, offset });
      },
    },

    // ── Create (configurable) ──────────────────────────────────
    create_note: {
      description:
        "Create a new note or folder in the user's notes tree. The title must be unique among its siblings (folders and notes share one namespace). Folders are structural and carry no content — create the folder first, then notes inside it.",
      inputSchema: z.object({
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe("Target folder id; omit or null to create at the root."),
        kind: noteKindSchema.describe("What to create: a structural folder or a content note."),
        title: z
          .string()
          .min(1)
          .describe("Title (must be unique among siblings under the target parent)."),
        content: z
          .string()
          .optional()
          .describe("Markdown content (notes only; folders carry none)."),
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const i = input as {
          parentId?: string | null;
          kind: "folder" | "note";
          title: string;
          content?: string;
        };
        return createNote(ctx.spaceId, ctx.worldId, {
          parentId: (i.parentId ?? null) as never,
          kind: i.kind,
          title: i.title,
          content: i.content,
        });
      },
    },

    // ── Update (always) ────────────────────────────────────────
    update_note: {
      description:
        "Update a note's title and/or content. Only provided fields are changed; omitted fields keep their current values — use get_note first to see the current content. " +
        "This tool edits title/content ONLY: it cannot move a note between folders or reorder siblings (the user arranges the tree in the UI).",
      inputSchema: z.object({
        noteId: z.string().describe("The note's UUID."),
        title: z.string().min(1).optional().describe("New title (if changing)."),
        content: z
          .string()
          .optional()
          .describe("New markdown content (replaces current). Omit to keep current."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { noteId, ...changes } = input as {
          noteId: string;
          title?: string;
          content?: string;
        };
        // Read-merge-write per update_character: the update API is
        // full-replacement, so omitted fields fall back to current values.
        const current = await getNote(ctx.spaceId, ctx.worldId, noteId as never);
        return updateNote(ctx.spaceId, ctx.worldId, noteId as never, {
          title: changes.title ?? current.title,
          content: changes.content ?? current.content,
        });
      },
    },

    // ── Delete (always) ────────────────────────────────────────
    delete_note: {
      description:
        "Delete a note or folder. Deleting a folder CASCADES to ALL notes and folders inside it — call list_notes first to see what the subtree contains. The result carries a pre-delete snapshot and, for folders, a descendantCount.",
      inputSchema: z.object({
        noteId: z
          .string()
          .describe("The note's (or folder's) UUID — one id space covers both kinds."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { noteId } = input as { noteId: string };
        let snapshot: NoteSnapshot | undefined;
        try {
          snapshot = await getNote(ctx.spaceId, ctx.worldId, noteId as never);
        } catch {
          // Snapshot is best-effort — omit it on failure, never block the delete.
        }
        let descendantCount = 0;
        if (snapshot?.kind === "folder") {
          try {
            descendantCount = countDescendants(
              await listNotes(ctx.spaceId, ctx.worldId),
              noteId,
            );
          } catch {
            // Descendant count is best-effort — 0 on failure.
          }
        }
        await deleteNote(ctx.spaceId, ctx.worldId, noteId as never);
        const result: {
          deleted: boolean;
          id: string;
          snapshot?: NoteSnapshot;
          descendantCount?: number;
        } = { deleted: true, id: noteId };
        if (snapshot) {
          result.snapshot = snapshot;
          if (snapshot.kind === "folder") {
            result.descendantCount = descendantCount;
          }
        }
        return result;
      },
    },
  };
}
