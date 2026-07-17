import { useState } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Globe02Icon } from "@hugeicons/core-free-icons";

import { spaceLayoutRoute } from "./_space";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { AppSidebar } from "@/components/app-sidebar";
import { CreateWorldDialog } from "@/components/world-hub/create-world-dialog";
import { WorldCard } from "@/components/world-hub/world-card";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  useCreateWorld,
  useDeleteWorld,
  useSpaces,
  useUpdateWorld,
  useWorlds,
} from "@/hooks";
import type {
  CreateWorldInput,
  UpdateWorldInput,
} from "@/api";
import type { World } from "@/types";

/**
 * Space-home (ADR-0009 middle tier) — the page shown when a Space tab is open
 * but no World is selected. Renders its own `AppSidebar` (the context-
 * sensitive space-home sidebar) plus a `<main>` listing the Space's Worlds.
 *
 * The rich world-detail lives under `/space/$spaceId/world/$worldId/…`; this
 * page is the launcher + light management surface for the Space's Worlds.
 */
function SpaceHomePage() {
  const { t } = useTranslation(["space", "world", "common"]);
  const navigate = useNavigate();
  const { spaceId } = useParams({ from: "/space/$spaceId" });

  const spacesQ = useSpaces();
  const space = spacesQ.data?.find((s) => s.id === spaceId);

  const worldsQ = useWorlds(spaceId);
  const createWorld = useCreateWorld(spaceId);
  const updateWorld = useUpdateWorld(spaceId);
  const deleteWorld = useDeleteWorld(spaceId);
  const [createOpen, setCreateOpen] = useState(false);

  const worlds = worldsQ.data ?? [];

  async function handleCreate(input: CreateWorldInput) {
    try {
      await createWorld.mutateAsync(input);
      toast.success(i18n.t("world:toast.createSuccess"));
    } catch (err) {
      toast.error(i18n.t("world:toast.createFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      throw err;
    }
  }

  async function handleUpdate(world: World, input: UpdateWorldInput) {
    try {
      await updateWorld.mutateAsync({ id: world.id, input });
      toast.success(i18n.t("world:toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("world:toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      throw err;
    }
  }

  async function handleDelete(world: World) {
    try {
      await deleteWorld.mutateAsync(world.id);
      toast.success(i18n.t("world:toast.deleteSuccess"));
    } catch (err) {
      toast.error(i18n.t("world:toast.deleteFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  function handleOpen(world: World) {
    navigate({
      to: "/space/$spaceId/world/$worldId",
      params: { spaceId, worldId: world.id },
    });
  }

  return (
    <>
      <AppSidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-10">
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <h1 className="font-heading text-2xl font-semibold tracking-tight">
                  {space?.name ?? t("space:home.title")}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("space:home.subtitle")}
                </p>
              </div>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
                {t("space:home.createWorld")}
              </Button>
            </header>

            <div className="mt-8">
              {worldsQ.isLoading ? (
                <p className="text-sm text-muted-foreground">
                  {t("common:loading")}
                </p>
              ) : worlds.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <HugeiconsIcon icon={Globe02Icon} strokeWidth={2} />
                    </EmptyMedia>
                    <EmptyTitle>
                      {t("space:home.emptyWorlds.title")}
                    </EmptyTitle>
                    <EmptyDescription>
                      {t("space:home.emptyWorlds.description")}
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button onClick={() => setCreateOpen(true)} variant="outline">
                    <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
                    {t("space:home.emptyWorlds.cta")}
                  </Button>
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
          </div>
        </div>
      </main>

      <CreateWorldDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
      />
    </>
  );
}

export const spaceHomeRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/",
  component: SpaceHomePage,
});
