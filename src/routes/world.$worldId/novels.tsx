import { useMemo, useState } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { worldLayoutRoute } from "./_world";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  BookOpen01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { NovelCard } from "@/components/worldbook/novel-card";
import { NovelFormDialog } from "@/components/worldbook/novel-form-dialog";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { useNovels, useCreateNovel, useDeleteNovel } from "@/hooks";
import type { CreateNovelInput } from "@/api";
import type { NovelId, WorldId } from "@/types";

function NovelsPage() {
  const { t } = useTranslation(["novel", "common"]);
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const wid = worldId as WorldId;
  const navigate = useNavigate();

  const { data: novels = [], isLoading } = useNovels(spaceId, wid);
  const createMut = useCreateNovel(spaceId, wid);
  const deleteMut = useDeleteNovel(spaceId, wid);

  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return novels;
    const q = search.toLowerCase();
    return novels.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [novels, search]);

  async function handleCreate(input: CreateNovelInput) {
    try {
      const created = await createMut.mutateAsync(input);
      toast.success(t("novel:toast.createSuccess"));
      navigate({
        to: "/space/$spaceId/world/$worldId/novels/$novelId",
        params: { spaceId, worldId: wid, novelId: created.id as NovelId },
      });
    } catch (e) {
      toast.error(t("novel:toast.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleDelete(id: NovelId) {
    try {
      await deleteMut.mutateAsync(id);
      toast.success(t("novel:toast.deleteSuccess"));
    } catch (e) {
      toast.error(t("novel:toast.deleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t("novel:list.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("novel:list.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                strokeWidth={2}
                className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("novel:list.searchPlaceholder")}
                className="w-56 pl-8"
              />
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {t("novel:list.createButton")}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse opacity-50">
                <div className="flex flex-col gap-2 px-4 pt-4 pb-1">
                  <div className="h-4 w-24 rounded bg-muted" />
                </div>
                <div className="flex flex-col gap-2 px-4 pb-4">
                  <div className="h-3 w-full rounded bg-muted" />
                  <div className="h-3 w-2/3 rounded bg-muted" />
                  <div className="mt-2 h-3 w-16 rounded bg-muted/50" />
                </div>
              </Card>
            ))}
          </div>
        ) : novels.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={BookOpen01Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>{t("novel:list.empty.title")}</EmptyTitle>
              <EmptyDescription>
                {t("novel:list.empty.description")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("novel:list.createButton")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>{t("novel:list.noResults")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((novel) => (
              <NovelCard
                key={novel.id}
                novel={novel}
                spaceId={spaceId}
                worldId={wid}
                onDelete={() => handleDelete(novel.id as NovelId)}
              />
            ))}
          </div>
        )}
      </div>

      <NovelFormDialog
        key="novel-create"
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
      />
    </div>
  );
}

export const novelsRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "novels",
  component: NovelsPage,
});
