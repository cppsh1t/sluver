import { useEffect } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";

import { novelWorkspaceRoute } from "../novels.$novelId";
import { useChapters } from "@/hooks";
import type { ChapterId, NovelId, WorldId } from "@/types";

function NovelIndexPage() {
  const { worldId, novelId } = useParams({
    from: "/world/$worldId/novels/$novelId",
  });
  const wid = worldId as WorldId;
  const nid = novelId as NovelId;
  const navigate = useNavigate();

  const { data: chapters, isLoading } = useChapters(wid, nid);

  useEffect(() => {
    if (isLoading || !chapters) return;
    if (chapters.length > 0) {
      navigate({
        to: "/world/$worldId/novels/$novelId/chapters/$chapterId",
        params: {
          worldId: wid,
          novelId: nid,
          chapterId: chapters[0].id as ChapterId,
        },
        replace: true,
      });
    }
  }, [chapters, isLoading, navigate, wid, nid]);

  // Zero-chapter or loading: render nothing (the sidebar shows the CTA).
  return null;
}

export const novelIndexRoute = createRoute({
  getParentRoute: () => novelWorkspaceRoute,
  path: "/",
  component: NovelIndexPage,
});
