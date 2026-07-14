import { useState } from "react";
import {
  createRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

import { worldLayoutRoute } from "./_world";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { CharacterFormDialog } from "@/components/worldbook/character-form-dialog";
import { PhaseCard } from "@/components/worldbook/phase-card";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowLeft02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useCharacter,
  useUpdateCharacter,
  useAddPhase,
  useUpdatePhase,
  useDeletePhase,
  useReorderPhases,
} from "@/hooks";
import type { UpdateCharacterInput, CreatePhaseInput } from "@/api";
import type { CharacterId, CharacterPhase, WorldId } from "@/types";

// ─── Sortable wrapper ────────────────────────────────────────────────────────

interface SortablePhaseCardProps {
  phase: CharacterPhase;
  onUpdatePhase: (phaseId: string, input: CreatePhaseInput) => Promise<void>;
  onDeletePhase: (phaseId: string) => Promise<void>;
}

function SortablePhaseCard({
  phase,
  onUpdatePhase,
  onDeletePhase,
}: SortablePhaseCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: phase.id });

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <PhaseCard
        phase={phase}
        isDragging={isDragging}
        dragHandleProps={{ ...attributes, ...listeners }}
        onSave={(input) => onUpdatePhase(phase.id, input)}
        onDelete={() => onDeletePhase(phase.id)}
      />
    </div>
  );
}

// ─── Detail page ─────────────────────────────────────────────────────────────

function CharacterDetailPage() {
  const { t } = useTranslation(["character", "common"]);
  const { worldId, characterId } = useParams({
    from: "/world/$worldId/characters/$characterId",
  });
  const wid = worldId as WorldId;
  const cid = characterId as CharacterId;
  const navigate = useNavigate();

  const { data: character, isLoading, isError } = useCharacter(wid, cid);
  const updateCharacterMut = useUpdateCharacter(wid);
  const addPhaseMut = useAddPhase(wid);
  const updatePhaseMut = useUpdatePhase(wid);
  const deletePhaseMut = useDeletePhase(wid);
  const reorderMut = useReorderPhases(wid);

  const [editBaseOpen, setEditBaseOpen] = useState(false);
  const [draftActive, setDraftActive] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const phases = character?.phases ?? [];

  async function handleUpdateBase(input: UpdateCharacterInput) {
    try {
      await updateCharacterMut.mutateAsync({ id: cid, input });
      toast.success(t("character:toast.updateSuccess"));
    } catch (e) {
      toast.error(t("character:toast.updateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleAddPhase(input: CreatePhaseInput) {
    try {
      await addPhaseMut.mutateAsync({ characterId: cid, input });
      setDraftActive(false);
      toast.success(t("character:toast.phaseCreateSuccess"));
    } catch (e) {
      toast.error(t("character:toast.phaseCreateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleUpdatePhase(phaseId: string, input: CreatePhaseInput) {
    const existing = phases.find((p) => p.id === phaseId);
    try {
      await updatePhaseMut.mutateAsync({
        phaseId: phaseId as CharacterPhase["id"],
        input: {
          name: input.name,
          appearance: input.appearance,
          changes: input.changes ?? "",
          triggerEventId: existing?.triggerEventId ?? null,
        },
      });
      toast.success(t("character:toast.phaseUpdateSuccess"));
    } catch (e) {
      toast.error(t("character:toast.phaseUpdateFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleDeletePhase(phaseId: string) {
    try {
      await deletePhaseMut.mutateAsync(phaseId as CharacterPhase["id"]);
      toast.success(t("character:toast.phaseDeleteSuccess"));
    } catch (e) {
      toast.error(t("character:toast.phaseDeleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = phases.findIndex((p) => p.id === active.id);
    const newIndex = phases.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(phases, oldIndex, newIndex);
    try {
      await reorderMut.mutateAsync({
        characterId: cid,
        phaseIds: reordered.map((p) => p.id),
      });
      toast.success(t("character:toast.reorderSuccess"));
    } catch (e) {
      toast.error(t("character:toast.reorderFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
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

  if (isError || !character) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {t("character:toast.loadFailed")}
          </p>
          <Button
            variant="outline"
            onClick={() =>
              navigate({
                to: "/world/$worldId/characters",
                params: { worldId },
              })
            }
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} data-icon="inline-start" />
            {t("character:detail.back")}
          </Button>
        </div>
      </div>
    );
  }

  const visibleTags = character.tags.slice(0, 5);
  const extraTags = character.tags.length - 5;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        {/* Back link */}
        <Button
          variant="ghost"
          className="-ml-2 mb-6"
          onClick={() =>
            navigate({
              to: "/world/$worldId/characters",
              params: { worldId },
            })
          }
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} data-icon="inline-start" />
          {t("character:detail.back")}
        </Button>

        {/* Identity header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold">
              {character.name}
            </h1>
            {character.aliases.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("character:card.aliasesLabel")}: {character.aliases.join(", ")}
              </p>
            )}
            {character.description && (
              <p className="text-sm text-muted-foreground">
                {character.description}
              </p>
            )}
            {character.tags.length > 0 && (
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditBaseOpen(true)}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} data-icon="inline-start" />
            {t("character:detail.editBase")}
          </Button>
        </div>

        <Separator className="my-6" />

        {/* Phases section */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-medium">
              {t("character:detail.phasesTitle")}
            </h2>
            {!draftActive && (
              <Button
                size="sm"
                onClick={() => setDraftActive(true)}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                {t("character:detail.addPhase")}
              </Button>
            )}
          </div>

          {phases.length === 0 && !draftActive ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon
                    icon={PencilEdit01Icon}
                    strokeWidth={2}
                  />
                </EmptyMedia>
                <EmptyTitle>
                  {t("character:detail.emptyPhasesTitle")}
                </EmptyTitle>
                <EmptyDescription>
                  {t("character:detail.emptyPhasesDescription")}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setDraftActive(true)}>
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
                  {t("character:detail.emptyPhasesCta")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={phases.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-4">
                    {phases.map((phase) => (
                      <SortablePhaseCard
                        key={phase.id}
                        phase={phase}
                        onUpdatePhase={handleUpdatePhase}
                        onDeletePhase={handleDeletePhase}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {/* Draft card (outside SortableContext, not draggable) */}
              {draftActive && (
                <PhaseCard
                  onSave={handleAddPhase}
                  onCancel={() => setDraftActive(false)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Edit base dialog */}
      <CharacterFormDialog
        key={character.id}
        mode="edit"
        open={editBaseOpen}
        onOpenChange={setEditBaseOpen}
        entity={
          character
            ? {
                id: character.id,
                name: character.name,
                aliases: character.aliases,
                description: character.description,
                notes: character.notes,
                tags: character.tags,
              }
            : undefined
        }
        onSubmit={handleUpdateBase}
      />
    </div>
  );
}

export const characterDetailRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "characters/$characterId",
  component: CharacterDetailPage,
});
