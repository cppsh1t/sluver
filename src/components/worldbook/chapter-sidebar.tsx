import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

import { Button } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft02Icon,
  Delete02Icon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { Chapter, ChapterId, Novel, NovelId, WorldId } from "@/types";

// Defined locally to avoid a circular import with the workspace route. The
// route re-exports this via `WorkspaceMode as SidebarMode`.
export type WorkspaceMode = "edit" | "read";

interface ChapterSidebarProps {
  worldId: WorldId;
  novelId: NovelId;
  novel: Novel | undefined;
  chapters: Chapter[];
  activeChapterId: ChapterId | null;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  onEditNovel: () => void;
  onAddChapter: () => void;
  onDeleteChapter: (chapter: Chapter) => void;
  onReorderChapters: (chapterIds: ChapterId[]) => void;
}

// ─── Sortable chapter row ────────────────────────────────────────────────────

interface SortableChapterRowProps {
  worldId: WorldId;
  novelId: NovelId;
  chapter: Chapter;
  isActive: boolean;
  onDeleteRequest: (chapter: Chapter) => void;
}

function SortableChapterRow({
  worldId,
  novelId,
  chapter,
  isActive,
  onDeleteRequest,
}: SortableChapterRowProps) {
  const { t } = useTranslation(["novel", "common"]);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chapter.id });

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm outline-none transition-colors",
        isDragging && "opacity-50",
        isActive
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50",
      )}
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground/50 hover:text-foreground active:cursor-grabbing group-hover:text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <HugeiconsIcon icon={GripVerticalIcon} strokeWidth={2} />
        {/* sr-only label mirrors the literal used in phase-card.tsx */}
        <span className="sr-only">Drag to reorder</span>
      </button>

      <Link
        to="/world/$worldId/novels/$novelId/chapters/$chapterId"
        params={{ worldId, novelId, chapterId: chapter.id as ChapterId }}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "min-w-0 flex-1 truncate outline-none",
          isActive ? "text-accent-foreground" : "text-foreground",
        )}
      >
        {chapter.title}
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          <span className="sr-only">{t("common:actions.moreActions")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDeleteRequest(chapter)}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {t("novel:chapter.deleteAction")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── ChapterSidebar ──────────────────────────────────────────────────────────

function ChapterSidebar({
  worldId,
  novelId,
  novel,
  chapters,
  activeChapterId,
  mode,
  onModeChange,
  onEditNovel,
  onAddChapter,
  onDeleteChapter,
  onReorderChapters,
}: ChapterSidebarProps) {
  const { t } = useTranslation(["novel", "common"]);
  const navigate = useNavigate();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Optimistic order override — set synchronously in onDragEnd so the DOM
  // reorders before dnd-kit clears its transforms (prevents the drop twitch).
  const [overrideChapters, setOverrideChapters] = useState<Chapter[] | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<Chapter | null>(null);

  // Clear the override once server data refreshes (success brings matching
  // order; error brings the original order via onSettled refetch).
  useEffect(() => {
    setOverrideChapters(null);
  }, [chapters]);

  const displayChapters = overrideChapters ?? chapters;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = displayChapters.findIndex((c) => c.id === active.id);
    const newIndex = displayChapters.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(displayChapters, oldIndex, newIndex);
    setOverrideChapters(reordered);
    onReorderChapters(reordered.map((c) => c.id as ChapterId));
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-background">
      {/* Top: back + novel title */}
      <div className="flex flex-col gap-2 p-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-1 justify-start px-1 text-muted-foreground"
          onClick={() =>
            navigate({
              to: "/world/$worldId/novels",
              params: { worldId },
            })
          }
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {t("novel:workspace.back")}
        </Button>

        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className="min-w-0 truncate font-heading text-sm font-semibold">
            {novel?.title}
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEditNovel}
            aria-label={t("novel:workspace.editNovel")}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
          </Button>
        </div>
      </div>

      {/* Middle: scrollable chapter list */}
      <div className="flex-1 overflow-y-auto p-2">
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={displayChapters.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <nav className="flex flex-col gap-1" aria-label={t("novel:chapter.title")}>
              {displayChapters.map((chapter) => (
                <SortableChapterRow
                  key={chapter.id}
                  worldId={worldId}
                  novelId={novelId}
                  chapter={chapter}
                  isActive={chapter.id === activeChapterId}
                  onDeleteRequest={setPendingDelete}
                />
              ))}
            </nav>
          </SortableContext>
        </DndContext>
      </div>

      {/* Bottom: add + mode toggle */}
      <div className="flex flex-col gap-3 border-t p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-center"
          onClick={onAddChapter}
        >
          <HugeiconsIcon
            icon={Add01Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {t("novel:chapter.add")}
        </Button>

        <div className="flex rounded-md bg-muted p-0.5" role="group">
          {(["edit", "read"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => onModeChange(m)}
              className={cn(
                "flex-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors outline-none",
                mode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`novel:workspace.mode.${m}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Delete confirmation (shared) */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("novel:chapter.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && pendingDelete.sceneIds.length === 0
                ? t("novel:chapter.deleteDescriptionNoScenes", {
                    name: pendingDelete.title,
                  })
                : t("novel:chapter.deleteDescription", {
                    name: pendingDelete?.title ?? "",
                    count: pendingDelete?.sceneIds.length ?? 0,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) onDeleteChapter(target);
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

export { ChapterSidebar };
export type { ChapterSidebarProps };
