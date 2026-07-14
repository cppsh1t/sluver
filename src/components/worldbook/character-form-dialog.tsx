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
import type { UpdateCharacterInput } from "@/api";

interface CharacterFormDialogProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
          {mode === "create" && (
            <p className="text-xs text-muted-foreground">
              {t("character:create.hint")}
            </p>
          )}
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
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

export { CharacterFormDialog };
