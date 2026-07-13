import i18n from "@/i18n";
import type { ErrorPayload } from "@/api/client";

/**
 * Translate a structured ErrorPayload into a user-facing string.
 *
 * - Known business error codes → translated via `errors:` namespace.
 * - `INTERNAL_ERROR` or unknown codes → return `payload.message` as-is
 *   (raw English from Rust; safer than showing a missing-key placeholder).
 */
export function translateError(payload: ErrorPayload): string {
  if (payload.code === "INTERNAL_ERROR" || !payload.code) {
    return payload.message;
  }
  // Resolve localized entity name for NOT_FOUND-style errors.
  const args = { ...payload.args };
  if ("entity" in args && args.entity) {
    args.entity = i18n.t(`errors:entities.${args.entity}`, {
      defaultValue: args.entity,
    });
  }
  const translated = i18n.t(`errors:${payload.code}`, {
    ...args,
    defaultValue: "",
  });
  return translated || payload.message;
}
