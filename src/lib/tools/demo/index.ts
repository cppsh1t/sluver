/**
 * Demo tools — rice arithmetic + current time.
 *
 * These exist purely to exercise the agent tool-execution UI (tool cards,
 * running/succeeded states, multi-tool rendering) before the real
 * worldbuilding/novel tools are wired in. They have **no application
 * dependencies** — just `defineTool` from the pure AI library (ADR-0019) and
 * Zod v4 for input schemas.
 *
 * Every `execute` awaits an artificial {@link delay} before returning so the
 * UI can show the "running" tool-card state for ~1s. In-memory rice state is
 * module-level and intentionally ephemeral — it resets on reload, which is
 * fine for a demo.
 *
 * Tool keys in {@link demoToolSet} are `snake_case` because that is how the
 * model references tools and how tool names render in the UI.
 *
 * Related: ADR-0019 (tool factories live outside the AI library; tools are
 * opaque to the runtime).
 */

import { defineTool, type ToolSet } from "@/lib/ai";
import { z } from "zod";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Resolve `ms` milliseconds later. Simulates real work for the UI's running state. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ─── Rice arithmetic (shared in-memory pantry) ────────────────────────────

/** Demo-only pantry counter. Not persisted; resets on reload. */
let riceTotal = 0;

/** Reset the demo pantry to zero. Exported for tests / harness resets. */
export function resetRiceTotal(): void {
  riceTotal = 0;
}

/** Current demo pantry value. Exported for tests / assertions. */
export function getRiceTotal(): number {
  return riceTotal;
}

export const addRiceTool = defineTool({
  description:
    "Add the given amount of rice (in cups) to the pantry. Use when the user asks to add or stock rice.",
  inputSchema: z.object({
    amount: z
      .number()
      .int()
      .positive()
      .describe("Cups of rice to add to the pantry (positive integer)."),
  }),
  execute: async (input) => {
    await delay(800);
    riceTotal += input.amount;
    return { total: riceTotal, added: input.amount };
  },
});

export const subtractRiceTool = defineTool({
  description:
    "Remove the given amount of rice (in cups) from the pantry. Use when the user asks to take, use, or remove rice.",
  inputSchema: z.object({
    amount: z
      .number()
      .int()
      .positive()
      .describe("Cups of rice to remove from the pantry (positive integer)."),
  }),
  execute: async (input) => {
    await delay(800);
    riceTotal -= input.amount;
    return { total: riceTotal, removed: input.amount };
  },
});

// ─── Current time ─────────────────────────────────────────────────────────

export const getCurrentTimeTool = defineTool({
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
  execute: async (input) => {
    await delay(1200);
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "full",
      timeStyle: "long",
      ...(input.timezone ? { timeZone: input.timezone } : {}),
    };
    const formatted = new Intl.DateTimeFormat(undefined, options).format(now);
    return { iso: now.toISOString(), formatted };
  },
});

// ─── Composed toolset ─────────────────────────────────────────────────────

/**
 * Pre-built {@link ToolSet} of all demo tools, keyed by `snake_case` names.
 * Drop into an `AgentLoopOptions.tools` map (or merge with others).
 */
export const demoToolSet: ToolSet = {
  add_rice: addRiceTool,
  subtract_rice: subtractRiceTool,
  get_current_time: getCurrentTimeTool,
};
