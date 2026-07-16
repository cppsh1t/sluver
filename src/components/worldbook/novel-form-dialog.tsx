import { useEffect, useRef, useState, type FormEvent } from "react";
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

interface NovelFormDialogProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity?: {
    title: string;
    description: string;
    tags: string[];
  };
  onSubmit: (input: {
    title: string;
    description: string;
    tags: string[];
  }) => Promise<void>;
}

function NovelFormDialog({
  mode,
  open,
  onOpenChange,
  entity,
  onSubmit,
}: NovelFormDialogProps) {
  const { t } = useTranslation(["novel", "common"]);
  const entityName = t("novel:entityName.singular");

  const [title, setTitle] = useState(entity?.title ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [tags, setTags] = useState<string[]>(entity?.tags ?? []);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTitle("");
    setDescription("");
    setTags([]);
  }

  const prevOpen = useRef(open);
  useEffect(() => {
    if (!prevOpen.current && open && entity) {
      setTitle(entity.title);
      setDescription(entity.description);
      setTags(entity.tags);
    }
    prevOpen.current = open;
  }, [open, entity]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      await onSubmit({
        title: trimmed,
        description: description.trim(),
        tags,
      });
      if (mode === "create") reset();
      onOpenChange(false);
    } catch {
      // Error already handled by the caller (toast).
    } finally {
      setSubmitting(false);
    }
  }

  const dialogTitle =
    mode === "create"
      ? t("novel:form.createTitle", { entity: entityName })
      : t("novel:form.editTitle", { entity: entityName });

  const dialogDesc =
    mode === "create"
      ? t("novel:form.createDescription")
      : t("novel:form.editDescription");

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
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDesc}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`novel-${prefix}-title`}>
                {t("novel:form.titleLabel")}
              </FieldLabel>
              <Input
                id={`novel-${prefix}-title`}
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                placeholder={t("novel:form.titlePlaceholder")}
                autoFocus
              />
              <FieldDescription>
                {t("novel:form.titleDescription")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`novel-${prefix}-desc`}>
                {t("novel:form.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id={`novel-${prefix}-desc`}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("novel:form.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
            <Field>
              <FieldLabel>{t("novel:form.tagsLabel")}</FieldLabel>
              <TagInput
                value={tags}
                onChange={setTags}
                placeholder={t("novel:form.tagsPlaceholder")}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button type="submit" disabled={!title.trim() || submitting}>
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

export { NovelFormDialog };
