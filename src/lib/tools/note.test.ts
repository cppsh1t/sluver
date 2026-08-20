/**
 * Notes tool tests — the client-side tree projection (grouping + position
 * sorting + field stripping), parentId null normalization on create,
 * read-merge-write update, kind-aware delete with best-effort snapshot and
 * descendant count, and grep_notes' object-arg call shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNote, deleteNote, getNote, grepNotes, listNotes, updateNote } from "@/api/note";
import { noteIdSchema, spaceIdSchema, worldIdSchema, type Note, type NoteId, type NoteSummary } from "@/types";
import type { ToolContext } from "./types";
import { noteTools } from "./note";

vi.mock("@/api/note", () => ({
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  getNote: vi.fn(),
  grepNotes: vi.fn(),
  listNotes: vi.fn(),
  updateNote: vi.fn(),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");

function makeStubCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    spaceId,
    worldId,
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(), set: vi.fn() },
    threadLookup: { findToolPair: vi.fn() },
    skills: [],
    activatedSkills: new Set(),
    visionConfig: null,
    attachmentLookup: { findByFilename: vi.fn(() => null) },
    ...overrides,
  };
}

const TIMESTAMP = "2026-01-01T00:00:00Z";

function makeSummary(input: {
  id: string;
  parentId: string | null;
  kind: "folder" | "note";
  title: string;
  position: number;
}): NoteSummary {
  return {
    id: noteIdSchema.parse(input.id),
    parentId: input.parentId === null ? null : noteIdSchema.parse(input.parentId),
    kind: input.kind,
    title: input.title,
    position: input.position,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function makeNote(summary: NoteSummary, content: string): Note {
  return { ...summary, content };
}

// Flat fixture — deliberately shuffled array order; sibling order must come
// from `position`, not array order.
//   root: "r-note-b" (pos 1), "r-note-a" (pos 0), folder "f-1" (pos 2)
//   f-1: "note-a" (pos 1), folder "f-2" (pos 0)
//   f-2: "grand-b" (pos 1), "grand-a" (pos 0)
const flatSummaries: NoteSummary[] = [
  makeSummary({ id: "grand-b", parentId: "f-2", kind: "note", title: "Grand B", position: 1 }),
  makeSummary({ id: "f-2", parentId: "f-1", kind: "folder", title: "Volume II", position: 0 }),
  makeSummary({ id: "r-note-b", parentId: null, kind: "note", title: "Root Note B", position: 1 }),
  makeSummary({ id: "f-1", parentId: null, kind: "folder", title: "Outline", position: 2 }),
  makeSummary({ id: "grand-a", parentId: "f-2", kind: "note", title: "Grand A", position: 0 }),
  makeSummary({ id: "note-a", parentId: "f-1", kind: "note", title: "Child A", position: 1 }),
  makeSummary({ id: "r-note-a", parentId: null, kind: "note", title: "Root Note A", position: 0 }),
];

const folderId: NoteId = noteIdSchema.parse("f-1");

const tools = noteTools();
const ctx = makeStubCtx();
const call = { abortSignal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list_notes", () => {
  it("projects the flat list into a position-sorted tree of {id, kind, title, children}", async () => {
    vi.mocked(listNotes).mockResolvedValue(flatSummaries);

    const result = await tools.list_notes.execute({}, ctx, call);

    expect(listNotes).toHaveBeenCalledWith(spaceId, worldId);
    expect(result).toEqual([
      {
        id: noteIdSchema.parse("r-note-a"),
        kind: "note",
        title: "Root Note A",
        children: [],
      },
      {
        id: noteIdSchema.parse("r-note-b"),
        kind: "note",
        title: "Root Note B",
        children: [],
      },
      {
        id: folderId,
        kind: "folder",
        title: "Outline",
        children: [
          {
            id: noteIdSchema.parse("f-2"),
            kind: "folder",
            title: "Volume II",
            children: [
              {
                id: noteIdSchema.parse("grand-a"),
                kind: "note",
                title: "Grand A",
                children: [],
              },
              {
                id: noteIdSchema.parse("grand-b"),
                kind: "note",
                title: "Grand B",
                children: [],
              },
            ],
          },
          {
            id: noteIdSchema.parse("note-a"),
            kind: "note",
            title: "Child A",
            children: [],
          },
        ],
      },
    ]);
  });
});

describe("get_note", () => {
  it("passes the note id through", async () => {
    const note = makeNote(flatSummaries[4], "# Grand A");
    vi.mocked(getNote).mockResolvedValue(note);

    const result = await tools.get_note.execute({ noteId: "grand-a" }, ctx, call);

    expect(getNote).toHaveBeenCalledWith(spaceId, worldId, noteIdSchema.parse("grand-a"));
    expect(result).toBe(note);
  });
});

describe("create_note", () => {
  it("normalizes an omitted parentId to null", async () => {
    const created = makeNote(
      makeSummary({ id: "new-1", parentId: null, kind: "folder", title: "Ideas", position: 3 }),
      "",
    );
    vi.mocked(createNote).mockResolvedValue(created);

    const result = await tools.create_note.execute(
      { kind: "folder", title: "Ideas" },
      ctx,
      call,
    );

    expect(createNote).toHaveBeenCalledWith(spaceId, worldId, {
      parentId: null,
      kind: "folder",
      title: "Ideas",
      content: undefined,
    });
    expect(result).toBe(created);
  });

  it("passes parentId, kind, and content through when provided", async () => {
    const created = makeNote(
      makeSummary({ id: "new-2", parentId: "f-1", kind: "note", title: "Beat", position: 2 }),
      "Some markdown",
    );
    vi.mocked(createNote).mockResolvedValue(created);

    const result = await tools.create_note.execute(
      { parentId: "f-1", kind: "note", title: "Beat", content: "Some markdown" },
      ctx,
      call,
    );

    expect(createNote).toHaveBeenCalledWith(spaceId, worldId, {
      parentId: noteIdSchema.parse("f-1"),
      kind: "note",
      title: "Beat",
      content: "Some markdown",
    });
    expect(result).toBe(created);
  });
});

describe("update_note", () => {
  it("merges provided fields and keeps the current content when omitted", async () => {
    const current = makeNote(
      makeSummary({ id: "note-a", parentId: "f-1", kind: "note", title: "Child A", position: 1 }),
      "Old content",
    );
    vi.mocked(getNote).mockResolvedValue(current);
    const updated = makeNote(current, "Old content");
    vi.mocked(updateNote).mockResolvedValue({ ...updated, title: "Renamed" });

    const result = await tools.update_note.execute(
      { noteId: "note-a", title: "Renamed" },
      ctx,
      call,
    );

    expect(updateNote).toHaveBeenCalledWith(spaceId, worldId, noteIdSchema.parse("note-a"), {
      title: "Renamed",
      content: "Old content",
    });
    expect(result).toEqual({ ...updated, title: "Renamed" });
  });
});

describe("delete_note", () => {
  it("returns the snapshot without descendantCount for a note", async () => {
    const snapshot = makeNote(
      makeSummary({ id: "note-a", parentId: "f-1", kind: "note", title: "Child A", position: 1 }),
      "Content",
    );
    vi.mocked(getNote).mockResolvedValue(snapshot);

    const result = await tools.delete_note.execute({ noteId: "note-a" }, ctx, call);

    expect(deleteNote).toHaveBeenCalledWith(spaceId, worldId, noteIdSchema.parse("note-a"));
    expect(result).toEqual({ deleted: true, id: "note-a", snapshot });
    expect(result).not.toHaveProperty("descendantCount");
    expect(listNotes).not.toHaveBeenCalled();
  });

  it("computes descendantCount from the subtree for a folder", async () => {
    const snapshot = makeNote(
      makeSummary({ id: "f-1", parentId: null, kind: "folder", title: "Outline", position: 2 }),
      "",
    );
    vi.mocked(getNote).mockResolvedValue(snapshot);
    vi.mocked(listNotes).mockResolvedValue(flatSummaries);

    const result = await tools.delete_note.execute({ noteId: "f-1" }, ctx, call);

    // Subtree of f-1: note-a, f-2, grand-a, grand-b → 4 descendants.
    expect(result).toEqual({ deleted: true, id: "f-1", snapshot, descendantCount: 4 });
  });

  it("still deletes when the snapshot read fails (no snapshot, no count)", async () => {
    vi.mocked(getNote).mockRejectedValue(new Error("NOT_FOUND"));

    const result = await tools.delete_note.execute({ noteId: "note-a" }, ctx, call);

    expect(deleteNote).toHaveBeenCalledWith(spaceId, worldId, noteIdSchema.parse("note-a"));
    expect(result).toEqual({ deleted: true, id: "note-a" });
    expect(result).not.toHaveProperty("snapshot");
    expect(result).not.toHaveProperty("descendantCount");
    expect(listNotes).not.toHaveBeenCalled();
  });
});

describe("grep_notes", () => {
  it("passes the query and offset as a single object argument", async () => {
    const response = { groups: [], groupCount: 0, truncated: false };
    vi.mocked(grepNotes).mockResolvedValue(response);

    await tools.grep_notes.execute({ query: "elric" }, ctx, call);
    expect(grepNotes).toHaveBeenCalledWith(spaceId, worldId, {
      query: "elric",
      offset: undefined,
    });

    const result = await tools.grep_notes.execute(
      { query: "elric", offset: 50 },
      ctx,
      call,
    );
    expect(grepNotes).toHaveBeenLastCalledWith(spaceId, worldId, {
      query: "elric",
      offset: 50,
    });
    expect(result).toBe(response);
  });
});
