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
import { Add01Icon, Calendar03Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { EventCard } from "@/components/worldbook/event-card";
import { EventFormDialog } from "@/components/worldbook/event-form-dialog";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useEvents,
  useCreateEvent,
  useDeleteEvent,
  useLocations,
} from "@/hooks";
import type { CreateEventInput } from "@/api";
import type { EventId, WorldId } from "@/types";

function EventsPage() {
  const { t } = useTranslation(["event", "common"]);
  const { worldId } = useParams({ from: "/world/$worldId" });
  const wid = worldId as WorldId;
  const navigate = useNavigate();

  const { data: events = [], isLoading } = useEvents(wid);
  const { data: locations = [] } = useLocations(wid);
  const createMut = useCreateEvent(wid);
  const deleteMut = useDeleteEvent(wid);

  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  const locationMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const loc of locations) {
      m.set(loc.id, loc.name);
    }
    return m;
  }, [locations]);

  const filtered = useMemo(() => {
    if (!search.trim()) return events;
    const q = search.toLowerCase();
    return events.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [events, search]);

  async function handleCreate(input: CreateEventInput) {
    try {
      const created = await createMut.mutateAsync(input);
      toast.success(t("event:toast.createSuccess"));
      navigate({
        to: "/world/$worldId/events/$eventId",
        params: { worldId: wid, eventId: created.id },
      });
    } catch (e) {
      toast.error(t("event:toast.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleDelete(id: EventId) {
    try {
      await deleteMut.mutateAsync(id);
      toast.success(t("event:toast.deleteSuccess"));
    } catch (e) {
      toast.error(t("event:toast.deleteFailed"), {
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
              {t("event:list.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("event:list.subtitle")}
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
                placeholder={t("event:list.searchPlaceholder")}
                className="w-56 pl-8"
              />
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {t("event:list.createButton")}
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
        ) : events.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>
                {t("event:list.empty.title")}
              </EmptyTitle>
              <EmptyDescription>
                {t("event:list.empty.description")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("event:list.createButton")}
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
                {t("event:list.noResults")}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((evt) => (
              <EventCard
                key={evt.id}
                event={evt}
                worldId={wid}
                locationName={
                  evt.locationId ? (locationMap.get(evt.locationId) ?? null) : null
                }
                onDelete={() => handleDelete(evt.id)}
              />
            ))}
          </div>
        )}
      </div>

      <EventFormDialog
        key="event-create"
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
      />
    </div>
  );
}

export const eventsRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "events",
  component: EventsPage,
});
