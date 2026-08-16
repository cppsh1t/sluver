/**
 * Notes workspace — World-scoped, full-width two-pane writing surface
 * (left: file tree, right: markdown content with read/edit modes).
 *
 * Selection lives in the `?note=<id>` search param — there are deliberately
 * NO per-note child routes (same rationale as ADR-0021: notes are edited in
 * place and the tree is the navigation; a deep-linkable route would fight the
 * editor's autosave lifecycle). Back/forward keeps the selection.
 *
 * The content editor copies the ADR-0021 autosave shape from the chapter
 * workspace / scene-card: a local state mirror, a 1500ms debounce, full-
 * replacement `update_note` (title from the tree + edited content), a
 * saving/saved/error status chip, and a flush of pending saves on note switch
 * and unmount via refs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { worldLayoutRoute } from "./_world";
import { NoteMarkdown } from "@/components/notes/note-markdown";
import { NoteTree } from "@/components/notes/note-tree";
import { buildNoteTree, collectSubtree, groupByParent, ROOT_KEY } from "@/components/notes/tree-utils";
import { Textarea } from "@/components/ui/textarea";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder02Icon, NotebookIcon } from "@hugeicons/core-free-icons";
import { getNote } from "@/api";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import {
  useCreateNote,
  useDeleteNote,
  useMoveNote,
  useNote,
  useNotes,
  useReorderNotes,
  useUpdateNote,
} from "@/hooks";
import type { SaveStatus } from "@/components/worldbook/scene-card";
import type {
  NoteId,
  NoteKind,
  NoteSummary,
  WorldId,
} from "@/types";

const AUTOSAVE_DEBOUNCE_MS = 1500;

/** `?note=<id>` — selected tree node (note or folder). */
interface NotesWorkspaceSearch {
  note?: string;
}

// ─── Notes workspace page ────────────────────────────────────────────────────

function NotesWorkspacePage() {
  const { t } = useTranslation(["note", "common"]);
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const navigate = useNavigate();
  const { note: selectedParam } = notesRoute.useSearch();
  const wid = worldId as WorldId;
  const selectedId = selectedParam ?? null;

  // ─── Data ────────────────────────────────────────────────────────────────
  const { data: summaries = [] } = useNotes(spaceId, wid);
  const summaryMap = useMemo(
    () => new Map(summaries.map((s) => [s.id as string, s])),
    [summaries],
  );
  const tree = useMemo(() => buildNoteTree(summaries), [summaries]);

  const selectedSummary: NoteSummary | null = selectedId
    ? (summaryMap.get(selectedId) ?? null)
    : null;
  const selectedIsNote = selectedSummary?.kind === "note";
  const noteQuery = useNote(
    spaceId,
    wid,
    selectedIsNote ? selectedSummary.id : null,
  );
  const noteContent = noteQuery.data;

  // ─── Mutations ───────────────────────────────────────────────────────────
  const createMut = useCreateNote(spaceId, wid);
  const updateMut = useUpdateNote(spaceId, wid);
  const deleteMut = useDeleteNote(spaceId, wid);
  const reorderMut = useReorderNotes(spaceId, wid);
  const moveMut = useMoveNote(spaceId, wid);

  // ─── Mode (local two-state toggle, read by default) ──────────────────────
  const [mode, setMode] = useState<"read" | "edit">("read");

  // ─── Editor local state (ADR-0021 mirror) ────────────────────────────────
  const [editor, setEditor] = useState<{ noteId: NoteId; content: string } | null>(
    null,
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while a flush's `mutateAsync` is in flight — the sync effect must
   * not accept server content in that window (it predates the save). */
  const savingRef = useRef(false);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  /** Last-known-persisted content per note — lets flushes skip no-ops. */
  const savedContentRef = useRef<Map<string, string>>(new Map());
  const summariesRef = useRef<NoteSummary[]>(summaries);
  summariesRef.current = summaries;

  // Sync server → editor. A note already being edited only accepts server
  // content while no save is pending (debounce timer OR in-flight flush) —
  // otherwise the post-save refetch (or an unrelated list invalidation)
  // would clobber mid-debounce edits or flash pre-save content.
  useEffect(() => {
    if (!selectedSummary || selectedSummary.kind !== "note") {
      setEditor(null);
      setSaveStatus("idle");
      return;
    }
    const id = selectedSummary.id;
    if (editorRef.current?.noteId === id) {
      if (
        !timerRef.current &&
        !savingRef.current &&
        noteContent &&
        noteContent.id === id
      ) {
        setEditor({ noteId: id, content: noteContent.content });
        savedContentRef.current.set(id, noteContent.content);
      }
      return;
    }
    if (noteContent && noteContent.id === id) {
      setEditor({ noteId: id, content: noteContent.content });
      savedContentRef.current.set(id, noteContent.content);
      setSaveStatus("idle");
    } else {
      setEditor(null); // loading
    }
  }, [selectedSummary, noteContent]);

  // ─── Debounced auto-save ─────────────────────────────────────────────────
  const flushSave = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const ed = editorRef.current;
    if (!ed) return;
    const summary = summariesRef.current.find((s) => s.id === ed.noteId);
    if (!summary) return;
    if (savedContentRef.current.get(ed.noteId) === ed.content) return;
    setSaveStatus("saving");
    savingRef.current = true;
    try {
      await updateMut.mutateAsync({
        id: ed.noteId,
        input: { title: summary.title, content: ed.content },
      });
      savedContentRef.current.set(ed.noteId, ed.content);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      savingRef.current = false;
    }
  }, [updateMut]);

  const flushRef = useRef(flushSave);
  flushRef.current = flushSave;

  function handleContentChange(value: string) {
    const ed = editorRef.current;
    if (!ed) return;
    setEditor({ ...ed, content: value });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Flush pending saves on note switch AND unmount (refs, chapter-workspace
  // pattern).
  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, [selectedId]);

  // ─── Auto-resizing textarea (scene-card pattern) ─────────────────────────
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editor?.content, editor?.noteId, mode]);

  // ─── Selection (search param — survives back/forward) ────────────────────
  function selectNode(id: string | null) {
    flushRef.current();
    navigate({
      to: "/space/$spaceId/world/$worldId/notes",
      params: { spaceId, worldId },
      search: (prev) => ({ ...prev, note: id ?? undefined }),
    });
  }

  // ─── CRUD handlers ───────────────────────────────────────────────────────
  async function handleCreate(kind: NoteKind, parentId: NoteId | null) {
    // Default titles must be unique among the TARGET PARENT's siblings (the
    // UNIQUE(IFNULL(parent_id,''), title) scope) — a global kind count can
    // collide after deletions and surface an opaque INTERNAL_ERROR toast.
    const siblingTitles = new Set(
      summariesRef.current
        .filter((s) => (s.parentId ?? null) === parentId)
        .map((s) => s.title),
    );
    const key =
      kind === "note"
        ? "note:tree.defaultNoteTitle"
        : "note:tree.defaultFolderTitle";
    let count = 1;
    let title = i18n.t(key, { n: count });
    while (siblingTitles.has(title)) {
      count += 1;
      title = i18n.t(key, { n: count });
    }
    try {
      const created = await createMut.mutateAsync({
        parentId,
        kind,
        title,
        content: "",
      });
      toast.success(
        i18n.t(
          kind === "note"
            ? "note:toast.createNoteSuccess"
            : "note:toast.createFolderSuccess",
        ),
      );
      selectNode(created.id);
    } catch (e) {
      toast.error(
        i18n.t(
          kind === "note"
            ? "note:toast.createNoteFailed"
            : "note:toast.createFolderFailed",
        ),
        { description: translateError(toErrorPayload(e)) },
      );
    }
  }

  async function handleRename(id: NoteId, title: string) {
    const summary = summaryMap.get(id);
    if (!summary || !title || title === summary.title) return;
    try {
      // Flush first so an in-flight autosave can't overwrite the new title
      // (commands may execute out of order).
      await flushRef.current();
      let content = "";
      if (summary.kind === "note") {
        const cached =
          editorRef.current?.noteId === id
            ? editorRef.current.content
            : savedContentRef.current.get(id);
        // `??` not `||`: an empty saved string is a valid content value.
        content = cached ?? (await getNote(spaceId, wid, id)).content;
      }
      await updateMut.mutateAsync({ id, input: { title, content } });
      toast.success(i18n.t("note:toast.renameSuccess"));
    } catch (e) {
      toast.error(i18n.t("note:toast.renameFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleDelete(id: NoteId) {
    const subtree = collectSubtree(summariesRef.current, id);
    // Discard pending edits for any note inside the deleted subtree. The
    // ref is nulled DIRECTLY: `selectNode` below flushes synchronously in
    // this same tick, before a re-render would sync `editorRef` from state —
    // a stale ref would race an `update_note` against the cascade delete.
    if (editorRef.current && subtree.ids.has(editorRef.current.noteId)) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      editorRef.current = null;
      setEditor(null);
      setSaveStatus("idle");
    }
    const summary = summaryMap.get(id);
    if (selectedId && subtree.ids.has(selectedId)) {
      selectNode(null);
    }
    try {
      await deleteMut.mutateAsync(id);
      toast.success(
        i18n.t(
          summary?.kind === "folder"
            ? "note:toast.deleteFolderSuccess"
            : "note:toast.deleteNoteSuccess",
        ),
      );
    } catch (e) {
      toast.error(i18n.t("note:toast.deleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleReorder(parentId: NoteId | null, noteIds: NoteId[]) {
    try {
      await reorderMut.mutateAsync({ parentId, noteIds });
      toast.success(i18n.t("note:toast.reorderSuccess"));
    } catch (e) {
      toast.error(i18n.t("note:toast.reorderFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleMove(
    id: NoteId,
    newParentId: NoteId | null,
    index: number,
  ) {
    try {
      await moveMut.mutateAsync({ id, newParentId, index });
      toast.success(i18n.t("note:toast.moveSuccess"));
    } catch (e) {
      toast.error(i18n.t("note:toast.moveFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  const byParent = useMemo(() => groupByParent(summaries), [summaries]);

  function handleMoveIntoFolder(id: NoteId, folderId: NoteId) {
    const count = byParent.get(folderId)?.length ?? 0;
    void handleMove(id, folderId, count);
  }

  function handleMoveToRoot(id: NoteId) {
    const count = byParent.get(ROOT_KEY)?.length ?? 0;
    void handleMove(id, null, count);
  }

  function handleMoveToIndex(id: NoteId, parentId: NoteId | null, index: number) {
    void handleMove(id, parentId, index);
  }

  // ─── Folder overview counts (subtree-wide; excludes the folder itself) ───
  const folderCounts = useMemo(() => {
    if (selectedSummary?.kind !== "folder") return null;
    const { ids, noteCount, folderCount } = collectSubtree(
      summaries,
      selectedSummary.id,
    );
    return { ids, noteCount, subfolderCount: Math.max(folderCount - 1, 0) };
  }, [selectedSummary, summaries]);

  const saveStatusLabel = (() => {
    if (!selectedIsNote || saveStatus === "idle") return null;
    return t(`note:saveStatus.${saveStatus}`);
  })();

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ─── Left: file tree ─────────────────────────────────────────────── */}
      <NoteTree
        tree={tree}
        summaries={summaries}
        selectedId={selectedId}
        revealId={selectedId}
        onBack={() =>
          navigate({
            to: "/space/$spaceId/world/$worldId",
            params: { spaceId, worldId },
          })
        }
        onSelect={selectNode}
        onCreateNote={(parentId) => handleCreate("note", parentId)}
        onCreateFolder={(parentId) => handleCreate("folder", parentId)}
        onRename={handleRename}
        onDelete={handleDelete}
        onReorder={handleReorder}
        onMoveIntoFolder={handleMoveIntoFolder}
        onMoveToRoot={handleMoveToRoot}
        onMoveToIndex={handleMoveToIndex}
      />

      {/* ─── Right: content pane ─────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header: title + save status + mode toggle */}
        <div className="flex min-h-10 items-center justify-between gap-3 border-b px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {selectedSummary?.kind === "folder" && (
              <HugeiconsIcon
                icon={Folder02Icon}
                strokeWidth={2}
                className="size-4 shrink-0 text-muted-foreground/70"
              />
            )}
            <h1 className="min-w-0 truncate font-heading text-sm font-semibold">
              {selectedSummary ? selectedSummary.title : t("note:workspace.title")}
            </h1>
            {saveStatusLabel && (
              <span
                className={cn(
                  "shrink-0 text-xs",
                  saveStatus === "error"
                    ? "text-destructive"
                    : "text-muted-foreground/60",
                )}
              >
                {saveStatusLabel}
              </span>
            )}
          </div>
          {selectedIsNote && (
            <div className="flex rounded-md bg-muted p-0.5" role="group">
              {(["read", "edit"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-xs font-medium transition-colors outline-none",
                    mode === m
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`note:mode.${m}`)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {!selectedSummary ? (
            <div className="flex h-full items-center justify-center">
              <Empty className="justify-center">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={NotebookIcon} strokeWidth={2} />
                  </EmptyMedia>
                  <EmptyTitle>{t("note:content.noSelectionTitle")}</EmptyTitle>
                  <EmptyDescription>
                    {t("note:content.noSelectionDescription")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : selectedSummary.kind === "folder" ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 px-4 py-10 text-center">
              <HugeiconsIcon
                icon={Folder02Icon}
                strokeWidth={1.5}
                className="size-10 text-muted-foreground/40"
              />
              <h2 className="font-heading text-xl font-semibold">
                {selectedSummary.title}
              </h2>
              <p className="text-sm text-muted-foreground">
                {folderCounts &&
                folderCounts.noteCount + folderCounts.subfolderCount > 0
                  ? t("note:content.folderCounts", {
                      noteCount: folderCounts.noteCount,
                      folderCount: folderCounts.subfolderCount,
                    })
                  : t("note:content.folderEmpty")}
              </p>
            </div>
          ) : mode === "read" ? (
            <div className="mx-auto w-full max-w-none px-8 py-8">
              {editor ? (
                <NoteMarkdown content={editor.content} />
              ) : (
                <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
              )}
            </div>
          ) : (
            <div className="mx-auto w-full max-w-none px-8 py-6">
              <Textarea
                ref={textareaRef}
                value={editor?.content ?? ""}
                onChange={(e) => handleContentChange(e.currentTarget.value)}
                placeholder={t("note:content.placeholder")}
                className="min-h-[60vh] w-full resize-none border-0 bg-transparent p-0 font-article text-base leading-relaxed shadow-none focus-visible:ring-0"
                style={{ fontSize: "18px", lineHeight: "1.8" }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const notesRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "notes",
  validateSearch: (search: Record<string, unknown>): NotesWorkspaceSearch => ({
    note:
      typeof search.note === "string" && search.note.length > 0
        ? search.note
        : undefined,
  }),
  component: NotesWorkspacePage,
});
