import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PackageAddIcon, PuzzleIcon } from "@hugeicons/core-free-icons";

import { spaceLayoutRoute } from "./_space";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { AppSidebar } from "@/components/app-sidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { formatRelativeTime } from "@/lib/format";
// Shared chunk-safe base64 encoder (single `String.fromCharCode` spread per
// 8 KB window — a naive spread of a 10 MB zip would blow V8's argument limit).
import { base64Encode } from "@/lib/image-bytes";
import {
  useDeleteSkill,
  useEnabledSkills,
  useSkills,
  useUploadSkill,
} from "@/hooks";
import type { SkillId, SkillSummary, SpaceId } from "@/types";

/**
 * Mirror of the Rust-side upload cap (ADR-0043 §1: ≤10 MiB total). Checked
 * client-side so an oversized pick fails fast with a friendly toast instead
 * of a round trip through IPC + zip parsing.
 */
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;

/**
 * Skills storage-center page (ADR-0043).
 *
 * Space-scoped import & delete surface for Anthropic-format skill packages —
 * the app is their package manager, NOT an editor (no in-app authoring).
 * Per-AgentConfig enablement lives in the agent config dialog
 * (`AgentConfigModelPicker`), not here; this page only shows a read-only
 * "enabled by" hint per skill.
 *
 * Layout mirrors the sibling `config.tsx` (own `AppSidebar` + max-w-2xl
 * column) so the Space-tier pages read as one family.
 */
function SpaceSkillsPage() {
  const { t } = useTranslation(["skills", "common", "ai"]);
  const { spaceId } = useParams({ from: "/space/$spaceId" });
  const spaceIdBranded = spaceId as SpaceId;

  const skillsQ = useSkills(spaceIdBranded);
  const uploadMut = useUploadSkill(spaceIdBranded);
  const deleteMut = useDeleteSkill(spaceIdBranded);

  // Read-only "enabled by" readout per skill. Both role queries sit under
  // the ["skills", spaceId] key namespace, so the mutations above keep
  // them fresh via prefix invalidation. The line renders only once the
  // data is in and at least one role has the skill enabled.
  const explorerEnabledQ = useEnabledSkills(spaceIdBranded, "explorer");
  const writerEnabledQ = useEnabledSkills(spaceIdBranded, "writer");
  const explorerIds = useMemo(
    () => new Set<SkillId>((explorerEnabledQ.data ?? []).map((s) => s.id)),
    [explorerEnabledQ.data],
  );
  const writerIds = useMemo(
    () => new Set<SkillId>((writerEnabledQ.data ?? []).map((s) => s.id)),
    [writerEnabledQ.data],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  // The skill pending delete-confirmation; `null` = dialog closed.
  const [pendingDelete, setPendingDelete] = useState<SkillSummary | null>(null);

  const skills = skillsQ.data ?? [];

  async function handleFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires onChange (even after a
    // rejected import — without this the input would silently swallow it).
    e.target.value = "";
    if (!file || uploadMut.isPending) return;
    if (file.size > MAX_PACKAGE_BYTES) {
      toast.error(i18n.t("skills:page.toast.tooLarge"));
      return;
    }
    try {
      const packageBase64 = base64Encode(new Uint8Array(await file.arrayBuffer()));
      const skill = await uploadMut.mutateAsync(packageBase64);
      toast.success(i18n.t("skills:page.toast.uploadSuccess", { name: skill.name }));
    } catch (err) {
      toast.error(i18n.t("skills:page.toast.uploadFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMut.mutateAsync(pendingDelete.id);
      toast.success(i18n.t("skills:page.toast.deleteSuccess"));
      setPendingDelete(null);
    } catch (err) {
      toast.error(i18n.t("skills:page.toast.deleteFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  /** Muted hint line: localized role names of the agents with this skill enabled. */
  function enabledRoles(skill: SkillSummary): string[] {
    const roles: string[] = [];
    if (explorerIds.has(skill.id))
      roles.push(t("ai:agentConfigs.name.explorer"));
    if (writerIds.has(skill.id)) roles.push(t("ai:agentConfigs.name.writer"));
    return roles;
  }

  return (
    <>
      <AppSidebar />
      <main className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
          <header className="mb-8">
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t("skills:page.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("skills:page.subtitle")}
            </p>
          </header>

          <section className="flex flex-col gap-3 border-y border-border py-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <h2 className="font-heading text-sm font-medium tracking-tight">
                  {t("skills:page.section.title")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("skills:page.section.description")}
                </p>
              </div>
              {/* Hidden file input — the visible button proxies the click so
                  the pick → validate → base64 → upload flow stays one gesture. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => void handleFileChosen(e)}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMut.isPending}
              >
                <HugeiconsIcon
                  icon={PackageAddIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                {uploadMut.isPending
                  ? t("skills:page.uploading")
                  : t("skills:page.upload")}
              </Button>
            </div>

            {skillsQ.isLoading ? (
              <p className="py-4 text-center text-xs/relaxed text-muted-foreground">
                {t("skills:page.loading")}
              </p>
            ) : skillsQ.isError ? (
              <p className="py-4 text-center text-xs/relaxed text-destructive">
                {t("skills:page.loadFailed")}
              </p>
            ) : skills.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={PuzzleIcon} strokeWidth={2} />
                  </EmptyMedia>
                  <EmptyTitle>{t("skills:page.empty.title")}</EmptyTitle>
                  <EmptyDescription>
                    {t("skills:page.empty.description")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {skills.map((skill) => {
                  const roles = enabledRoles(skill);
                  return (
                    <div
                      key={skill.id}
                      className="flex items-start justify-between gap-4 py-3.5"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 items-baseline gap-2">
                          {/* `name` is a lowercase-hyphen slug — code font. */}
                          <span className="truncate font-mono text-sm font-medium">
                            {skill.name}
                          </span>
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground/70">
                            {formatRelativeTime(skill.createdAt)}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {skill.description}
                        </p>
                        {roles.length > 0 && (
                          <p className="text-[0.6875rem] text-muted-foreground/70">
                            {t("skills:page.enabledBy", {
                              agents: roles.join(" · "),
                            })}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={t("common:actions.delete")}
                        disabled={deleteMut.isPending}
                        onClick={() => setPendingDelete(skill)}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Delete confirmation — destructive, name interpolated. preventDefault
          keeps the dialog open while the mutation runs so a failure isn't
          silently swallowed by an instant close. */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next && !deleteMut.isPending) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("skills:page.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t("skills:page.delete.description", {
                    name: pendingDelete.name,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmDelete();
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const spaceSkillsRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "skills",
  component: SpaceSkillsPage,
});
