import { useEffect, useState, type FormEvent } from "react";

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
          <DialogTitle>编辑世界</DialogTitle>
          <DialogDescription>
            修改世界的名称与简介。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-world-name">名称</FieldLabel>
              <Input
                id="edit-world-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="输入世界名称"
                autoFocus
              />
              <FieldDescription>给你的世界起一个名字。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-world-desc">简介</FieldLabel>
              <Textarea
                id="edit-world-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="简要描述这个世界的核心设定与风格"
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              取消
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { EditWorldDialog };
