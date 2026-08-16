import { useMemo, useState, type ReactNode } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { worldLayoutRoute } from "./_world";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { CharacterRefPicker } from "@/components/worldbook/character-ref-picker";
import { LocationRefPicker } from "@/components/worldbook/location-ref-picker";
import { EventFormDialog } from "@/components/worldbook/event-form-dialog";
import { ParticipantCard } from "@/components/worldbook/participant-card";
import { EntityCard } from "@/components/worldbook/entity-card";
import { EntityAvatar } from "@/components/ui/entity-avatar";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { useBlobUrl } from "@/components/worldbook/scene-image-lightbox";
import { FormattedTime } from "@/components/timemapper/formatted-time";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, Calendar03Icon, PencilEdit01Icon, ZoomIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useCharacters,
  useEvent,
  useLocations,
  useUpdateEvent,
  useEntityImageBytes,
} from "@/hooks";
import type { UpdateEventInput } from "@/api";
import type {
  Character,
  CharacterRef,
  Event as EventType,
  EventId,
  SpaceId,
  WorldId,
} from "@/types";

/** The basic fields edited by {@link EventFormDialog}. */
type EventBasics = Pick<
  UpdateEventInput,
  "name" | "description" | "notes" | "tags" | "startAt" | "endAt"
>;

/** Build a full `UpdateEventInput` from the current event (full-replacement). */
function toFullInput(ev: EventType): UpdateEventInput {
  return {
    name: ev.name,
    description: ev.description,
    notes: ev.notes,
    tags: ev.tags,
    startAt: ev.startAt,
    endAt: ev.endAt,
    characterRefs: ev.characterRefs,
    locationId: ev.locationId,
  };
}

function EventDetailPage() {
  const { t } = useTranslation(["event", "common"]);
  const { spaceId, worldId, eventId } = useParams({
    from: "/space/$spaceId/world/$worldId/events/$eventId",
  });
  const wid = worldId as WorldId;
  const eid = eventId as EventId;
  const navigate = useNavigate();

  const { data: event, isLoading, isError } = useEvent(spaceId, wid, eid);
  const { data: characters } = useCharacters(spaceId, wid);
  const { data: locations } = useLocations(spaceId, wid);
  const updateMut = useUpdateEvent(spaceId, wid);

  // Image bytes for the lightbox — shares cache with the EntityAvatar below.
  const { data: eventImageBytes } = useEntityImageBytes(
    "event",
    spaceId as SpaceId,
    wid,
    eid,
  );
  const eventImageUrl = useBlobUrl(eventImageBytes);

  const [editOpen, setEditOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Lookup map for resolving participant chip names.
  const charMap = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters ?? []) {
      m.set(c.id, c);
    }
    return m;
  }, [characters]);

  // ─── Mutation handlers (full-replacement update pattern) ───────────────────

  async function handleUpdateBasics(input: EventBasics) {
    if (!event) return;
    try {
      await updateMut.mutateAsync({
        id: eid,
        input: {
          ...input,
          characterRefs: event.characterRefs,
          locationId: event.locationId,
        },
      });
      toast.success(t("event:toast.updateSuccess"));
    } catch (e) {
      toast.error(t("event:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleCommitRefs(refs: CharacterRef[]) {
    if (!event) return;
    try {
      await updateMut.mutateAsync({
        id: eid,
        input: {
          ...toFullInput(event),
          characterRefs: refs,
        },
      });
      toast.success(t("event:toast.updateSuccess"));
    } catch (e) {
      toast.error(t("event:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleRemoveRef(ref: CharacterRef) {
    if (!event) return;
    try {
      await updateMut.mutateAsync({
        id: eid,
        input: {
          ...toFullInput(event),
          characterRefs: event.characterRefs.filter(
            (r) =>
              !(r.characterId === ref.characterId && r.phaseId === ref.phaseId),
          ),
        },
      });
      toast.success(t("event:toast.updateSuccess"));
    } catch (e) {
      toast.error(t("event:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleSelectLocation(locationId: string | null) {
    if (!event) return;
    try {
      await updateMut.mutateAsync({
        id: eid,
        input: {
          ...toFullInput(event),
          locationId: locationId as UpdateEventInput["locationId"],
        },
      });
      toast.success(t("event:toast.updateSuccess"));
    } catch (e) {
      toast.error(t("event:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  // ─── Render: loading ───────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-8">
          <div className="flex flex-col gap-4">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="h-7 w-48 animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-32 animate-pulse rounded-lg bg-muted/50" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !event) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-4 px-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {t("event:list.noResults")}
          </p>
          <Button
            variant="outline"
            onClick={() =>
              navigate({
                to: "/space/$spaceId/world/$worldId/events",
                params: { spaceId, worldId },
              })
            }
          >
            <HugeiconsIcon
              icon={ArrowLeft02Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            {t("common:nav.worldbook.events")}
          </Button>
        </div>
      </div>
    );
  }

  // ─── Derived display values ────────────────────────────────────────────────

  const visibleTags = event.tags.slice(0, 5);
  const extraTags = event.tags.length - 5;

  const timeLabelNode: ReactNode = (() => {
    const { startAt, endAt } = event;
    if (!startAt && !endAt) {
      return t("event:detail.timeSummary.unspecified");
    }
    return (
      <>
        {startAt ? <FormattedTime iso={startAt} /> : "—"}
        {" ~ "}
        {endAt ? <FormattedTime iso={endAt} /> : "—"}
      </>
    );
  })();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        {/* Back link */}
        <Button
          variant="ghost"
          className="-ml-2 mb-6"
          onClick={() =>
            navigate({
              to: "/space/$spaceId/world/$worldId/events",
              params: { spaceId, worldId },
            })
          }
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {t("common:nav.worldbook.events")}
        </Button>

        {/* Identity header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-5">
            <button
              type="button"
              disabled={!eventImageUrl}
              onClick={() => eventImageUrl && setLightboxOpen(true)}
              aria-label={t("event:detail.viewImage")}
              className={cn(
                "group relative shrink-0 rounded-lg",
                eventImageUrl && "cursor-zoom-in",
              )}
            >
              <EntityAvatar
                kind="event"
                spaceId={spaceId as SpaceId}
                worldId={wid}
                id={eid}
                alt={event.name}
                fallbackIcon={
                  <HugeiconsIcon
                    icon={Calendar03Icon}
                    strokeWidth={2}
                    className="size-10 text-muted-foreground"
                  />
                }
                className="w-32 shrink-0 rounded-lg"
              />
              {eventImageUrl && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 transition-colors group-hover:bg-black/20">
                  <HugeiconsIcon
                    icon={ZoomIcon}
                    strokeWidth={2}
                    className="size-8 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              )}
            </button>
            <div className="flex flex-col gap-1">
              <h1 className="font-heading text-2xl font-semibold">
                {event.name}
              </h1>
              {event.description && (
                <p className="text-sm text-muted-foreground">
                  {event.description}
                </p>
              )}
              <p className="text-sm text-muted-foreground">{timeLabelNode}</p>
              {event.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {visibleTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                  {extraTags > 0 && (
                    <span className="px-1.5 py-0.5 text-xs text-muted-foreground/70">
                      +{extraTags}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
          >
            <HugeiconsIcon
              icon={PencilEdit01Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            {t("event:detail.editBasics")}
          </Button>
        </div>

        <Separator className="my-6" />

        {/* Participants section */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-medium">
              {t("event:detail.participants.title")}
            </h2>
            <CharacterRefPicker
              spaceId={spaceId}
              worldId={wid}
              selectedRefs={event.characterRefs}
              characters={characters ?? []}
              onCommit={handleCommitRefs}
            />
          </div>

          {event.characterRefs.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                </EmptyMedia>
                <EmptyTitle>
                  {t("event:detail.participants.empty")}
                </EmptyTitle>
                <EmptyDescription>
                  {t("event:detail.participants.emptyHint")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {event.characterRefs.map((ref) => {
                const c = charMap.get(ref.characterId);
                const p = c?.phases.find((ph) => ph.id === ref.phaseId);
                if (!c || !p) return null;
                return (
                  <ParticipantCard
                    key={`${ref.characterId}-${ref.phaseId}`}
                    characterName={c.name}
                    characterAliases={c.aliases}
                    phaseName={p.name}
                    phaseAppearance={p.appearance}
                    phaseDescription={p.description}
                    onRemove={() => handleRemoveRef(ref)}
                  />
                );
              })}
            </div>
          )}
        </div>

        <Separator className="my-6" />

        {/* Location section */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-medium">
              {t("event:detail.location.title")}
            </h2>
            <LocationRefPicker
              spaceId={spaceId}
              worldId={wid}
              locations={locations ?? []}
              selectedLocationId={event.locationId}
              onSelect={handleSelectLocation}
            />
          </div>
          {event.locationId ? (
            (() => {
              const loc = (locations ?? []).find((l) => l.id === event.locationId);
              if (!loc) {
                return (
                  <p className="text-sm text-muted-foreground">
                    {t("event:detail.location.none")}
                  </p>
                );
              }
              return (
                <div className="max-w-sm">
                  <EntityCard
                    spaceId={spaceId}
                    worldId={wid}
                    id={loc.id}
                    name={loc.name}
                    description={loc.description}
                    tags={loc.tags}
                    updatedAt={loc.updatedAt}
                    entityType="location"
                    selectable
                    selected
                    onRemove={() => handleSelectLocation(null)}
                  />
                </div>
              );
            })()
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("event:detail.location.none")}
            </p>
          )}
        </div>

        <Separator className="my-6" />

        {/* Notes section */}
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">
            {t("event:detail.notes.title")}
          </h2>
          {event.notes ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {event.notes}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("event:detail.notes.empty")}
            </p>
          )}
        </div>
      </div>

      {/* Edit basics dialog */}
      <EventFormDialog
        mode="edit"
        spaceId={spaceId}
        worldId={wid}
        open={editOpen}
        onOpenChange={setEditOpen}
        entity={
          event && {
            id: event.id,
            name: event.name,
            description: event.description,
            notes: event.notes,
            tags: event.tags,
            startAt: event.startAt,
            endAt: event.endAt,
          }
        }
        key={`event-edit-${event.id ?? "closed"}`}
        onSubmit={handleUpdateBasics}
      />

      <ImageLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        src={eventImageUrl}
        alt={event.name}
      />
    </div>
  );
}

export const eventDetailRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "events/$eventId",
  component: EventDetailPage,
});
