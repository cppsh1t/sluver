import { useEffect, useState, type FormEvent } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, LockKeyIcon } from "@hugeicons/core-free-icons";

import { spaceLayoutRoute } from "./_space";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { AppSidebar } from "@/components/app-sidebar";
import {
  DeleteSpaceDialog,
  SpacePasswordDialog,
} from "@/components/space-management";
import { AgentModelPicker } from "@/components/ai/agent-model-picker";
import { CatalogStatusBanner } from "@/components/ai/catalog-status-banner";
import { ProviderCombobox } from "@/components/ai/provider-combobox";
import { ProviderCredentialList } from "@/components/ai/provider-credential-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useAgents,
  useModelsDevCatalog,
  useProviderCredentials,
  useSpaces,
  useUpdateSpace,
} from "@/hooks";
import type { SpaceId } from "@/types";

// Stable error code from the Rust backend (db/error.rs `to_payload`).
const SPACE_NAME_TAKEN = "SPACE_NAME_TAKEN";

/**
 * Space 配置 page — the Space-scoped control surface (ADR-0009 amendment).
 *
 * Hosts the Space management affordances that previously cluttered the
 * sidebar (Manage Space dropdown): identity (rename), password lifecycle,
 * and the danger zone (delete). Global Settings (theme/language) stay on
 * the landing-tier `/settings` page — per CONTEXT.md, `config` is the
 * Space-level term and is deliberately separate from global `Settings`.
 *
 * Renders its own `<AppSidebar />` (the 3-item 世界/配置/资料库 nav) to match
 * the space-home and space-library siblings; `_space.tsx` is a passthrough.
 */
function SpaceConfigPage() {
  const { t } = useTranslation(["space", "common", "ai"]);
  const { spaceId } = useParams({ from: "/space/$spaceId" });
  const spacesQ = useSpaces();
  const updateSpace = useUpdateSpace();

  // AI config data (ADR-0012: Space-scoped). The catalog is global — the
  // same query is shared across Spaces and pre-warmed at bootstrap.
  const catalogQ = useModelsDevCatalog();
  const providersQ = useProviderCredentials(spaceId as SpaceId);
  const agentsQ = useAgents(spaceId as SpaceId);

  const space = spacesQ.data?.find((s) => s.id === (spaceId as SpaceId));
  const spaceName = space?.name;

  const [name, setName] = useState(spaceName ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Catalog readiness gate: provider/model controls stay disabled until the
  // catalog data is available (loading or error). Agents without a provider
  // list can't make a meaningful selection.
  const catalogReady = catalogQ.data !== undefined;
  const catalogProviders = catalogQ.data?.providers ?? [];
  const existingProviderIds = new Set(
    (providersQ.data ?? []).map((c) => c.providerId),
  );

  // Sync the local input when the Space summary first loads or its name
  // changes server-side (e.g. after a successful rename refetch). Deps are
  // the primitive name string so this never fights the user mid-keystroke.
  useEffect(() => {
    if (spaceName !== undefined) setName(spaceName);
  }, [spaceName]);

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || updateSpace.isPending) return;
    setNameError(null);
    try {
      await updateSpace.mutateAsync({
        id: spaceId as SpaceId,
        input: { name: trimmed },
      });
      toast.success(i18n.t("space:toast.updateSuccess"));
    } catch (err) {
      const payload = toErrorPayload(err);
      if (payload.code === SPACE_NAME_TAKEN) {
        setNameError(i18n.t("space:errors.nameTaken"));
      } else {
        toast.error(i18n.t("space:toast.updateFailed"), {
          description: translateError(payload),
        });
      }
    }
  }

  const renameDirty = name.trim() !== (spaceName ?? "") && name.trim().length > 0;

  return (
    <>
      <AppSidebar />
      <main className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-10">
          <header className="mb-8">
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {spaceName ?? t("space:config.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("space:config.subtitle")}
            </p>
          </header>

          <section className="flex flex-col divide-y divide-border border-y border-border">
            {/* Identity — rename */}
            <form onSubmit={handleRename}>
              <ConfigRow
                title={t("space:config.name.title")}
                description={t("space:config.name.description")}
              >
                <div className="flex flex-col items-end gap-2">
                  <div className="flex gap-2">
                    <Input
                      value={name}
                      onChange={(e) => {
                        setName(e.currentTarget.value);
                        setNameError(null);
                      }}
                      placeholder={t("space:config.name.placeholder")}
                      className="w-56"
                      aria-invalid={!!nameError}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={!renameDirty || updateSpace.isPending}
                    >
                      {updateSpace.isPending
                        ? t("space:config.name.saving")
                        : t("space:config.name.save")}
                    </Button>
                  </div>
                  {nameError && (
                    <p className="text-xs text-destructive">{nameError}</p>
                  )}
                </div>
              </ConfigRow>
            </form>

            {/* Security — password lifecycle */}
            <ConfigRow
              title={t("space:config.password.title")}
              description={
                space?.hasPassword
                  ? t("space:config.password.descriptionSet")
                  : t("space:config.password.descriptionUnset")
              }
            >
              <Button
                variant="outline"
                onClick={() => setPwOpen(true)}
                disabled={!space}
              >
                <HugeiconsIcon
                  icon={LockKeyIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                {t("space:config.password.manage")}
              </Button>
            </ConfigRow>

            {/* Danger zone — delete */}
            <ConfigRow
              title={t("space:config.danger.title")}
              description={t("space:config.danger.description")}
              tone="danger"
            >
              <Button
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={!space}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                {t("space:config.danger.button")}
              </Button>
            </ConfigRow>
          </section>

          {/* ─── AI Providers ─────────────────────────────────────────── */}
          <section className="mt-8 flex flex-col gap-3 border-y border-border py-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <h2 className="font-heading text-sm font-medium tracking-tight">
                  {t("ai:providers.title")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("ai:providers.description")}
                </p>
              </div>
              <ProviderCombobox
                spaceId={spaceId as SpaceId}
                catalogProviders={catalogProviders}
                existingProviderIds={existingProviderIds}
                disabled={!catalogReady}
              />
            </div>

            {/* Stale catalog warning — only when the last fetch failed and
                a cached copy was served instead. */}
            {catalogQ.data?.isStale && (
              <CatalogStatusBanner fetchedAt={catalogQ.data.fetchedAt} />
            )}

            {/* Loading / error states before the list is ready. */}
            {catalogQ.isLoading ? (
              <p className="py-4 text-center text-xs/relaxed text-muted-foreground">
                {t("ai:catalog.loading")}
              </p>
            ) : catalogQ.isError ? (
              <p className="py-4 text-center text-xs/relaxed text-destructive">
                {t("ai:catalog.error")}
              </p>
            ) : (
              <ProviderCredentialList
                spaceId={spaceId as SpaceId}
                credentials={providersQ.data ?? []}
                catalogProviders={catalogProviders}
                agents={agentsQ.data ?? []}
              />
            )}
          </section>

          {/* ─── Agent Models ─────────────────────────────────────────── */}
          <section className="flex flex-col divide-y divide-border border-b border-border">
            <div className="flex flex-col gap-0.5 pb-3">
              <h2 className="font-heading text-sm font-medium tracking-tight">
                {t("ai:agents.title")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("ai:agents.description")}
              </p>
            </div>
            {(agentsQ.data ?? []).map((agent) => (
              <AgentModelPicker
                key={agent.id}
                spaceId={spaceId as SpaceId}
                agent={agent}
                providers={catalogProviders}
                credentials={providersQ.data ?? []}
                disabled={!catalogReady}
              />
            ))}
          </section>
        </div>
      </main>

      {space && (
        <>
          <SpacePasswordDialog
            open={pwOpen}
            onOpenChange={setPwOpen}
            space={space}
          />
          <DeleteSpaceDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            space={space}
          />
        </>
      )}
    </>
  );
}

interface ConfigRowProps {
  title: string;
  description: string;
  children: React.ReactNode;
  tone?: "default" | "danger";
}

function ConfigRow({ title, description, children, tone = "default" }: ConfigRowProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-6 py-5",
        tone === "danger" && "bg-destructive/5 -mx-3 rounded-md px-3",
      )}
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

export const spaceConfigRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "config",
  component: SpaceConfigPage,
});
