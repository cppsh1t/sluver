import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import i18n from "@/i18n";
import { exportNovel, type ExportFormat } from "@/api";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import type { NovelId, WorldId } from "@/types";
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

interface ExportNovelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  novel: { id: NovelId; title: string };
  spaceId: string;
  worldId: WorldId;
}

interface FormatOption {
  value: ExportFormat;
  /** Filter `name` shown in the native save dialog. */
  filterName: string;
  /** File extension WITHOUT leading dot. */
  ext: string;
}

const FORMAT_OPTIONS: FormatOption[] = [
  { value: "epub", filterName: "EPUB", ext: "epub" },
  { value: "txt", filterName: "Plain Text", ext: "txt" },
];

/**
 * Strip characters that are illegal in Windows filenames, replacing them
 * with `_`. Also collapses a resulting empty/whitespace-only name to
 * `"world"` (or the provided `fallback`) so `save()` always gets a sane
 * default filename.
 *
 * Shared by the novel export dialog and the world export flow on
 * WorldCard. Exported so both call sites use the same sanitization.
 */
export function sanitizeFilename(title: string, fallback = "world"): string {
  const cleaned = title.replace(/[<>:"/\\|?*]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Export a novel to EPUB or TXT via a native save dialog.
 *
 * Mirrors the `exportLogs` flow in `settings-dialog.tsx`:
 *  1. Pop a native `save()` dialog (file picker, not directory).
 *  2. `null` return = user cancelled — silent, no toast, dialog stays open.
 *  3. On success: toast + `logger.info` (snake_case fields per ADR-0016,
 *     NO creative content like title) + close.
 *  4. On error: toast with translated description, dialog stays open for retry.
 *
 * Called directly (no `useMutation` hook) — export is side-effect-free on
 * the data layer, so there is no query cache to invalidate, matching the
 * `exportLogs` precedent.
 *
 * Async/i18n rule (AGENTS.md): the global `i18n.t(...)` is used inside the
 * async confirm handler; the hook `t(...)` is used only in JSX render body.
 */
function ExportNovelDialog({
  open,
  onOpenChange,
  novel,
  spaceId,
  worldId,
}: ExportNovelDialogProps) {
  const { t } = useTranslation(["novel", "common"]);
  const [format, setFormat] = useState<ExportFormat>("epub");
  const [exporting, setExporting] = useState(false);

  async function handleConfirm() {
    const option = FORMAT_OPTIONS.find((o) => o.value === format)!;
    const baseName = sanitizeFilename(novel.title, "novel");

    const outputPath = await save({
      defaultPath: `${baseName}.${option.ext}`,
      filters: [{ name: option.filterName, extensions: [option.ext] }],
    });
    // `null` = dismissed; anything that isn't a string path = cancel.
    // Silent — keep the dialog open so the user can retry or change format.
    if (typeof outputPath !== "string") return;

    setExporting(true);
    try {
      await exportNovel({
        spaceId,
        worldId,
        novelId: novel.id,
        format,
        outputPath,
      });
      // snake_case fields per ADR-0016. Do NOT log title (creative content,
      // TRACE-only) — only metadata that's safe at INFO.
      logger.info("novel.exported", {
        novel_id: novel.id,
        format,
        extension: option.ext,
      });
      toast.success(i18n.t("novel:export.toast.success"));
      onOpenChange(false);
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(i18n.t("novel:export.toast.failed"), {
        description: translateError(payload),
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Ignore close attempts while an export is mid-flight — the native
        // save dialog already returned, so a half-finished write shouldn't
        // be interrupted by an ESC / overlay click.
        if (exporting && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("novel:export.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("novel:export.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("novel:export.dialogTitle")}>
          {FORMAT_OPTIONS.map((option, index) => {
            const active = option.value === format;
            const labelKey =
              option.value === "epub"
                ? "novel:export.formatEpub"
                : "novel:export.formatTxt";
            const descKey =
              option.value === "epub"
                ? "novel:export.formatEpubDescription"
                : "novel:export.formatTxtDescription";
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={exporting}
                onClick={() => setFormat(option.value)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-xs outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring/30",
                  "disabled:pointer-events-none disabled:opacity-50",
                  index > 0 && "-mt-px",
                  active
                    ? "border-border bg-muted text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    active
                      ? "border-foreground"
                      : "border-muted-foreground/40",
                  )}
                >
                  {active && (
                    <span className="size-1.5 rounded-full bg-foreground" />
                  )}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(labelKey)}</span>
                  <span className="text-muted-foreground">{t(descKey)}</span>
                </span>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>
            {t("novel:export.cancel")}
          </DialogClose>
          <Button onClick={handleConfirm} disabled={exporting}>
            {exporting ? t("novel:export.exporting") : t("novel:export.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ExportNovelDialog };
