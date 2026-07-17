import { createContext, useContext, useState } from "react";
import {
  Outlet,
  createRoute,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { worldLayoutRoute } from "./_world";
import { NovelFormDialog } from "@/components/worldbook/novel-form-dialog";
import { ChapterSidebar } from "@/components/worldbook/chapter-sidebar";
import type { WorkspaceMode as SidebarMode } from "@/components/worldbook/chapter-sidebar";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useNovel,
  useChapters,
  useCreateChapter,
  useDeleteChapter,
  useReorderChapters,
  useUpdateNovel,
} from "@/hooks";
import type { UpdateNovelInput } from "@/api";
import type { Chapter, ChapterId, NovelId, WorldId } from "@/types";

export type WorkspaceMode = SidebarMode;

interface WorkspaceCtx {
  mode: WorkspaceMode;
}

const WorkspaceContext = createContext<WorkspaceCtx>({ mode: "edit" });

function NovelWorkspaceLayout() {
  const { t } = useTranslation(["novel", "common"]);
  const { spaceId, worldId, novelId } = useParams({
    from: "/space/$spaceId/world/$worldId/novels/$novelId",
  });
  const wid = worldId as WorldId;
  const nid = novelId as NovelId;
  const location = useLocation();
  const navigate = useNavigate();

  const { data: novel } = useNovel(spaceId, wid, nid);
  const { data: chapters = [] } = useChapters(spaceId, wid, nid);
  const createChapterMut = useCreateChapter(spaceId, wid);
  const deleteChapterMut = useDeleteChapter(spaceId, wid, nid);
  const reorderMut = useReorderChapters(spaceId, wid, nid);
  const updateNovelMut = useUpdateNovel(spaceId, wid);

  const [mode, setMode] = useState<WorkspaceMode>("edit");
  const [editNovelOpen, setEditNovelOpen] = useState(false);

  // Derive active chapter from URL (layout route doesn't have chapterId param).
  const chapterMatch = location.pathname.match(/\/chapters\/([^/]+)/);
  const activeChapterId = (chapterMatch?.[1] ?? null) as ChapterId | null;

  async function handleAddChapter() {
    try {
      const n = (chapters.length + 1).toString();
      const created = await createChapterMut.mutateAsync({
        novelId: nid,
        input: { title: i18n.t("novel:chapter.defaultTitle", { n }) },
      });
      navigate({
        to: "/space/$spaceId/world/$worldId/novels/$novelId/chapters/$chapterId",
        params: { spaceId, worldId: wid, novelId: nid, chapterId: created.id as ChapterId },
      });
      toast.success(i18n.t("novel:chapter.toast.createSuccess"));
    } catch (e) {
      toast.error(i18n.t("novel:chapter.toast.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleDeleteChapter(chapter: Chapter) {
    try {
      await deleteChapterMut.mutateAsync(chapter.id as ChapterId);
      toast.success(i18n.t("novel:chapter.toast.deleteSuccess"));
      // Only navigate if the deleted chapter was the active one
      if (chapter.id !== activeChapterId) return;
      const remaining = chapters.filter((c) => c.id !== chapter.id);
      if (remaining.length > 0) {
        navigate({
          to: "/space/$spaceId/world/$worldId/novels/$novelId/chapters/$chapterId",
          params: { spaceId, worldId: wid, novelId: nid, chapterId: remaining[0].id as ChapterId },
        });
      } else {
        navigate({
          to: "/space/$spaceId/world/$worldId/novels/$novelId",
          params: { spaceId, worldId: wid, novelId: nid },
        });
      }
    } catch (e) {
      toast.error(i18n.t("novel:chapter.toast.deleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleReorderChapters(ids: ChapterId[]) {
    try {
      await reorderMut.mutateAsync(ids);
      toast.success(i18n.t("novel:chapter.toast.reorderSuccess"));
    } catch (e) {
      toast.error(i18n.t("novel:chapter.toast.reorderFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleUpdateNovel(input: UpdateNovelInput) {
    try {
      await updateNovelMut.mutateAsync({ id: nid, input });
      toast.success(t("novel:toast.updateSuccess"));
    } catch (e) {
      toast.error(t("novel:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  return (
    <WorkspaceContext.Provider value={{ mode }}>
      <div className="flex flex-1 overflow-hidden">
        <ChapterSidebar
          spaceId={spaceId}
          worldId={wid}
          novelId={nid}
          novel={novel}
          chapters={chapters}
          activeChapterId={activeChapterId}
          mode={mode}
          onModeChange={setMode}
          onEditNovel={() => setEditNovelOpen(true)}
          onAddChapter={handleAddChapter}
          onDeleteChapter={handleDeleteChapter}
          onReorderChapters={handleReorderChapters}
        />
        <Outlet />
      </div>

      {novel && (
        <NovelFormDialog
          key={`novel-edit-${novel.id}`}
          mode="edit"
          open={editNovelOpen}
          onOpenChange={setEditNovelOpen}
          entity={{
            title: novel.title,
            description: novel.description,
            tags: novel.tags,
          }}
          onSubmit={handleUpdateNovel}
        />
      )}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceMode(): WorkspaceMode {
  return useContext(WorkspaceContext).mode;
}

export const novelWorkspaceRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "novels/$novelId",
  component: NovelWorkspaceLayout,
});
