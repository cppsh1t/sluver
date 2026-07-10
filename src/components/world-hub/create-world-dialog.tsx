import { useState, type FormEvent } from "react";

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
          <DialogTitle>新建世界</DialogTitle>
          <DialogDescription>
            创建一个新的世界观宇宙，作为你的创作工作空间。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="world-name">名称</FieldLabel>
              <Input
                id="world-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="例：九州大陆"
                autoFocus
              />
              <FieldDescription>给你的世界起一个名字。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="world-desc">简介</FieldLabel>
              <Textarea
                id="world-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="史诗奇幻世界…"
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              取消
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CreateWorldDialog };
