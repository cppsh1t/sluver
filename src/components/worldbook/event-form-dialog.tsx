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

/** Convert an ISO 8601 string to the value format expected by `<input type="datetime-local">`. */
function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert a datetime-local input value back to an ISO 8601 string (`null` when empty). */
function fromDatetimeLocal(local: string): string | null {
  return local ? new Date(local).toISOString() : null;
}

interface EventFormDialogProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity?: {
    name: string;
    description: string;
    notes: string;
    tags: string[];
    startAt: string | null;
    endAt: string | null;
  };
  onSubmit: (input: {
    name: string;
    description: string;
    notes: string;
    tags: string[];
    startAt: string | null;
    endAt: string | null;
  }) => Promise<void>;
}

function EventFormDialog({
  mode,
  open,
  onOpenChange,
  entity,
  onSubmit,
}: EventFormDialogProps) {
  const { t } = useTranslation(["event", "common"]);
  const entityName = t("event:entityName.singular");

  const [name, setName] = useState(entity?.name ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [notes, setNotes] = useState(entity?.notes ?? "");
  const [tags, setTags] = useState<string[]>(entity?.tags ?? []);
  const [startAt, setStartAt] = useState(toDatetimeLocal(entity?.startAt ?? null));
  const [endAt, setEndAt] = useState(toDatetimeLocal(entity?.endAt ?? null));
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setDescription("");
    setNotes("");
    setTags([]);
    setStartAt("");
    setEndAt("");
  }

  // Re-seed from entity only on the closed→open transition.
  // The parent passes `entity` as an inline object literal (new reference each
  // render), so depending on it directly would clobber in-progress edits on any
  // parent re-render. The prevOpen guard makes the effect body a no-op while
  // the dialog stays open.
  const prevOpen = useRef(open);
  useEffect(() => {
    if (!prevOpen.current && open && entity) {
      setName(entity.name);
      setDescription(entity.description);
      setNotes(entity.notes);
      setTags(entity.tags);
      setStartAt(toDatetimeLocal(entity.startAt));
      setEndAt(toDatetimeLocal(entity.endAt));
    }
    prevOpen.current = open;
  }, [open, entity]);

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
        startAt: fromDatetimeLocal(startAt),
        endAt: fromDatetimeLocal(endAt),
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
      ? t("event:form.createTitle", { entity: entityName })
      : t("event:form.editTitle", { entity: entityName });

  const desc =
    mode === "create"
      ? t("event:form.createDescription")
      : t("event:form.editDescription");

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
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`evt-${prefix}-name`}>
                {t("event:form.nameLabel")}
              </FieldLabel>
              <Input
                id={`evt-${prefix}-name`}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t("event:form.namePlaceholder")}
                autoFocus
              />
              <FieldDescription>
                {t("event:form.nameDescription")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`evt-${prefix}-desc`}>
                {t("event:form.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id={`evt-${prefix}-desc`}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("event:form.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`evt-${prefix}-notes`}>
                {t("event:form.notesLabel")}
              </FieldLabel>
              <Textarea
                id={`evt-${prefix}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder={t("event:form.notesPlaceholder")}
                rows={4}
              />
            </Field>
            <Field>
              <FieldLabel>{t("event:form.tagsLabel")}</FieldLabel>
              <TagInput
                value={tags}
                onChange={setTags}
                placeholder={t("event:form.tagsPlaceholder")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`evt-${prefix}-start`}>
                {t("event:form.startAtLabel")}
              </FieldLabel>
              <Input
                id={`evt-${prefix}-start`}
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`evt-${prefix}-end`}>
                {t("event:form.endAtLabel")}
              </FieldLabel>
              <Input
                id={`evt-${prefix}-end`}
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.currentTarget.value)}
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

export { EventFormDialog };
