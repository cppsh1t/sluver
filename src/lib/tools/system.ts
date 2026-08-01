/**
 * System tools — time and other non-domain utilities.
 *
 * Consent level: `auto` (read-only, no side effects).
 */

import { z } from "zod";

import { timemapperTools } from "./timemapper";
import type { ToolDef } from "./types";

/** All system-level tools, keyed by `snake_case` name. */
export function systemTools(): Record<string, ToolDef> {
  return {
    ...timemapperTools(),
    get_current_time: {
      description:
        "Get the current date and time. Use when the user asks what time it is, or needs a timestamp.",
      inputSchema: z.object({
        timezone: z
          .string()
          .optional()
          .describe(
            "Optional IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York'). Omit for the system default.",
          ),
      }),
      consentLevel: "auto",
      execute: async (input) => {
        const { timezone } = input as { timezone?: string };
        const now = new Date();
        const options: Intl.DateTimeFormatOptions = {
          dateStyle: "full",
          timeStyle: "long",
          ...(timezone ? { timeZone: timezone } : {}),
        };
        const formatted = new Intl.DateTimeFormat(undefined, options).format(now);
        return { iso: now.toISOString(), formatted };
      },
    },
  };
}
