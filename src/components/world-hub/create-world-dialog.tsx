import { useState, type FormEvent } from "react";
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
import type { CreateWorldInput } from "@/api";

interface CreateWorldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the form values. Should throw on failure. */
  onCreate: (input: CreateWorldInput) => Promise<void>;
}

function CreateWorldDialog({
  open,
  onOpenChange,
  onCreate,
}: CreateWorldDialogProps) {
  const { t } = useTranslation(["world", "common"]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setDescription("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      await onCreate({ name: trimmed, description: description.trim() });
      reset();
      onOpenChange(false);
    } catch {
      // Error already handled by the caller (toast). Keep dialog open.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("world:createDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("world:createDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="world-name">{t("world:createDialog.nameLabel")}</FieldLabel>
              <Input
                id="world-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t("world:createDialog.namePlaceholder")}
                autoFocus
              />
              <FieldDescription>{t("world:createDialog.nameDescription")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="world-desc">{t("world:createDialog.descriptionLabel")}</FieldLabel>
              <Textarea
                id="world-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("world:createDialog.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? t("common:actions.creating") : t("common:actions.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateWorldDialog };
