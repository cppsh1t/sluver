/**
 * TimeMapper tools — World custom-time formatting.
 *
 * Wraps the parallel TimeMapper runtime (ADR-0026) as a single `format_time`
 * tool. Consent level: `auto` (read-only, no side effects).
 *
 * On mapper failure, `execute` throws `TimeMapperError`, which the SDK
 * converts into a non-fatal `tool-error` stream part — mirroring the
 * `ToolDeniedError` pattern in `./types.ts`. The model sees the error
 * message and adapts its prose accordingly; the run continues.
 */

import { z } from "zod";

import { formatTime } from "@/lib/timemapper/format";
import type { ToolDef } from "./types";

const formatInputSchema = z.object({
  iso: z
    .string()
    .describe('ISO 8601 timestamp to format, e.g. "2024-03-15T10:30:00Z"'),
});

/** All TimeMapper tools, keyed by `snake_case` name. */
export function timemapperTools(): Record<string, ToolDef> {
  return {
    format_time: {
      description:
        "Format an ISO 8601 timestamp into this World's custom time representation. " +
        'Returns a display string (e.g. "3rd of Bloommoon, 1247 IE"). ' +
        "Use this when your prose references a specific timestamp from an Event or Scene, " +
        "so your wording matches what the user sees in the UI. " +
        "If the World has no custom time mapper configured, returns the raw ISO string.",
      inputSchema: formatInputSchema,
      consentLevel: "auto",
      execute: async (input) => {
        const { iso } = input as { iso: string };
        const result = await formatTime(iso);
        if (!result.ok) {
          // Throw TimeMapperError — SDK converts to non-fatal tool-error.
          // The model sees the error message and adapts its prose.
          throw result.error;
        }
        return result.display;
      },
    },
  };
}
