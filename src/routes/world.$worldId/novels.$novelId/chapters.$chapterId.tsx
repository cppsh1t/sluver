import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { novelWorkspaceRoute, useWorkspaceMode } from "../novels.$novelId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { SceneCard } from "@/components/worldbook/scene-card";
import type { SaveStatus, ScenePatch } from "@/components/worldbook/scene-card";
import { SceneRefSidebar } from "@/components/worldbook/scene-ref-sidebar";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useChapters,
  useScenes,
  useUpdateScene,
  useCreateScene,
  useDeleteScene,
  useReorderScenes,
  useUpdateChapter,
  useCharacters,
  useLocations,
  useItems,
  useEvents,
} from "@/hooks";
import type {
  ChapterId,
  EventId,
  ItemId,
  LocationId,
  NovelId,
  Scene as SceneType,
  SceneId,
  WorldId,
} from "@/types";

const AUTOSAVE_DEBOUNCE_MS = 1500;

// ─── Sortable scene wrapper ──────────────────────────────────────────────────

interface SortableSceneProps {
  scene: SceneType;
  isActive: boolean;
  saveStatus: SaveStatus;
  onFieldChange: (patch: ScenePatch) => void;
  onActiveFocus: () => void;
  onDelete: () => void;
}

function SortableScene({
  scene,
  isActive,
  saveStatus,
  onFieldChange,
  onActiveFocus,
  onDelete,
}: SortableSceneProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: scene.id });

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <SceneCard
        scene={scene}
        isActive={isActive}
        saveStatus={saveStatus}
        isDragging={isDragging}
        dragHandleProps={{ ...attributes, ...listeners }}
        onFieldChange={onFieldChange}
        onActiveFocus={onActiveFocus}
        onDelete={onDelete}
      />
    </div>
  );
}

// ─── Chapter workspace page ──────────────────────────────────────────────────

function ChapterWorkspacePage() {
  const { t } = useTranslation(["novel", "common"]);
  const { spaceId, worldId, novelId, chapterId } = useParams({
    from: "/space/$spaceId/world/$worldId/novels/$novelId/chapters/$chapterId",
  });
  const wid = worldId as WorldId;
  const nid = novelId as NovelId;
  const cid = chapterId as ChapterId;
  const mode = useWorkspaceMode();

  // ─── Data ────────────────────────────────────────────────────────────────
  const { data: chapters = [] } = useChapters(spaceId, wid, nid);
  const chapter = useMemo(
    () => chapters.find((c) => c.id === cid) ?? null,
    [chapters, cid],
  );
  const { data: serverScenes = [] } = useScenes(spaceId, wid, cid);
  const { data: characters = [] } = useCharacters(spaceId, wid);
  const { data: locations = [] } = useLocations(spaceId, wid);
  const { data: items = [] } = useItems(spaceId, wid);
  const { data: events = [] } = useEvents(spaceId, wid);

  // ─── Mutations ───────────────────────────────────────────────────────────
  const updateSceneMut = useUpdateScene(spaceId, wid, cid);
  const createSceneMut = useCreateScene(spaceId, wid);
  const deleteSceneMut = useDeleteScene(spaceId, wid, cid);
  const reorderMut = useReorderScenes(spaceId, wid, cid);
  const updateChapterMut = useUpdateChapter(spaceId, wid, nid);

  // ─── Local scene state (optimistic, auto-saved) ──────────────────────────
  const [localScenes, setLocalScenes] = useState<SceneType[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [saveStatuses, setSaveStatuses] = useState<Record<string, SaveStatus>>({});
  const [overrideScenes, setOverrideScenes] = useState<SceneType[] | null>(null);

  // Sync server → local when server data changes (and no override pending).
  useEffect(() => {
    setLocalScenes(serverScenes);
    setOverrideScenes(null);
    setSaveStatuses({});
    if (serverScenes.length > 0) {
      setActiveSceneId((prev) => prev && serverScenes.some((s) => s.id === prev) ? prev : serverScenes[0].id);
    } else {
      setActiveSceneId(null);
    }
  }, [serverScenes]);

  const displayScenes = overrideScenes ?? localScenes;

  // ─── Debounced auto-save ────────────────────────────────────────────────
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const localScenesRef = useRef(localScenes);
  localScenesRef.current = localScenes;

  const flushSceneSave = useCallback(
    async (sceneId: string) => {
      const scene = localScenesRef.current.find((s) => s.id === sceneId);
      if (!scene) return;
      setSaveStatuses((prev) => ({ ...prev, [sceneId]: "saving" }));
      try {
        await updateSceneMut.mutateAsync({
          id: scene.id as SceneId,
          input: {
            title: scene.title,
            summary: scene.summary,
            content: scene.content,
            startAt: scene.startAt,
            endAt: scene.endAt,
            characterRefs: scene.characterRefs,
            locationId: scene.locationId,
            itemIds: scene.itemIds,
            eventIds: scene.eventIds,
          },
        });
        setSaveStatuses((prev) => ({ ...prev, [sceneId]: "saved" }));
      } catch {
        setSaveStatuses((prev) => ({ ...prev, [sceneId]: "error" }));
      }
    },
    [updateSceneMut],
  );

  const flushRef = useRef(flushSceneSave);
  flushRef.current = flushSceneSave;

  function handleSceneFieldChange(sceneId: string, patch: ScenePatch) {
    setLocalScenes((prev) =>
      prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
    );
    // Reset debounce timer
    const existing = timersRef.current[sceneId];
    if (existing) clearTimeout(existing);
    timersRef.current[sceneId] = setTimeout(() => {
      flushSceneSave(sceneId);
      delete timersRef.current[sceneId];
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Also handle ref changes (from right sidebar)
  function handleActiveScenePatch(
    patch: Partial<Pick<SceneType, "characterRefs" | "locationId" | "itemIds" | "eventIds">>,
  ) {
    if (!activeSceneId) return;
    handleSceneFieldChange(activeSceneId, patch);
  }

  // ─── Flush pending saves on chapter switch / unmount ─────────────────────
  useEffect(() => {
    return () => {
      const timers = timersRef.current;
      const scenes = localScenesRef.current;
      for (const id of Object.keys(timers)) {
        clearTimeout(timers[id]);
        const scene = scenes.find((s) => s.id === id);
        if (scene) flushRef.current(id);
      }
      timersRef.current = {};
    };
  }, [cid]);

  // ─── dnd-kit sensors ─────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // ─── Scene handlers ──────────────────────────────────────────────────────
  async function handleCreateScene() {
    try {
      const n = (displayScenes.length + 1).toString();
      const created = await createSceneMut.mutateAsync({
        chapterId: cid,
        input: { title: i18n.t("novel:scene.defaultTitle", { n }) },
      });
      setActiveSceneId(created.id);
      toast.success(i18n.t("novel:scene.toast.createSuccess"));
    } catch (e) {
      toast.error(i18n.t("novel:scene.toast.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleDeleteScene(sceneId: string) {
    try {
      await deleteSceneMut.mutateAsync(sceneId as SceneId);
      toast.success(i18n.t("novel:scene.toast.deleteSuccess"));
    } catch (e) {
      toast.error(i18n.t("novel:scene.toast.deleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = displayScenes.findIndex((s) => s.id === active.id);
    const newIndex = displayScenes.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(displayScenes, oldIndex, newIndex);
    setOverrideScenes(reordered);
    setLocalScenes(reordered);

    reorderMut
      .mutateAsync(reordered.map((s) => s.id as SceneId))
      .then(() => toast.success(i18n.t("novel:scene.toast.reorderSuccess")))
      .catch((e) =>
        toast.error(i18n.t("novel:scene.toast.reorderFailed"), {
          description: translateError(toErrorPayload(e)),
        }),
      );
  }

  // ─── Chapter title/summary editing ───────────────────────────────────────
  const [chTitleDraft, setChTitleDraft] = useState("");
  const [chTitleEditing, setChTitleEditing] = useState(false);
  const [chSummaryOpen, setChSummaryOpen] = useState(false);

  async function commitChapterTitle() {
    const trimmed = chTitleDraft.trim();
    if (!chapter || !trimmed || trimmed === chapter.title) {
      setChTitleEditing(false);
      return;
    }
    try {
      await updateChapterMut.mutateAsync({
        id: cid,
        input: { title: trimmed, summary: chapter.summary },
      });
      toast.success(i18n.t("novel:chapter.toast.updateSuccess"));
    } catch (e) {
      toast.error(i18n.t("novel:chapter.toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
    setChTitleEditing(false);
  }

  async function commitChapterSummary(value: string) {
    if (!chapter || value === chapter.summary) return;
    try {
      await updateChapterMut.mutateAsync({
        id: cid,
        input: { title: chapter.title, summary: value },
      });
    } catch (e) {
      toast.error(i18n.t("novel:chapter.toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  // ─── Right sidebar collapse ──────────────────────────────────────────────
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const activeScene = useMemo(
    () => displayScenes.find((s) => s.id === activeSceneId) ?? null,
    [displayScenes, activeSceneId],
  );

  // ─── Loading ─────────────────────────────────────────────────────────────
  if (!chapter) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("novel:chapter.empty.title")}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ─── Center area ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {/* Chapter header */}
          {chTitleEditing ? (
            <Input
              value={chTitleDraft}
              onChange={(e) => setChTitleDraft(e.currentTarget.value)}
              onBlur={commitChapterTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitChapterTitle(); }
                if (e.key === "Escape") setChTitleEditing(false);
              }}
              className="text-xl font-semibold"
              autoFocus
            />
          ) : (
            <h1
              className={`font-heading text-xl font-semibold ${mode === "edit" ? "cursor-text" : ""}`}
              onClick={() => {
                if (mode === "edit") {
                  setChTitleDraft(chapter.title);
                  setChTitleEditing(true);
                }
              }}
            >
              {chapter.title}
            </h1>
          )}

          {/* Collapsible summary (edit mode only) */}
          {mode === "edit" && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setChSummaryOpen((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground"
              >
                <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-3.5" />
                {chSummaryOpen ? t("novel:chapter.summaryHide") : t("novel:chapter.summaryShow")}
              </button>
              {chSummaryOpen && (
                <Textarea
                  defaultValue={chapter.summary}
                  placeholder={t("novel:chapter.summaryPlaceholder")}
                  className="mt-1 text-sm"
                  rows={2}
                  onBlur={(e) => commitChapterSummary(e.currentTarget.value)}
                />
              )}
            </div>
          )}

          <Separator className="my-4" />

          {/* ─── Edit mode: scene cards ──────────────────────────────────── */}
          {mode === "edit" ? (
            displayScenes.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  {t("novel:scene.empty.description")}
                </p>
                <Button onClick={handleCreateScene}>
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                  {t("novel:scene.add")}
                </Button>
              </div>
            ) : (
              <>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext
                    items={displayScenes.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="flex flex-col gap-4">
                      {displayScenes.map((scene) => (
                        <SortableScene
                          key={scene.id}
                          scene={scene}
                          isActive={scene.id === activeSceneId}
                          saveStatus={saveStatuses[scene.id] ?? "idle"}
                          onFieldChange={(patch) => handleSceneFieldChange(scene.id, patch)}
                          onActiveFocus={() => setActiveSceneId(scene.id)}
                          onDelete={() => handleDeleteScene(scene.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                <Button
                  variant="outline"
                  className="mt-4 w-full"
                  onClick={handleCreateScene}
                >
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                  {t("novel:scene.add")}
                </Button>
              </>
            )
          ) : (
            /* ─── Reading mode: concatenated content ────────────────────── */
            <div className="prose prose-sm max-w-none">
              {displayScenes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("novel:scene.empty.description")}
                </p>
              ) : (
                displayScenes.map((scene, i) => (
                  <div key={scene.id}>
                    {i > 0 && <div className="h-6" />}
                    <p className="whitespace-pre-wrap text-base leading-loose">
                      {scene.content}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Right sidebar ──────────────────────────────────────────────── */}
      <SceneRefSidebar
        mode={mode}
        spaceId={spaceId}
        worldId={wid}
        activeScene={activeScene}
        allScenes={displayScenes}
        characters={characters}
        locations={locations}
        items={items}
        events={events}
        collapsed={rightCollapsed}
        onToggleCollapsed={() => setRightCollapsed((v) => !v)}
        onCharacterRefsChange={(refs) => handleActiveScenePatch({ characterRefs: refs })}
        onLocationIdChange={(id) => handleActiveScenePatch({ locationId: id as LocationId | null })}
        onItemIdsChange={(ids) => handleActiveScenePatch({ itemIds: ids as ItemId[] })}
        onEventIdsChange={(ids) => handleActiveScenePatch({ eventIds: ids as EventId[] })}
      />
    </div>
  );
}

export const chapterWorkspaceRoute = createRoute({
  getParentRoute: () => novelWorkspaceRoute,
  path: "chapters/$chapterId",
  component: ChapterWorkspacePage,
});
