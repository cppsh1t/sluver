/**
 * Composite model-id utilities.
 *
 * Agent `modelId` follows the `"{providerId}/{modelId}"` convention (see
 * CONTEXT.md §Agent), e.g. `"anthropic/claude-sonnet-5"`. These helpers
 * split and rejoin the two parts, handling provider IDs that contain slashes
 * (e.g. `"openrouter/anthropic/claude-3.5-sonnet"` → provider `"openrouter"`,
 * model `"anthropic/claude-3.5-sonnet"`).
 *
 * Extracted from `agent-model-picker.tsx` so both the UI picker and the
 * provider factory share one implementation.
 */

/**
 * Split a composite `"{providerId}/{modelId}"` string into its parts.
 * Returns `[null, null]` when the value is null or doesn't contain a slash,
 * so an unbound or malformed agent renders as "no selection".
 *
 * Only the **first** slash is used as the delimiter — everything after it is
 * the model id, even if it contains additional slashes.
 */
export function parseModelId(
  modelId: string | null,
): [string | null, string | null] {
  if (!modelId) return [null, null];
  const slash = modelId.indexOf("/");
  if (slash === -1) return [null, null];
  return [modelId.slice(0, slash), modelId.slice(slash + 1)];
}

/**
 * Compose a `"{providerId}/{modelId}"` string from its parts.
 * Round-trips with {@link parseModelId}: `composeModelId(...parseModelId(x)) === x`
 * for any well-formed composite id.
 */
export function composeModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}
