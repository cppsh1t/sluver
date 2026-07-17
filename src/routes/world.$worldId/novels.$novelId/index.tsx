import { useEffect } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";

import { novelWorkspaceRoute } from "../novels.$novelId";
import { useChapters } from "@/hooks";
import type { ChapterId, NovelId, WorldId } from "@/types";

function NovelIndexPage() {
  const { spaceId, worldId, novelId } = useParams({
    from: "/space/$spaceId/world/$worldId/novels/$novelId",
  });
  const wid = worldId as WorldId;
  const nid = novelId as NovelId;
  const navigate = useNavigate();

  const { data: chapters, isLoading } = useChapters(spaceId, wid, nid);

  useEffect(() => {
    if (isLoading || !chapters) return;
    if (chapters.length > 0) {
      navigate({
        to: "/space/$spaceId/world/$worldId/novels/$novelId/chapters/$chapterId",
        params: {
          spaceId,
          worldId: wid,
          novelId: nid,
          chapterId: chapters[0].id as ChapterId,
        },
        replace: true,
      });
    }
  }, [chapters, isLoading, navigate, spaceId, wid, nid]);

  // Zero-chapter or loading: render nothing (the sidebar shows the CTA).
  return null;
}

export const novelIndexRoute = createRoute({
  getParentRoute: () => novelWorkspaceRoute,
  path: "/",
  component: NovelIndexPage,
});
