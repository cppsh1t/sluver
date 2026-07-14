import { useMemo, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
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
import { Add01Icon, MapPinIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { ElementFormDialog } from "@/components/worldbook/element-form-dialog";
import { EntityCard } from "@/components/worldbook/entity-card";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  useDeleteLocation,
} from "@/hooks";
import type { UpdateElementInput } from "@/api";
import type { Location, WorldId } from "@/types";

function LocationsPage() {
  const { t } = useTranslation(["worldbook", "common"]);
  const { worldId } = useParams({ from: "/world/$worldId" });
  const wid = worldId as WorldId;
  const entityType = "location" as const;
  const entityPlural = t("worldbook:entityName.location.plural");

  const { data: entities = [], isLoading } = useLocations(wid);
  const createMut = useCreateLocation(wid);
  const updateMut = useUpdateLocation(wid);
  const deleteMut = useDeleteLocation(wid);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Location | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return entities;
    const q = search.toLowerCase();
    return entities.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [entities, search]);

  async function handleCreate(input: UpdateElementInput) {
    try {
      await createMut.mutateAsync(input);
      toast.success(t("worldbook:toast.createSuccess", { entity: entityPlural }));
    } catch (e) {
      toast.error(t("worldbook:toast.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleUpdate(id: string, input: UpdateElementInput) {
    try {
      await updateMut.mutateAsync({ id: id as Location["id"], input });
      toast.success(t("worldbook:toast.updateSuccess", { entity: entityPlural }));
    } catch (e) {
      toast.error(t("worldbook:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMut.mutateAsync(id as Location["id"]);
      toast.success(t("worldbook:toast.deleteSuccess", { entity: entityPlural }));
    } catch (e) {
      toast.error(t("worldbook:toast.deleteFailed"), {
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
              {t("worldbook:list.title", { entity: entityPlural })}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("worldbook:list.subtitle", { entity: entityPlural })}
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
                placeholder={t("worldbook:search.placeholder")}
                className="w-56 pl-8"
              />
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {t("worldbook:list.createButton", { entity: entityPlural })}
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
        ) : entities.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={MapPinIcon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>
                {t("worldbook:empty.title", { entity: entityPlural })}
              </EmptyTitle>
              <EmptyDescription>
                {t("worldbook:empty.description", { entity: entityPlural })}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("worldbook:empty.cta", { entity: entityPlural })}
              </Button>
            </EmptyContent>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>
                {t("worldbook:search.noResults", { query: search })}
              </EmptyTitle>
              <EmptyDescription>
                {t("worldbook:search.noResultsDescription")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((entity) => (
              <EntityCard
                key={entity.id}
                name={entity.name}
                description={entity.description}
                tags={entity.tags}
                updatedAt={entity.updatedAt}
                entityType={entityType}
                onEdit={() => setEditTarget(entity)}
                onDelete={() => handleDelete(entity.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ElementFormDialog
        mode="create"
        entityType={entityType}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
      />

      <ElementFormDialog
        key={editTarget?.id ?? "edit-closed"}
        mode="edit"
        entityType={entityType}
        entity={editTarget ?? undefined}
        open={!!editTarget}
        onOpenChange={(v) => !v && setEditTarget(null)}
        onSubmit={(input) => handleUpdate(editTarget!.id, input)}
      />
    </div>
  );
}

export const locationsRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "locations",
  component: LocationsPage,
});
