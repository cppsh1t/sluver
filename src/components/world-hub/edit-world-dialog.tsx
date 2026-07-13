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
import type { UpdateWorldInput } from "@/api";
import type { World } from "@/types";

interface EditWorldDialogProps {
  world: World | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the form values. Should throw on failure. */
  onUpdate: (input: UpdateWorldInput) => Promise<void>;
}

function EditWorldDialog({
  world,
  open,
  onOpenChange,
  onUpdate,
}: EditWorldDialogProps) {
  const { t } = useTranslation(["world", "common"]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sync form fields whenever the target world changes.
  useEffect(() => {
    if (world) {
      setName(world.name);
      setDescription(world.description);
    }
  }, [world]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !world || submitting) return;

    try {
      setSubmitting(true);
      await onUpdate({ name: trimmed, description: description.trim() });
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
      onOpenChange={onOpenChange}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("world:editDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("world:editDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-world-name">{t("world:editDialog.nameLabel")}</FieldLabel>
              <Input
                id="edit-world-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t("world:editDialog.namePlaceholder")}
                autoFocus
              />
              <FieldDescription>{t("world:editDialog.nameDescription")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-world-desc">{t("world:editDialog.descriptionLabel")}</FieldLabel>
              <Textarea
                id="edit-world-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder={t("world:editDialog.descriptionPlaceholder")}
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? t("common:actions.saving") : t("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { EditWorldDialog };
