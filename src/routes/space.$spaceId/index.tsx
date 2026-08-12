import { useState } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, FileImportIcon, Globe02Icon } from "@hugeicons/core-free-icons";

import { spaceLayoutRoute } from "./_space";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { importWorld } from "@/api";
import { toErrorPayload } from "@/api/client";
import { AppSidebar } from "@/components/app-sidebar";
import { CreateWorldDialog } from "@/components/world-hub/create-world-dialog";
import { WorldCard } from "@/components/world-hub/world-card";
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
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { logger } from "@/lib/logger";
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
  const queryClient = useQueryClient();
  const { spaceId } = useParams({ from: "/space/$spaceId" });

  const spacesQ = useSpaces();
  const space = spacesQ.data?.find((s) => s.id === spaceId);

  const worldsQ = useWorlds(spaceId);
  const createWorld = useCreateWorld(spaceId);
  const updateWorld = useUpdateWorld(spaceId);
  const deleteWorld = useDeleteWorld(spaceId);
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  // Populated only when an import collided with an existing world and the
  // user must confirm overwrite. `null` = no pending confirmation.
  const [overwriteConfirm, setOverwriteConfirm] = useState<{
    inputPath: string;
    existingName: string;
  } | null>(null);

  const worlds = worldsQ.data ?? [];

  async function handleCreate(input: CreateWorldInput) {
    try {
      const newWorld = await createWorld.mutateAsync(input);
      toast.success(i18n.t("world:toast.createSuccess"));
      // Return the new id so CreateWorldDialog can commit a pending cover
      // image (if any) via `updateWorldImage`.
      return newWorld.id;
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

  /**
   * Import a `.sluver-world` file. First attempt is non-destructive
   * (`overwrite: false`); on `WORLD_IMPORT_ALREADY_EXISTS` we surface the
   * overwrite confirmation dialog instead of erroring. Only `world_id` is
   * logged (snake_case per ADR-0016) — never the world name.
   */
  async function handleImport() {
    const inputPath = await open({
      multiple: false,
      filters: [{ name: "Sluver World", extensions: ["sluver-world"] }],
    });
    if (typeof inputPath !== "string") return;

    setImporting(true);
    try {
      const world = await importWorld({ spaceId, inputPath, overwrite: false });
      logger.info("world.imported", { world_id: world.id });
      toast.success(i18n.t("world:import.toast.success"));
      await queryClient.invalidateQueries({ queryKey: ["worlds", spaceId] });
    } catch (e) {
      const payload = toErrorPayload(e);
      if (payload.code === "WORLD_IMPORT_ALREADY_EXISTS") {
        setOverwriteConfirm({
          inputPath,
          existingName: payload.args.existing_name ?? "",
        });
      } else {
        toast.error(i18n.t("world:import.toast.failed"), {
          description: translateError(payload),
        });
      }
    } finally {
      setImporting(false);
    }
  }

  /** Second leg of {@link handleImport}: re-run with `overwrite: true`. */
  async function handleConfirmOverwrite() {
    if (!overwriteConfirm) return;
    const { inputPath } = overwriteConfirm;
    setImporting(true);
    try {
      const world = await importWorld({ spaceId, inputPath, overwrite: true });
      logger.info("world.imported", { world_id: world.id, overwrite: true });
      toast.success(i18n.t("world:import.toast.success"));
      await queryClient.invalidateQueries({ queryKey: ["worlds", spaceId] });
    } catch (e) {
      toast.error(i18n.t("world:import.toast.failed"), {
        description: translateError(toErrorPayload(e)),
      });
    } finally {
      setImporting(false);
      setOverwriteConfirm(null);
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
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => void handleImport()}
                  disabled={importing}
                >
                  <HugeiconsIcon
                    icon={FileImportIcon}
                    data-icon="inline-start"
                    strokeWidth={2}
                  />
                  {t("world:import.action")}
                </Button>
                <Button onClick={() => setCreateOpen(true)}>
                  <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
                  {t("space:home.createWorld")}
                </Button>
              </div>
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
                      spaceId={spaceId}
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

      <AlertDialog
        open={overwriteConfirm !== null}
        onOpenChange={(next) => {
          if (!next) setOverwriteConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("world:import.overwrite.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {overwriteConfirm
                ? t("world:import.overwrite.description", {
                    name: overwriteConfirm.existingName,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setOverwriteConfirm(null)}
              disabled={importing}
            >
              {t("world:import.overwrite.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={importing}
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmOverwrite();
              }}
            >
              {t("world:import.overwrite.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const spaceHomeRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "/",
  component: SpaceHomePage,
});
