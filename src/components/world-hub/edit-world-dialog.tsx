import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "@tanstack/react-router";
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
import { EntityImageField } from "@/components/entity-image-field";
import { HugeiconsIcon } from "@hugeicons/react";
import { Globe02Icon } from "@hugeicons/core-free-icons";
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
  // World lives in `space.db`, addressed by its own id. WorldCard does not
  // (and per the task contract must not) thread spaceId as a prop, so pull
  // it from the route. The dialog is only ever rendered under /space/$spaceId.
  const { spaceId } = useParams({ from: "/space/$spaceId" });
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
            {world && (
              <Field>
                <FieldLabel>{t("common:imageField.change")}</FieldLabel>
                <EntityImageField
                  kind="world"
                  spaceId={spaceId}
                  worldId={world.id}
                  id={world.id}
                  aspect={16 / 9}
                  outputWidth={640}
                  outputHeight={360}
                  className="flex items-center gap-4"
                  avatarClassName="size-24 rounded-md"
                  fallbackIcon={
                    <HugeiconsIcon
                      icon={Globe02Icon}
                      strokeWidth={1.5}
                      className="size-8 text-muted-foreground"
                    />
                  }
                  cropTitle={t("world:editDialog.title")}
                />
              </Field>
            )}
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
