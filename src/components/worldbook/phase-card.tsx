import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
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
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EventCard } from "@/components/worldbook/event-card";
import { EventRefPicker } from "@/components/worldbook/event-ref-picker";
import { useBlobUrl } from "@/components/worldbook/scene-image-lightbox";
import { EntityImageField } from "@/components/entity-image-field";
import { EntityAvatar } from "@/components/ui/entity-avatar";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Delete02Icon,
  DragDropIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  SaveIcon,
  UserCircleIcon,
  ZoomIcon,
} from "@hugeicons/core-free-icons";
import { countPhaseRefs, type RefCounts } from "@/api";
import type { CreatePhaseInput } from "@/api";
import { cn } from "@/lib/utils";
import { useEntityImageBytes } from "@/hooks";
import type {
  CharacterPhase,
  Event,
  EventId,
  Location,
  PhaseId,
  SpaceId,
  WorldId,
} from "@/types";

interface PhaseCardProps {
  spaceId: string;
  worldId: WorldId;
  events: Event[];
  locations: Location[];
  phase?: CharacterPhase;
  isDragging?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  onSave: (input: CreatePhaseInput) => Promise<void>;
  onCancel?: () => void;
  onDelete?: () => void;
}

function PhaseCard({
  spaceId,
  worldId,
  events,
  locations,
  phase,
  isDragging,
  dragHandleProps,
  onSave,
  onCancel,
  onDelete,
}: PhaseCardProps) {
  const { t } = useTranslation(["character", "common", "event"]);
  const navigate = useNavigate();
  const isDraft = !phase;

  const [editing, setEditing] = useState(!phase);
  const [name, setName] = useState(phase?.name ?? "");
  const [appearance, setAppearance] = useState(phase?.appearance ?? "");
  const [description, setDescription] = useState(phase?.description ?? "");
  const [conversationStyle, setConversationStyle] = useState(
    phase?.conversationStyle ?? "",
  );
  const [triggerEventId, setTriggerEventId] = useState<EventId | null>(
    phase?.triggerEventId ?? null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disclosureCounts, setDisclosureCounts] = useState<RefCounts | null>(
    null,
  );
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { data: phaseImageBytes } = useEntityImageBytes(
    "phase",
    spaceId as SpaceId,
    worldId,
    phase?.id as PhaseId | undefined,
  );
  const phaseImageUrl = useBlobUrl(phaseImageBytes);

  function resetToPhase() {
    if (phase) {
      setName(phase.name);
      setAppearance(phase.appearance);
      setDescription(phase.description);
      setConversationStyle(phase.conversationStyle);
      setTriggerEventId(phase.triggerEventId);
    }
  }

  async function handleSave() {
    const trimmedName = name.trim();
    const trimmedAppearance = appearance.trim();
    if (!trimmedName || !trimmedAppearance || saving) return;

    try {
      setSaving(true);
      await onSave({
        name: trimmedName,
        appearance: trimmedAppearance,
        description: description.trim(),
        conversationStyle: conversationStyle.trim(),
        triggerEventId,
      });
      if (!isDraft) {
        setEditing(false);
      }
    } catch {
      // Error handled by caller (toast). Keep editing open.
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (isDraft) {
      onCancel?.();
    } else {
      resetToPhase();
      setEditing(false);
    }
  }

  function handleEdit() {
    resetToPhase();
    setEditing(true);
  }

  // ADR-0006: before deleting, count how many events/scenes reference this
  // phase. If > 0, disclose the blast radius before the cascade.
  async function handleDeleteClick() {
    if (loadingCounts) return;
    setLoadingCounts(true);
    try {
      const counts = await countPhaseRefs(spaceId, worldId, phase!.id);
      setDisclosureCounts(counts);
    } catch {
      // Count failed — fall back to the simple (non-disclosure) confirm.
      setDisclosureCounts(null);
    } finally {
      setLoadingCounts(false);
      setConfirmOpen(true);
    }
  }

  const isDisclosable =
    disclosureCounts !== null &&
    (disclosureCounts.events > 0 || disclosureCounts.scenes > 0);

  const triggerEvent = phase?.triggerEventId
    ? events.find((e) => e.id === phase.triggerEventId)
    : undefined;

  const locationNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const loc of locations) {
      map.set(loc.id, loc.name);
    }
    return map;
  }, [locations]);

  if (editing) {
    // ─── Edit mode ──────────────────────────────────────────────────────────
    return (
      <Card className={isDragging ? "opacity-50" : undefined}>
        <CardContent>
          <FieldGroup>
            {/* Phase portrait — only when editing an existing phase (drafts
                have no id yet; per the project pattern, upload happens after
                the first save via the edit-mode UI). */}
            {!isDraft && phase && (
              <Field>
                <FieldLabel>{t("common:imageField.change")}</FieldLabel>
                <EntityImageField
                  kind="phase"
                  spaceId={spaceId}
                  worldId={worldId}
                  id={phase.id as PhaseId}
                  aspect={3 / 4}
                  outputWidth={300}
                  outputHeight={400}
                  className="flex items-center gap-4"
                  avatarClassName="w-24 rounded-md"
                  fallbackIcon={
                    <HugeiconsIcon
                      icon={UserCircleIcon}
                      strokeWidth={1.5}
                      className="size-8 text-muted-foreground"
                    />
                  }
                  cropTitle={t("character:phase.edit")}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`phase-${phase?.id ?? "draft"}-name`}>
                {t("character:phase.nameLabel")}
              </FieldLabel>
              <Input
                id={`phase-${phase?.id ?? "draft"}-name`}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t("character:phase.namePlaceholder")}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`phase-${phase?.id ?? "draft"}-appearance`}>
                {t("character:phase.appearanceLabel")}
              </FieldLabel>
              <Textarea
                id={`phase-${phase?.id ?? "draft"}-appearance`}
                value={appearance}
                onChange={(e) => setAppearance(e.currentTarget.value)}
                placeholder={t("character:phase.appearancePlaceholder")}
                rows={2}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`phase-${phase?.id ?? "draft"}-description`}>
                {t("character:phase.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id={`phase-${phase?.id ?? "draft"}-description`}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("character:phase.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
            <Field>
              <FieldLabel
                htmlFor={`phase-${phase?.id ?? "draft"}-conversation-style`}
              >
                {t("character:phase.conversationStyleLabel")}
              </FieldLabel>
              <Textarea
                id={`phase-${phase?.id ?? "draft"}-conversation-style`}
                value={conversationStyle}
                onChange={(e) => setConversationStyle(e.currentTarget.value)}
                placeholder={t("character:phase.conversationStylePlaceholder")}
                rows={3}
              />
            </Field>
            <Field>
              <FieldLabel>{t("event:picker.event.title")}</FieldLabel>
              <EventRefPicker
                spaceId={spaceId}
                worldId={worldId}
                events={events}
                locations={locations}
                selectedEventId={triggerEventId}
                onSelect={setTriggerEventId}
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={handleCancel}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
            {t("character:phase.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || !appearance.trim() || saving}
          >
            <HugeiconsIcon icon={SaveIcon} strokeWidth={2} data-icon="inline-start" />
            {t("character:phase.save")}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // ─── Read mode (existing phase only) ─────────────────────────────────────
  return (
    <>
      <Card className={isDragging ? "opacity-50" : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {dragHandleProps && (
              <button
                type="button"
                className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                {...dragHandleProps}
              >
                <HugeiconsIcon icon={DragDropIcon} strokeWidth={2} />
                <span className="sr-only">Drag to reorder</span>
              </button>
            )}
            <span className="truncate">{phase!.name}</span>
          </CardTitle>
          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                <span className="sr-only">{t("common:actions.moreActions")}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleEdit}>
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                  {t("character:phase.edit")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={handleDeleteClick}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {t("character:phase.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* Hero row: phase portrait alongside the primary (appearance) field,
              mirroring the avatar-in-title pattern used by EventCard but placed
              in the content area so the CardHeader layout stays untouched. */}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!phaseImageUrl}
              onClick={() => phaseImageUrl && setLightboxOpen(true)}
              aria-label={t("character:detail.viewImage")}
              className={cn(
                "group relative shrink-0 rounded-md",
                phaseImageUrl && "cursor-zoom-in",
              )}
            >
              <EntityAvatar
                kind="phase"
                spaceId={spaceId as SpaceId}
                worldId={worldId}
                id={phase!.id as PhaseId}
                alt={phase!.name}
                fallbackIcon={
                  <HugeiconsIcon
                    icon={UserCircleIcon}
                    strokeWidth={1.5}
                    className="size-8 text-muted-foreground"
                  />
                }
                className="w-20 shrink-0 rounded-md"
              />
              {phaseImageUrl && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-black/0 transition-colors group-hover:bg-black/20">
                  <HugeiconsIcon
                    icon={ZoomIcon}
                    strokeWidth={2}
                    className="size-8 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              )}
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("character:phase.appearanceLabel")}
              </span>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {phase!.appearance}
              </p>
            </div>
          </div>
          {phase!.description && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("character:phase.descriptionLabel")}
              </span>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {phase!.description}
              </p>
            </div>
          )}
          {phase!.conversationStyle && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("character:phase.conversationStyleLabel")}
              </span>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {phase!.conversationStyle}
              </p>
            </div>
          )}
          {triggerEvent && (
            <EventCard
              event={triggerEvent}
              spaceId={spaceId}
              worldId={worldId}
              locationName={
                triggerEvent.locationId
                  ? (locationNameById.get(triggerEvent.locationId) ?? null)
                  : null
              }
              selectable
              selected
              onSelect={() =>
                navigate({
                  to: "/space/$spaceId/world/$worldId/events/$eventId",
                  params: { spaceId, worldId, eventId: triggerEvent.id },
                })
              }
            />
          )}
        </CardContent>
      </Card>

      <ImageLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        src={phaseImageUrl}
        alt={phase!.name}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isDisclosable
                ? t("character:phase.deleteDisclosableTitle", {
                    name: phase!.name,
                  })
                : t("character:phase.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isDisclosable
                ? t("character:phase.deleteDisclosableDescription", {
                    name: phase!.name,
                    events: disclosureCounts!.events,
                    scenes: disclosureCounts!.scenes,
                  })
                : t("character:phase.deleteDescription", { name: phase!.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete?.();
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { PhaseCard };
