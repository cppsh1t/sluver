/**
 * Notes file tree — the left pane of the Notes workspace.
 *
 * Recursive rendering of `NoteTreeNode[]`: folder rows (chevron toggle +
 * folder icon + title) and note rows in pure `position` order (no kind
 * grouping — display must match storage order or drags silently revert).
 * Rows support inline rename (double-click), a hover ⋯ menu (rename / new
 * inside / delete), and @dnd-kit drag & drop:
 *
 *   (a) same-parent reorder  → `reorderNotes(parentId, orderedIds)`
 *   (b) drop onto a folder   → `moveNote(id, folderId, end-index)`
 *   (c) drop onto root space → `moveNote(id, null, end-index)`
 *   (d) drop onto a row in a different parent → `moveNote(id, parent, index)`
 *
 * Cross-parent drops land at the target row's index; cycle attempts (folder
 * into its own subtree) are rejected client-side before hitting the backend's
 * ancestor-walk (ADR-0038 §4).
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  CollisionDetection,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Folder02Icon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  NotebookIcon,
  Note02Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { isInsideSubtree } from "./tree-utils";
import type { NoteId, NoteSummary, NoteTreeNode } from "@/types";

const ROOT_DROP_ID = "notes-root-drop";

/** Pointer-first collision detection: prefers deep row hits over the large
 * root container that encloses them, falling back to proximity. */
const treeCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

// ─── Tree-wide row context ───────────────────────────────────────────────────

interface TreeRowContextValue {
  selectedId: string | null;
  collapsed: Set<string>;
  renaming: { id: NoteId; draft: string } | null;
  onToggleFolder: (id: string) => void;
  onSelect: (id: string) => void;
  onStartRename: (id: NoteId, title: string) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onCreateNoteInside: (folderId: NoteId) => void;
  onCreateFolderInside: (folderId: NoteId) => void;
  onDeleteRequest: (node: NoteTreeNode) => void;
}

const TreeRowContext = createContext<TreeRowContextValue | null>(null);

// ─── Row ─────────────────────────────────────────────────────────────────────

interface NoteTreeRowProps {
  node: NoteTreeNode;
  depth: number;
}

function NoteTreeRow({ node, depth }: NoteTreeRowProps) {
  const { t } = useTranslation(["note", "common"]);
  const ctx = useContext(TreeRowContext);
  if (!ctx) throw new Error("NoteTreeRow must render inside NoteTree");

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: node.id });

  const isFolder = node.kind === "folder";
  const expanded = isFolder && !ctx.collapsed.has(node.id);
  const isSelected = ctx.selectedId === node.id;
  const renaming = ctx.renaming?.id === node.id;

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  // Drop-onto-folder affordance: a soft primary ring when a dragged row hovers
  // this folder (same-parent reorders don't need an indicator — the dnd-kit
  // transform preview already shows the shift).
  const dropTargetRing =
    isOver && isFolder && !isDragging ? "ring-1 ring-primary/40 ring-inset" : null;

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={cn(
          "group/row flex items-center gap-1 rounded-md py-1.5 pr-1 text-sm outline-none transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
          isDragging && "opacity-50",
          dropTargetRing,
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {/* Chevron (folders) / alignment spacer (notes) */}
        {isFolder ? (
          <button
            type="button"
            onClick={() => ctx.onToggleFolder(node.id)}
            aria-label={t("note:tree.toggleFolder")}
            aria-expanded={expanded}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span aria-hidden className="size-4 shrink-0" />
        )}

        {/* Drag handle */}
        <button
          type="button"
          className="flex shrink-0 cursor-grab items-center text-muted-foreground/0 transition-colors outline-none hover:text-muted-foreground focus-visible:text-muted-foreground active:cursor-grabbing group-hover/row:text-muted-foreground/60 group-hover/row:hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <HugeiconsIcon icon={GripVerticalIcon} strokeWidth={2} className="size-3.5" />
          <span className="sr-only">{t("note:tree.dragHandle")}</span>
        </button>

        {/* Kind icon */}
        <HugeiconsIcon
          icon={isFolder ? Folder02Icon : Note02Icon}
          strokeWidth={2}
          className={cn(
            "size-4 shrink-0",
            isSelected ? "text-accent-foreground/70" : "text-muted-foreground/70",
          )}
        />

        {/* Title / inline rename */}
        {renaming ? (
          <Input
            value={ctx.renaming?.draft ?? ""}
            onChange={(e) => ctx.onRenameDraftChange(e.currentTarget.value)}
            onBlur={() => ctx.onCommitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ctx.onCommitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                ctx.onCancelRename();
              }
            }}
            className="h-6 flex-1 px-1 text-sm"
            autoFocus
          />
        ) : (
          <span
            className="min-w-0 flex-1 cursor-default truncate select-none"
            onClick={() => ctx.onSelect(node.id)}
            onDoubleClick={() => ctx.onStartRename(node.id, node.title)}
            title={node.title}
          >
            {node.title}
          </span>
        )}

        {/* ⋯ menu */}
        {!renaming && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              <span className="sr-only">{t("common:actions.moreActions")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isFolder && (
                <>
                  <DropdownMenuItem onClick={() => ctx.onCreateNoteInside(node.id)}>
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                    {t("note:tree.newNoteInside")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => ctx.onCreateFolderInside(node.id)}>
                    <HugeiconsIcon icon={Folder02Icon} strokeWidth={2} />
                    {t("note:tree.newFolderInside")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => ctx.onStartRename(node.id, node.title)}>
                <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                {t("note:tree.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => ctx.onDeleteRequest(node)}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                {t("note:tree.deleteAction")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Children */}
      {isFolder && expanded && node.children.length > 0 && (
        <NoteTreeLevel nodes={node.children} depth={depth + 1} />
      )}
    </div>
  );
}

// ─── Level (one parent's children) ───────────────────────────────────────────

interface NoteTreeLevelProps {
  nodes: NoteTreeNode[];
  depth: number;
}

function NoteTreeLevel({ nodes, depth }: NoteTreeLevelProps) {
  return (
    <SortableContext
      items={nodes.map((n) => n.id)}
      strategy={verticalListSortingStrategy}
    >
      <div className="flex flex-col gap-0.5">
        {nodes.map((node) => (
          <NoteTreeRow key={node.id} node={node} depth={depth} />
        ))}
      </div>
    </SortableContext>
  );
}

// ─── Tree pane ───────────────────────────────────────────────────────────────

interface NoteTreeProps {
  tree: NoteTreeNode[];
  summaries: NoteSummary[];
  selectedId: string | null;
  /** Expand the ancestors of this node (e.g. the current selection). */
  revealId: string | null;
  onBack: () => void;
  onSelect: (id: string) => void;
  onCreateNote: (parentId: NoteId | null) => void;
  onCreateFolder: (parentId: NoteId | null) => void;
  onRename: (id: NoteId, title: string) => void;
  onDelete: (id: NoteId) => void;
  onReorder: (parentId: NoteId | null, orderedIds: NoteId[]) => void;
  onMoveIntoFolder: (id: NoteId, folderId: NoteId) => void;
  onMoveToRoot: (id: NoteId) => void;
  onMoveToIndex: (id: NoteId, parentId: NoteId | null, index: number) => void;
}

/** Find a parent's sibling list within a display tree (null = not found). */
function findSiblings(
  nodes: NoteTreeNode[],
  parentId: string | null,
): NoteTreeNode[] | null {
  if (parentId === null) return nodes;
  for (const n of nodes) {
    if (n.id === parentId) return n.children;
    const found = findSiblings(n.children, parentId);
    if (found !== null) return found;
  }
  return null;
}

/** Rebuild a display tree with one parent's children in `orderedIds` order. */
function withReorderedSiblings(
  nodes: NoteTreeNode[],
  parentId: string | null,
  orderedIds: NoteId[],
): NoteTreeNode[] {
  const byOrder = new Map(orderedIds.map((id, i) => [id as string, i]));
  const sortSiblings = (siblings: NoteTreeNode[]) =>
    siblings
      .slice()
      .sort((a, b) => (byOrder.get(a.id) ?? 0) - (byOrder.get(b.id) ?? 0));
  if (parentId === null) return sortSiblings(nodes);
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: sortSiblings(n.children) }
      : { ...n, children: withReorderedSiblings(n.children, parentId, orderedIds) },
  );
}

function NoteTreeImpl({
  tree,
  summaries,
  selectedId,
  revealId,
  onBack,
  onSelect,
  onCreateNote,
  onCreateFolder,
  onRename,
  onDelete,
  onReorder,
  onMoveIntoFolder,
  onMoveToRoot,
  onMoveToIndex,
}: NoteTreeProps) {
  const { t } = useTranslation(["note", "common"]);

  const summaryMap = useMemo(
    () => new Map(summaries.map((s) => [s.id as string, s])),
    [summaries],
  );
  const parentMap = useMemo(
    () => new Map(summaries.map((s) => [s.id as string, s.parentId ?? null])),
    [summaries],
  );

  // ─── Expand state (default expanded — only collapsed ids are tracked) ────
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Reveal `revealId`: expand its whole ancestor chain.
  useEffect(() => {
    if (!revealId) return;
    setCollapsed((prev) => {
      let next = prev;
      let cur = parentMap.get(revealId) ?? null;
      while (cur !== null) {
        if (next.has(cur)) {
          if (next === prev) next = new Set(prev);
          next.delete(cur);
        }
        cur = parentMap.get(cur) ?? null;
      }
      return next;
    });
  }, [revealId, parentMap]);

  const onToggleFolder = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Clicking a folder row selects it (folder overview in the content pane)
  // AND toggles expansion; the chevron toggles without selecting.
  const onRowSelect = useCallback(
    (id: string) => {
      const summary = summaryMap.get(id);
      if (summary?.kind === "folder") onToggleFolder(id);
      onSelect(id);
    },
    [summaryMap, onToggleFolder, onSelect],
  );

  // ─── Inline rename ─────────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState<{ id: NoteId; draft: string } | null>(
    null,
  );
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;

  const onStartRename = useCallback((id: NoteId, title: string) => {
    setRenaming({ id, draft: title });
  }, []);

  // Read the draft from a ref (not from inside the state updater) so the
  // commit side effect fires exactly once, even under StrictMode.
  const onCommitRename = useCallback(() => {
    const current = renamingRef.current;
    setRenaming(null);
    if (!current) return;
    const trimmed = current.draft.trim();
    const summary = summaryMap.get(current.id);
    if (trimmed && summary && trimmed !== summary.title) {
      onRename(current.id, trimmed);
    }
  }, [summaryMap, onRename]);

  // ─── Delete disclosure (ADR-0006 style subtree counts) ────────────────────
  const [pendingDelete, setPendingDelete] = useState<{
    node: NoteTreeNode;
    noteCount: number;
    folderCount: number;
  } | null>(null);

  const onDeleteRequest = useCallback(
    (node: NoteTreeNode) => {
      let noteCount = 0;
      let folderCount = 0;
      const stack: string[] = [node.id];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const id = stack.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        if (id !== node.id) {
          const summary = summaryMap.get(id);
          if (summary?.kind === "note") noteCount += 1;
          else if (summary?.kind === "folder") folderCount += 1;
        }
        for (const child of summaries) {
          if ((child.parentId ?? null) === id) stack.push(child.id);
        }
      }
      setPendingDelete({ node, noteCount, folderCount });
    },
    [summaryMap, summaries],
  );

  // ─── Optimistic reorder override (cleared when server data lands) ─────────
  const [overrideTree, setOverrideTree] = useState<NoteTreeNode[] | null>(null);
  useEffect(() => {
    setOverrideTree(null);
  }, [tree]);
  const displayTree = overrideTree ?? tree;

  // ─── dnd-kit ───────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const { setNodeRef: setRootDropRef } = useDroppable({ id: ROOT_DROP_ID });

  const displaySiblings = useCallback(
    (parentId: string | null): NoteTreeNode[] =>
      findSiblings(displayTree, parentId) ?? [],
    [displayTree],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const activeId = active.id as NoteId;

      // (c) drop onto the root area → append at the end of the root
      if (over.id === ROOT_DROP_ID) {
        const parent = summaryMap.get(activeId)?.parentId ?? null;
        if (parent !== null) onMoveToRoot(activeId);
        return;
      }

      const overId = over.id as NoteId;
      if (activeId === overId) return;
      const activeSummary = summaryMap.get(activeId);
      const overSummary = summaryMap.get(overId);
      if (!activeSummary || !overSummary) return;

      // Cycle guard (client half of ADR-0038 §4): reject any drop target
      // inside the dragged node's own subtree before hitting the backend.
      if (isInsideSubtree(summaries, overId, activeId)) {
        toast.error(i18n.t("note:toast.moveIntoDescendant"));
        return;
      }

      // (b) drop onto a folder from a different parent → move inside (append)
      if (overSummary.kind === "folder" && activeSummary.parentId !== overSummary.id) {
        onMoveIntoFolder(activeId, overSummary.id);
        return;
      }

      // (a) same-parent reorder
      if (activeSummary.parentId === overSummary.parentId) {
        const siblings = displaySiblings(activeSummary.parentId);
        const oldIndex = siblings.findIndex((n) => n.id === activeId);
        const newIndex = siblings.findIndex((n) => n.id === overId);
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
        const reordered = arrayMove(siblings, oldIndex, newIndex);
        const orderedIds = reordered.map((n) => n.id);
        // Optimistic override so the DOM reorders before the refetch lands.
        setOverrideTree((prev) =>
          withReorderedSiblings(
            prev ?? tree,
            activeSummary.parentId,
            orderedIds,
          ),
        );
        onReorder(activeSummary.parentId, orderedIds);
        return;
      }

      // (d) cross-parent drop onto a row → insert into that parent at its index
      const targetSiblings = displaySiblings(overSummary.parentId);
      const index = targetSiblings.findIndex((n) => n.id === overId);
      onMoveToIndex(
        activeId,
        overSummary.parentId,
        index === -1 ? targetSiblings.length : index,
      );
    },
    [
      summaryMap,
      summaries,
      displaySiblings,
      tree,
      onMoveToRoot,
      onMoveIntoFolder,
      onReorder,
      onMoveToIndex,
    ],
  );

  // ─── Row context value ─────────────────────────────────────────────────────
  const rowContextValue = useMemo<TreeRowContextValue>(
    () => ({
      selectedId,
      collapsed,
      renaming,
      onToggleFolder,
      onSelect: onRowSelect,
      onStartRename,
      onRenameDraftChange: (value: string) =>
        setRenaming((current) => (current ? { ...current, draft: value } : current)),
      onCommitRename,
      onCancelRename: () => setRenaming(null),
      onCreateNoteInside: (folderId: NoteId) => onCreateNote(folderId),
      onCreateFolderInside: (folderId: NoteId) => onCreateFolder(folderId),
      onDeleteRequest,
    }),
    [
      selectedId,
      collapsed,
      renaming,
      onToggleFolder,
      onRowSelect,
      onStartRename,
      onCommitRename,
      onCreateNote,
      onCreateFolder,
      onDeleteRequest,
    ],
  );

  const pendingIsFolder = pendingDelete?.node.kind === "folder";
  const pendingIsEmpty =
    pendingDelete != null &&
    pendingDelete.noteCount === 0 &&
    pendingDelete.folderCount === 0;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-background">
      {/* Top: back + workspace title + create actions */}
      <div className="flex flex-col gap-2 p-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-1 justify-start px-1 text-muted-foreground"
          onClick={onBack}
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {t("note:workspace.back")}
        </Button>

        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className="min-w-0 truncate font-heading text-sm font-semibold">
            {t("note:workspace.title")}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("note:tree.newFolder")}
              onClick={() => onCreateFolder(null)}
            >
              <HugeiconsIcon icon={Folder02Icon} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("note:tree.newNote")}
              onClick={() => onCreateNote(null)}
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            </Button>
          </div>
        </div>
      </div>

      {/* Middle: scrollable tree (root drop target) */}
      <div ref={setRootDropRef} className="flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Empty className="justify-center">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={NotebookIcon} strokeWidth={2} />
                </EmptyMedia>
                <EmptyTitle>{t("note:tree.empty.title")}</EmptyTitle>
                <EmptyDescription>
                  {t("note:tree.empty.description")}
                </EmptyDescription>
              </EmptyHeader>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => onCreateNote(null)}>
                  <HugeiconsIcon
                    icon={Add01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  {t("note:tree.newNote")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onCreateFolder(null)}
                >
                  <HugeiconsIcon
                    icon={Folder02Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  {t("note:tree.newFolder")}
                </Button>
              </div>
            </Empty>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={treeCollisionDetection}
            onDragEnd={onDragEnd}
          >
            <nav aria-label={t("note:workspace.title")}>
              <TreeRowContext.Provider value={rowContextValue}>
                <NoteTreeLevel nodes={displayTree} depth={0} />
              </TreeRowContext.Provider>
            </nav>
          </DndContext>
        )}
      </div>

      {/* Delete confirmation with subtree disclosure */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingIsFolder
                ? t("note:tree.deleteFolderTitle")
                : t("note:tree.deleteNoteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete &&
                (pendingIsFolder
                  ? pendingIsEmpty
                    ? t("note:tree.deleteFolderEmptyDescription", {
                        name: pendingDelete.node.title,
                      })
                    : t("note:tree.deleteFolderDescription", {
                        name: pendingDelete.node.title,
                        noteCount: pendingDelete.noteCount,
                        folderCount: pendingDelete.folderCount,
                      })
                  : t("note:tree.deleteNoteDescription", {
                      name: pendingDelete.node.title,
                    }))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) onDelete(target.node.id);
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

export const NoteTree = memo(NoteTreeImpl);
