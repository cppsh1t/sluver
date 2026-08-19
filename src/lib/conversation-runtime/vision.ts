/**
 * Vision capability resolution (ADR-0044 §D9 step 2) — pure join of an
 * AgentConfig's composite `modelId` with the models.dev catalog's
 * `inputModalities` array.
 *
 * Lives in the app layer (NOT `src/lib/ai/`) on purpose: the pure library
 * must stay free of IPC/React/catalog concerns (ADR-0019). The Provider
 * captures the react-query data and closes over this helper to build the
 * per-role {@link ./store.ImageInputSupportedResolver} forwarded into each
 * `send`.
 */

import { parseModelId } from "@/lib/ai";
import type { ModelsDevCatalog } from "@/types";

/**
 * Whether the model identified by `modelId` (`"{providerId}/{modelId}"`)
 * accepts image input, per the catalog.
 *
 * Semantics (plan D9 — tri-state, NEVER defaults missing info to `false`):
 * - `true` / `false` — the catalog entry EXISTS and carries
 *   `inputModalities`; the flag is `includes("image")`.
 * - `undefined` — unknown: no catalog (still loading / fetch failed), no
 *   model chosen, an unparseable id, no catalog entry for the
 *   provider/model, or the entry omits `inputModalities` (custom/unknown
 *   models). Callers pass image parts through unchanged in this state — a
 *   custom OpenAI-compatible vision setup is a deliberate configuration
 *   and a provider error is more informative than silent degradation.
 */
export function imageInputSupportedForModel(
  catalog: ModelsDevCatalog | undefined,
  modelId: string | null,
): boolean | undefined {
  if (!modelId || !catalog) return undefined;
  const [providerId, bareModelId] = parseModelId(modelId);
  if (!providerId || !bareModelId) return undefined;
  const inputModalities = catalog.providers
    .find((p) => p.id === providerId)
    ?.models.find((m) => m.id === bareModelId)?.inputModalities;
  if (!inputModalities) return undefined;
  return inputModalities.includes("image");
}
