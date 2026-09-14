import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { FlashIcon } from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { updateAgentConfigModel } from "@/api";
// Deep import: the hooks barrel re-exports the hooks but not the key
// factory (`aiConfigKeys`) — same precedent as `config.tsx`.
import { aiConfigKeys } from "@/hooks/use-ai-config";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type {
  AgentConfig,
  CatalogProvider,
  ProviderCredential,
  SpaceId,
} from "@/types";
import { ModelCascadingSelect } from "./model-cascading-select";

/**
 * Bulk "apply model to all unconfigured" action (ADR-0050 D7).
 *
 * Sits in the agent-config section header of the Space config page.
 * Opens the same cascading provider → model picker the per-config dialog
 * uses, then binds the chosen composite modelId to every AgentConfig
 * whose `modelId` is still `null` via one `update_agent_config_model`
 * call per config (parallel), followed by a single agent-configs cache
 * invalidation. Hidden state (nothing unconfigured) is expressed as a
 * disabled trigger so the header layout stays stable.
 */
export function AgentConfigBulkApply({
  spaceId,
  unconfigured,
  providers,
  credentials,
  disabled,
}: {
  spaceId: SpaceId;
  /** Configs with `modelId === null` — the apply target set. */
  unconfigured: AgentConfig[];
  providers: CatalogProvider[];
  credentials: ProviderCredential[];
  disabled?: boolean;
}) {
  const { t } = useTranslation(["ai", "common"]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const availableProviderIds = new Set(credentials.map((c) => c.providerId));
  // The vision role needs an image-capable model (ADR-0045) — a plain text
  // choice would silently degrade look_at, so flag it inside the dialog.
  const includesVision = unconfigured.some((c) => c.name === "vision");
  const selectionComplete = provider !== null && model !== null;

  function handleOpenChange(nextOpen: boolean) {
    // Fresh selection each time the dialog opens — a stale pick from a
    // previous round would be an easy trap to miss visually.
    if (nextOpen) {
      setProvider(null);
      setModel(null);
    }
    setOpen(nextOpen);
  }

  async function handleApply() {
    if (!selectionComplete || applying) return;
    const composite = `${provider}/${model}`;
    setApplying(true);
    try {
      // One call per unconfigured config (D7); allSettled so a single
      // rejection never discards the sibling successes.
      const results = await Promise.allSettled(
        unconfigured.map((config) =>
          updateAgentConfigModel(spaceId, config.id, composite),
        ),
      );
      await qc.invalidateQueries({
        queryKey: aiConfigKeys.agentConfigs(spaceId),
      });
      const applied = results.filter((r) => r.status === "fulfilled").length;
      if (applied === results.length) {
        toast.success(
          i18n.t("ai:agentConfigs.bulkApply.toast.success", { count: applied }),
        );
      } else {
        const firstRejection = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        toast.error(
          i18n.t("ai:agentConfigs.bulkApply.toast.partial", {
            applied,
            total: results.length,
          }),
          {
            description: firstRejection
              ? translateError(toErrorPayload(firstRejection.reason))
              : undefined,
          },
        );
      }
    } finally {
      setApplying(false);
      setOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled || unconfigured.length === 0}
          />
        }
      >
        <HugeiconsIcon icon={FlashIcon} strokeWidth={2} data-icon="inline-start" />
        {t("ai:agentConfigs.bulkApply.button")}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("ai:agentConfigs.bulkApply.dialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("ai:agentConfigs.bulkApply.dialog.description", {
              count: unconfigured.length,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <ModelCascadingSelect
            providers={providers}
            availableProviderIds={availableProviderIds}
            selectedProviderId={provider}
            selectedModelId={model}
            disabled={applying}
            onProviderChange={(nextProvider) => {
              setProvider(nextProvider);
              setModel(null);
            }}
            onModelChange={setModel}
          />
          {includesVision && (
            <p className="text-[0.6875rem] text-muted-foreground/70">
              {t("ai:agentConfigs.bulkApply.dialog.visionNote")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={applying}
              onClick={() => setOpen(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!selectionComplete || applying}
              onClick={() => void handleApply()}
            >
              {applying
                ? t("ai:agentConfigs.bulkApply.dialog.applying")
                : t("ai:agentConfigs.bulkApply.dialog.apply")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
