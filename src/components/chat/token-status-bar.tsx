/**
 * TokenStatusBar — a thin, always-mounted (when there is data) context-
 * occupancy readout that sits directly above the Composer.
 *
 * Shows the current context-window occupancy for the resolved model, so the
 * user can see how much room is left BEFORE sending (ADR-0030 §6 — the "C1"
 * indicator).
 *
 * Shape: `上下文 47.2k / 200k (24%)`
 * - Numerator: `view.lastStepInputTokens` — the LAST completed step's input
 *   token count, i.e. the live context size. Distinct from
 *   `lastTurnUsage.inputTokens` (summed across steps, ~N× this on multi-step
 *   turns) and from `messageUsages[*].inputTokens` (same cost-view sum,
 *   persisted) — both are the WRONG number for occupancy (ADR-0030 §6).
 * - Denominator: the resolved model's `contextWindow` from the models.dev
 *   catalog. Omitted entirely when the catalog reports no limit (`null`,
 *   common for self-hosted OpenAI-compatible providers) or before the catalog
 *   resolves — then the bar degrades to just `上下文 47.2k`.
 *
 * Visibility: hidden until the first turn finalizes (no `lastTurnUsage` on
 * fresh load / between turns / while streaming). The bar reappears once a
 * turn's usage lands — which is exactly the "about to send again" moment.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useAgentConfigs, useModelsDevCatalog } from "@/hooks";
import { useConversationView } from "@/lib/conversation-runtime";
import { parseModelId } from "@/lib/ai";
import { formatTokenCount } from "@/lib/format";
import type { ConversationId, SpaceId, WorldId } from "@/types";

interface TokenStatusBarProps {
  readonly spaceId: SpaceId;
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  readonly agentConfigName: string;
}

/**
 * Resolve the context window (in tokens) for the model bound to an agent
 * config. Joins the Space's agent config (`modelId` → provider/model split)
 * with the models.dev catalog.
 *
 * @returns `number` when the catalog reports a limit; `null` when the
 *   provider/model is known but upstream omits `limit` (e.g. self-hosted
 *   OpenAI-compatible); `undefined` while the config or catalog is still
 *   loading, or when the role has no model bound.
 */
function useContextWindow(
  spaceId: SpaceId,
  agentConfigName: string,
): number | null | undefined {
  const agentConfigs = useAgentConfigs(spaceId);
  const catalog = useModelsDevCatalog();

  return useMemo(() => {
    // Loading ⇒ `undefined` (don't yet know whether a limit exists).
    if (agentConfigs.isLoading || catalog.isLoading) return undefined;
    const agentConfig = agentConfigs.data?.find(
      (a) => a.name === agentConfigName,
    );
    const [providerId, modelId] = parseModelId(agentConfig?.modelId ?? null);
    if (!providerId || !modelId) return undefined;
    const model = catalog.data?.providers
      .find((p) => p.id === providerId)
      ?.models.find((m) => m.id === modelId);
    // `model?.contextWindow` is `number | null | undefined`. If the model row
    // exists, `null` means "upstream omitted limit" (known-no-limit); if the
    // row is absent, fall back to `null` too — either way we omit the
    // denominator.
    return model?.contextWindow ?? null;
  }, [
    agentConfigs.data,
    agentConfigs.isLoading,
    catalog.data,
    catalog.isLoading,
    agentConfigName,
  ]);
}

export function TokenStatusBar({
  spaceId,
  worldId,
  conversationId,
  agentConfigName,
}: TokenStatusBarProps) {
  const { t } = useTranslation("chat");
  const { view } = useConversationView(worldId, conversationId);
  const contextWindow = useContextWindow(spaceId, agentConfigName);

  // C1 numerator (ADR-0030 §6): the last step's inputTokens = current context
  // size. NOT lastTurnUsage.inputTokens (that sums across steps — cost view).
  const inputTokens = view.lastStepInputTokens;
  if (inputTokens === undefined) return null;

  // Narrow the denominator: only a real positive number is displayable.
  // `null` (known no-limit) and `undefined` (loading) both degrade to the
  // numerator-only form.
  const window =
    typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : null;

  const numerator = formatTokenCount(inputTokens);

  return (
    <div className="bg-background/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-1 text-[0.6875rem] tabular-nums text-muted-foreground/60">
        <span>{t("chat:token.context")}</span>
        <span className="ml-1.5 font-medium text-muted-foreground/80">
          {numerator}
        </span>
        {window !== null && (
          <>
            <span className="mx-1 text-muted-foreground/40">/</span>
            <span>{formatTokenCount(window)}</span>
            <span className="ml-1.5 text-muted-foreground/50">
              ({Math.round((inputTokens / window) * 100)}%)
            </span>
          </>
        )}
      </div>
    </div>
  );
}
