/**
 * Native OS notification helpers (Rust-side notify-rust — ADR-0036).
 *
 * Fire-and-forget by design: callers `void` these promises — the consent
 * gate (ADR-0025) must never block on the OS. The function is no-throw;
 * failures reject with an ErrorPayload from the `show_notification`
 * command and surface as WARN logs only.
 *
 * Strings come from the GLOBAL `i18n.t` (async non-render context — the
 * hook `t` is for JSX render bodies only, per AGENTS.md). Redaction
 * policy: only ids + tool_name are ever logged — tool input/args may
 * contain user creative content.
 */

import { call } from "@/api/client";
import i18n from "@/i18n";
import { logger } from "@/lib/logger";

/**
 * Notify the user via the OS that a tool call is awaiting consent.
 */
export async function notifyToolConsentRequested(args: {
  worldId: string;
  conversationId: string;
  toolName: string;
}): Promise<void> {
  const { worldId, conversationId, toolName } = args;
  try {
    await call("show_notification", {
      title: i18n.t("chat:notification.toolConsentTitle"),
      body: i18n.t("chat:notification.toolConsentBody", { tool: toolName }),
    });
    logger.info("notify.tool_consent.sent", {
      world_id: worldId,
      conversation_id: conversationId,
      tool_name: toolName,
    });
  } catch (e) {
    logger.warn("notify.tool_consent.failed", {
      world_id: worldId,
      conversation_id: conversationId,
      error: String(e),
    });
  }
}
