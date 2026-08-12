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
import { EntityImageField } from "@/components/entity-image-field";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserCircleIcon } from "@hugeicons/core-free-icons";
import type { UpdateCharacterInput } from "@/api";
import type { CharacterId, WorldId } from "@/types";

interface CharacterFormDialogProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Space + World scoping for the image API. Required in `edit` mode (the
   * EntityImageField needs them); ignored in `create` mode where there is
   * no entity yet to attach an image to.
   */
  spaceId: string;
  worldId: WorldId;
  entity?: {
    id: string;
    name: string;
    aliases: string[];
    description: string;
    notes: string;
    tags: string[];
  };
  onSubmit: (input: UpdateCharacterInput) => Promise<void>;
}

function CharacterFormDialog({
  mode,
  open,
  onOpenChange,
  spaceId,
  worldId,
  entity,
  onSubmit,
}: CharacterFormDialogProps) {
  const { t } = useTranslation(["character", "common"]);

  const [name, setName] = useState(entity?.name ?? "");
  const [aliases, setAliases] = useState<string[]>(entity?.aliases ?? []);
  const [description, setDescription] = useState(entity?.description ?? "");
  const [notes, setNotes] = useState(entity?.notes ?? "");
  const [tags, setTags] = useState<string[]>(entity?.tags ?? []);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setAliases([]);
    setDescription("");
    setNotes("");
    setTags([]);
  }

  useEffect(() => {
    if (entity) {
      setName(entity.name);
      setAliases(entity.aliases);
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
        aliases,
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
      ? t("character:create.title")
      : t("character:edit.title");

  const desc =
    mode === "create"
      ? t("character:create.description")
      : t("character:edit.description");

  const prefix = mode === "create" ? "create" : "edit";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (mode === "create" && !v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
          {mode === "create" && (
            <p className="text-xs text-muted-foreground">
              {t("character:create.hint")}
            </p>
          )}
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <FieldGroup className="min-h-0 flex-1 overflow-y-auto">
            {/* Image upload — edit mode only. Create mode has no id yet, so
                per the project pattern we surface the upload UI on the edit
                dialog instead of deferring bytes through the create flow. */}
            {mode === "edit" && entity && (
              <Field>
                <FieldLabel>{t("common:imageField.change")}</FieldLabel>
                <EntityImageField
                  kind="character"
                  spaceId={spaceId}
                  worldId={worldId}
                  id={entity.id as CharacterId}
                  aspect={3 / 4}
                  outputWidth={300}
                  outputHeight={400}
                  className="flex items-center gap-4"
                  avatarClassName="size-24 rounded-md"
                  fallbackIcon={
                    <HugeiconsIcon
                      icon={UserCircleIcon}
                      strokeWidth={1.5}
                      className="size-8 text-muted-foreground"
                    />
                  }
                  cropTitle={t("character:edit.title")}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`char-${prefix}-name`}>
                {t("character:form.nameLabel")}
              </FieldLabel>
              <Input
                id={`char-${prefix}-name`}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t("character:form.namePlaceholder")}
                autoFocus
              />
              <FieldDescription>
                {t("character:form.nameDescription")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>
                {t("character:form.aliasesLabel")}
              </FieldLabel>
              <TagInput
                value={aliases}
                onChange={setAliases}
                placeholder={t("character:form.aliasesPlaceholder")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`char-${prefix}-desc`}>
                {t("character:form.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id={`char-${prefix}-desc`}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("character:form.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`char-${prefix}-notes`}>
                {t("character:form.notesLabel")}
              </FieldLabel>
              <Textarea
                id={`char-${prefix}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder={t("character:form.notesPlaceholder")}
                rows={4}
              />
            </Field>
            <Field>
              <FieldLabel>{t("character:form.tagsLabel")}</FieldLabel>
              <TagInput
                value={tags}
                onChange={setTags}
                placeholder={t("character:form.tagsPlaceholder")}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4 shrink-0">
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

export { CharacterFormDialog };
