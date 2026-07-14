import { useState } from "react";
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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Delete02Icon,
  DragDropIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  SaveIcon,
} from "@hugeicons/core-free-icons";
import type { CharacterPhase } from "@/types";
import type { CreatePhaseInput } from "@/api";

interface PhaseCardProps {
  phase?: CharacterPhase;
  isDragging?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  onSave: (input: CreatePhaseInput) => Promise<void>;
  onCancel?: () => void;
  onDelete?: () => void;
}

function PhaseCard({
  phase,
  isDragging,
  dragHandleProps,
  onSave,
  onCancel,
  onDelete,
}: PhaseCardProps) {
  const { t } = useTranslation(["character", "common"]);
  const isDraft = !phase;

  const [editing, setEditing] = useState(!phase);
  const [name, setName] = useState(phase?.name ?? "");
  const [appearance, setAppearance] = useState(phase?.appearance ?? "");
  const [changes, setChanges] = useState(phase?.changes ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  function resetToPhase() {
    if (phase) {
      setName(phase.name);
      setAppearance(phase.appearance);
      setChanges(phase.changes);
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
                  onClick={() => setConfirmOpen(true)}
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
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("character:phase.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("character:phase.deleteDescription", { name: phase!.name })}
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
