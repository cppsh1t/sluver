import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TagInput } from "@/components/ui/tag-input";
import { EntityImageField, type EntityImageId } from "@/components/entity-image-field";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  InformationSquareIcon,
  Location01Icon,
  ShoppingBagIcon,
} from "@hugeicons/core-free-icons";
import type { EntityKind } from "@/components/ui/entity-avatar";
import type { UpdateElementInput } from "@/api";
import type { WorldId } from "@/types";

/**
 * Per-entity crop spec. Mirrors the project's per-kind cover contract: the
 * crop aspect and the export dimensions are paired so a freshly-uploaded
 * image exactly fills the EntityAvatar frame without distortion.
 */
const ELEMENT_CROP_SPEC: Record<
  Exclude<EntityKind, "world" | "character" | "phase" | "event" | "novel">,
  { aspect: number; outputWidth: number; outputHeight: number }
> = {
  location: { aspect: 4 / 3, outputWidth: 400, outputHeight: 300 },
  item: { aspect: 1, outputWidth: 256, outputHeight: 256 },
  lore: { aspect: 1, outputWidth: 256, outputHeight: 256 },
};

function elementFallbackIcon(entityType: "location" | "item" | "lore") {
  switch (entityType) {
    case "location":
      return (
        <HugeiconsIcon
          icon={Location01Icon}
          strokeWidth={1.5}
          className="size-8 text-muted-foreground"
        />
      );
    case "item":
      return (
        <HugeiconsIcon
          icon={ShoppingBagIcon}
          strokeWidth={1.5}
          className="size-8 text-muted-foreground"
        />
      );
    case "lore":
      return (
        <HugeiconsIcon
          icon={InformationSquareIcon}
          strokeWidth={1.5}
          className="size-8 text-muted-foreground"
        />
      );
  }
}

interface ElementFormDialogProps {
  entityType: "location" | "item" | "lore";
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Space + World scoping for the image API. Required in `edit` mode; ignored
   * in `create` mode (no entity id yet to attach an image to).
   */
  spaceId: string;
  worldId: WorldId;
  entity?: {
    id: string;
    name: string;
    description: string;
    notes: string;
    tags: string[];
  };
  onSubmit: (input: UpdateElementInput) => Promise<void>;
}

function ElementFormDialog({
  entityType,
  mode,
  open,
  onOpenChange,
  spaceId,
  worldId,
  entity,
  onSubmit,
}: ElementFormDialogProps) {
  const { t } = useTranslation(["worldbook", "common"]);
  const entityName = t(`worldbook:entityName.${entityType}.singular`);

  const [name, setName] = useState(entity?.name ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [notes, setNotes] = useState(entity?.notes ?? "");
  const [tags, setTags] = useState<string[]>(entity?.tags ?? []);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setDescription("");
    setNotes("");
    setTags([]);
  }

  useEffect(() => {
    if (entity) {
      setName(entity.name);
      setDescription(entity.description);
      setNotes(entity.notes);
      setTags(entity.tags);
    }
  }, [entity]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      await onSubmit({
        name: trimmed,
        description: description.trim(),
        notes: notes.trim(),
        tags,
      });
      if (mode === "create") reset();
      onOpenChange(false);
    } catch {
      // Error already handled by the caller (toast). Keep dialog open.
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    mode === "create"
      ? t("worldbook:form.createTitle", { entity: entityName })
      : t("worldbook:form.editTitle", { entity: entityName });

  const desc =
    mode === "create"
      ? t("worldbook:form.createDescription", { entity: entityName })
      : t("worldbook:form.editDescription", { entity: entityName });

  const prefix = mode === "create" ? "create" : "edit";
  const cropSpec = ELEMENT_CROP_SPEC[entityType];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (mode === "create" && !v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            {/* Image upload — edit mode only. Per the project pattern, the
                create flow does NOT carry image bytes (no id yet); users add
                the image from the edit dialog after the entity exists. */}
            {mode === "edit" && entity && (
              <Field>
                <FieldLabel>{t("common:imageField.change")}</FieldLabel>
                <EntityImageField
                  kind={entityType as EntityKind}
                  spaceId={spaceId}
                  worldId={worldId}
                  id={entity.id as EntityImageId}
                  aspect={cropSpec.aspect}
                  outputWidth={cropSpec.outputWidth}
                  outputHeight={cropSpec.outputHeight}
                  className="flex items-center gap-4"
                  avatarClassName="size-24 rounded-md"
                  fallbackIcon={elementFallbackIcon(entityType)}
                  cropTitle={t("worldbook:form.editTitle", { entity: entityName })}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`wb-${prefix}-name`}>
                {t("worldbook:form.nameLabel")}
              </FieldLabel>
              <Input
                id={`wb-${prefix}-name`}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t("worldbook:form.namePlaceholder")}
                autoFocus
              />
              <FieldDescription>
                {t("worldbook:form.nameDescription")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`wb-${prefix}-desc`}>
                {t("worldbook:form.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id={`wb-${prefix}-desc`}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("worldbook:form.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`wb-${prefix}-notes`}>
                {t("worldbook:form.notesLabel")}
              </FieldLabel>
              <Textarea
                id={`wb-${prefix}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder={t("worldbook:form.notesPlaceholder")}
                rows={4}
              />
            </Field>
            <Field>
              <FieldLabel>{t("worldbook:form.tagsLabel")}</FieldLabel>
              <TagInput
                value={tags}
                onChange={setTags}
                placeholder={t("worldbook:form.tagsPlaceholder")}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting
                ? t(`common:actions.${mode === "create" ? "creating" : "saving"}`)
                : t(`common:actions.${mode === "create" ? "create" : "save"}`)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { ElementFormDialog };
