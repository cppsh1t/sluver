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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Delete02Icon,
  DragDropIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  SaveIcon,
} from "@hugeicons/core-free-icons";
import { countPhaseRefs, type RefCounts } from "@/api";
import type { CreatePhaseInput } from "@/api";
import type { CharacterPhase, Event, EventId, Location, WorldId } from "@/types";

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
  const [changes, setChanges] = useState(phase?.changes ?? "");
  const [triggerEventId, setTriggerEventId] = useState<EventId | null>(
    phase?.triggerEventId ?? null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disclosureCounts, setDisclosureCounts] = useState<RefCounts | null>(
    null,
  );
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [saving, setSaving] = useState(false);

  function resetToPhase() {
    if (phase) {
      setName(phase.name);
      setAppearance(phase.appearance);
      setChanges(phase.changes);
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
        changes: changes.trim(),
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
              <FieldLabel htmlFor={`phase-${phase?.id ?? "draft"}-changes`}>
                {t("character:phase.changesLabel")}
              </FieldLabel>
              <Textarea
                id={`phase-${phase?.id ?? "draft"}-changes`}
                value={changes}
                onChange={(e) => setChanges(e.currentTarget.value)}
                placeholder={t("character:phase.changesPlaceholder")}
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
        <CardContent className="flex flex-col gap-2">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {phase!.appearance}
          </p>
          {phase!.changes && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {phase!.changes}
            </p>
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
