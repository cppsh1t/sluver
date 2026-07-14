import { useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { appLayoutRoute } from "./_app";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Globe02Icon } from "@hugeicons/core-free-icons";
import { CreateWorldDialog } from "@/components/world-hub/create-world-dialog";
import { WorldCard } from "@/components/world-hub/world-card";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useWorlds,
  useCreateWorld,
  useUpdateWorld,
  useDeleteWorld,
} from "@/hooks";
import type { CreateWorldInput, UpdateWorldInput } from "@/api";
import type { World } from "@/types";

function WorldHubPage() {
  const { t } = useTranslation(["world", "common"]);
  const navigate = useNavigate();
  const { data: worlds = [], isLoading: loading } = useWorlds();
  const createMutation = useCreateWorld();
  const updateMutation = useUpdateWorld();
  const deleteMutation = useDeleteWorld();
  const [createOpen, setCreateOpen] = useState(false);

  function handleOpen(world: World) {
    navigate({ to: "/world/$worldId", params: { worldId: world.id } });
  }

  async function handleCreate(input: CreateWorldInput) {
    try {
      await createMutation.mutateAsync(input);
      toast.success(t("world:toast.createSuccess"));
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(t("world:toast.createFailed"), {
        description: translateError(payload),
      });
      throw e;
    }
  }

  async function handleUpdate(world: World, input: UpdateWorldInput) {
    try {
      await updateMutation.mutateAsync({ id: world.id, input });
      toast.success(t("world:toast.updateSuccess"));
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(t("world:toast.updateFailed"), {
        description: translateError(payload),
      });
      throw e;
    }
  }

  async function handleDelete(world: World) {
    try {
      await deleteMutation.mutateAsync(world.id);
      toast.success(t("world:toast.deleteSuccess"));
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(t("world:toast.deleteFailed"), {
        description: translateError(payload),
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t("world:hub.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("world:hub.subtitle")}
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {t("world:hub.createButton")}
          </Button>
        </div>

        {loading ? (
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
        ) : worlds.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Globe02Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>{t("world:hub.empty.title")}</EmptyTitle>
              <EmptyDescription>
                {t("world:hub.empty.description")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("world:hub.empty.cta")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {worlds.map((world) => (
              <WorldCard
                key={world.id}
                world={world}
                onOpen={handleOpen}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      <CreateWorldDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
      />
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  component: WorldHubPage,
});
