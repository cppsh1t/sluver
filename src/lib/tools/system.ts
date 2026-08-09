/**
 * System tools — time, the working Plan, and other non-domain utilities.
 *
 * Consent level: `auto` throughout. The `plan` tool is `auto` because the
 * Plan is the Agent's own working memory (not user-authored data); the user
 * observes it in the UI but does not approve edits to it (ADR-0029 Q5.6).
 */

import { z } from "zod";

import type { Plan } from "@/lib/ai/session/plan";

import { timemapperTools } from "./timemapper";
import type { ToolDef } from "./types";

// ─── `plan` tool types ────────────────────────────────────────────────────

/**
 * Input shape for the {@link systemTools `plan`} tool. Mirrors the Zod schema
 * 1:1; declared as a named type so the `execute` body can cast the widened
 * `unknown` input (a consequence of `Record<string, ToolDef>`) back to a
 * known shape.
 */
interface PlanToolInput {
  /** The complete list of Plan items (replaces any prior Plan wholesale). */
  readonly items: { readonly text: string; readonly status: "pending" | "in_progress" | "done" }[];
}

/**
 * Output shape for the {@link systemTools `plan`} tool. Echoes the normalized
 * Plan plus pending/done counts so the model can verify its write landed
 * correctly without a separate read tool (Q5.3 — YAGNI).
 */
interface PlanToolOutput {
  /** The Plan that was just set (echo of input, normalized as a Plan). */
  readonly plan: Plan;
  /** Count of items with status "pending". */
  readonly pendingCount: number;
  /** Count of items with status "in_progress". */
  readonly inProgressCount: number;
  /** Count of items with status "done". */
  readonly doneCount: number;
}

/** All system-level tools, keyed by `snake_case` name (except `plan`). */
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

    // ── Plan (the Agent's working agenda — ADR-0028, ADR-0029 Phase 1) ──
    plan: {
      description:
        "Set or update the working Plan for this conversation — an ordered TODO list that guides your subsequent turns. Each call REPLACES the prior Plan wholesale (last-write-wins); there is no partial update. Changes take effect on the NEXT turn (the current turn's reminder is already snapshotted). Use this to: (1) lay out a multi-step approach before starting work, (2) advance items through the pending → in_progress → done lifecycle as you work on them — mark an item in_progress when you begin it and done when finished, (3) add or remove items as the work evolves. An empty items array clears the Plan.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              text: z
                .string()
                .min(1)
                .describe("The TODO text. Keep it to one short sentence."),
              status: z
                .enum(["pending", "in_progress", "done"])
                .describe(
                  "Item state. 'pending' = not yet started. 'in_progress' = an item you have started but not yet finished. 'done' = completed.",
                ),
            }),
          )
          .describe("The complete list of Plan items. Replaces any prior Plan wholesale."),
      }),
      // `auto` per ADR-0029 Q5.6: the Plan is the Agent's own working memory,
      // not user data — no consent gate. (Wholesale-replace is safe because the
      // tool is the sole writer and persists fire-and-forget via the Agent.)
      consentLevel: "auto",
      execute: async (input, ctx): Promise<PlanToolOutput> => {
        const { items } = input as PlanToolInput;
        const plan: Plan = { items };
        // `set()` updates `Agent.plan` synchronously and persists
        // fire-and-forget; the await guarantees the synchronous mutation has
        // happened before we compute the summary. Per ADR-0028 invariant 2,
        // the new Plan influences the NEXT `Agent.run()` (this turn's Derived
        // Model Input was already snapshotted at run entry).
        await ctx.planAccess.set(plan);
        const pendingCount = plan.items.filter((i) => i.status === "pending").length;
        const inProgressCount = plan.items.filter((i) => i.status === "in_progress").length;
        const doneCount = plan.items.filter((i) => i.status === "done").length;
        return { plan, pendingCount, inProgressCount, doneCount };
      },
    },
  };
}
