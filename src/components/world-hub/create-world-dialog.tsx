import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { updateWorldImage } from "@/api/image";
import { arrayBufferToBlobUrl } from "@/lib/image-bytes";
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
import { ImageCropDialog } from "@/components/ui/image-crop-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Globe02Icon,
  ImageUpload01Icon,
} from "@hugeicons/core-free-icons";
import type { CreateWorldInput } from "@/api";
import type { WorldId } from "@/types";

/**
 * Deferred-image create flow.
 *
 * World is the only entity whose create form carries an upload UI: the user
 * can pick + crop a cover before the World exists. The form stashes the
 * compressed image bytes in `pendingImage` and shows a live preview. After
 * `onCreate` returns the new World's id, the form calls `updateWorldImage`
 * and invalidates the cache.
 *
 * Failure of the image step does NOT roll back the World creation — the
 * World is already saved. We surface the failure as a toast and proceed to
 * close the dialog (the user can re-attempt from `EditWorldDialog`).
 */
interface CreateWorldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Creates the World. Returns the new World's id so the dialog can commit
   * the pending image (if any) via `updateWorldImage`. Throwing aborts the
   * flow — the dialog stays open and no image is uploaded.
   */
  onCreate: (input: CreateWorldInput) => Promise<string | void>;
}

function CreateWorldDialog({
  open,
  onOpenChange,
  onCreate,
}: CreateWorldDialogProps) {
  const { t } = useTranslation(["world", "common"]);
  const queryClient = useQueryClient();
  // SpaceHomePage renders this dialog under /space/$spaceId — pull spaceId
  // from the route so the host doesn't have to thread a new prop.
  const { spaceId } = useParams({ from: "/space/$spaceId" });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<{
    bytes: Uint8Array;
    mime: string;
  } | null>(null);

  function reset() {
    setName("");
    setDescription("");
    setPendingImage(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      const newId = await onCreate({
        name: trimmed,
        description: description.trim(),
      });
      // If the host returned the new id AND the user picked an image, commit
      // it now. Image failure is non-fatal — the World is already created.
      if (newId && pendingImage) {
        const worldId = newId as WorldId;
        try {
          await updateWorldImage(
            spaceId,
            worldId,
            pendingImage.bytes,
            pendingImage.mime,
          );
          await queryClient.invalidateQueries({
            queryKey: ["image", "world", worldId],
          });
          toast.success(i18n.t("world:toast.imageUpdated"));
        } catch (imgErr) {
          toast.error(i18n.t("world:toast.imageUpdateFailed"), {
            description: translateError(toErrorPayload(imgErr)),
          });
        }
      }
      reset();
      onOpenChange(false);
    } catch {
      // Error already handled by the caller (toast). Keep dialog open.
    } finally {
      setSubmitting(false);
    }
  }

  // The crop dialog produces bytes — stash them for the deferred commit.
  // Resolves immediately so ImageCropDialog closes on confirm.
  async function handleCropSubmit(bytes: Uint8Array, mime: string) {
    setPendingImage({ bytes, mime });
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
              <FieldLabel>{t("common:imageField.upload")}</FieldLabel>
              <PendingImagePreview
                bytes={pendingImage?.bytes}
                onPick={() => setCropOpen(true)}
                onClear={() => setPendingImage(null)}
              />
              {pendingImage && (
                <FieldDescription>
                  {t("common:imageField.pending")}
                </FieldDescription>
              )}
            </Field>
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

      <ImageCropDialog
        open={cropOpen}
        onOpenChange={setCropOpen}
        aspect={16 / 9}
        outputWidth={640}
        outputHeight={360}
        title={t("world:createDialog.title")}
        onSubmit={handleCropSubmit}
      />
    </Dialog>
  );
}

/**
 * Live preview of the user's picked (but not yet committed) cover image.
 *
 * Derives a one-shot blob URL from the bytes and revokes it on change /
 * unmount so re-picking the cover never leaks object URLs. The empty state
 * is a muted frame matching the World's 16/9 aspect, with an "Upload image"
 * button; once bytes are present we also surface "Clear selected" so the
 * user can drop the pending choice without re-opening the crop dialog.
 */
function PendingImagePreview({
  bytes,
  onPick,
  onClear,
}: {
  bytes: Uint8Array | undefined;
  onPick: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation(["common"]);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    // `arrayBufferToBlobUrl` accepts an ArrayBuffer; view the Uint8Array's
    // underlying buffer. The bytes come straight from `canvas.toBlob` so the
    // buffer is exactly sized — no detached/offset concerns.
    const next = arrayBufferToBlobUrl(bytes.buffer as ArrayBuffer);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
    };
  }, [bytes]);

  return (
    <div className="flex items-center gap-4">
      <div
        className="flex size-24 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground"
        style={{ aspectRatio: "16 / 9" }}
      >
        {url ? (
          <img src={url} alt="" className="size-full object-cover" />
        ) : (
          <HugeiconsIcon
            icon={Globe02Icon}
            strokeWidth={1.5}
            className="size-8 text-muted-foreground"
          />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onPick}>
          <HugeiconsIcon icon={ImageUpload01Icon} strokeWidth={2} data-icon="inline-start" />
          {bytes ? t("common:imageField.change") : t("common:imageField.upload")}
        </Button>
        {bytes && (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} data-icon="inline-start" />
            {t("common:imageField.pendingClear")}
          </Button>
        )}
      </div>
    </div>
  );
}

export { CreateWorldDialog };
