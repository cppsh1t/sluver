/**
 * Subagent dispatch tool — `dispatch_subagent` (ADR-0050 D3).
 *
 * The Orchestrator's ONLY delegation surface: one call = one fresh one-shot
 * Subagent Run (D2 — a hidden `kind: "subagent"` conversation created at
 * execution time by the runner). The execute BLOCKS until the child run
 * resolves — structurally identical to the consent gate's indefinite
 * blocking execute (ADR-0025) — and resolves into the
 * {@link SubagentDispatchResult} contract, which doubles as the persisted
 * parent-thread `tool_result` the subagent block anchors on.
 *
 * Sibling dispatches emitted in one step run concurrently (the SDK executes
 * parallel tool calls concurrently); the step completes when all resolve.
 * Blocking consumes no step budget — `maxSteps` counts loop iterations, not
 * wall time.
 *
 * ## Input
 *
 * `role` is a STATIC enum of the eight subagent names — schema stability is
 * prompt-cache-friendly and unconfigured roles are never hidden (D6:
 * explicit-fail — dispatching one resolves `status: "unconfigured"`).
 * `task` is free-form text the Orchestrator composes; it is the ONLY context
 * the child receives (runs share no memory — everything the subagent needs
 * must ride the brief).
 *
 * ## Consent
 *
 * `auto` — dispatching is pure coordination: the child run carries its own
 * conversation, its own toolset, and its own approval gate (D5), so
 * dangerous operations still surface for user approval inside the run.
 *
 * ## Abort
 *
 * The parent run's per-call abort signal is forwarded verbatim to the
 * runner (the same `ToolCallOptions.abortSignal` forwarding pattern
 * `look_at` uses, ADR-0041 §3); the runner chains it into the child run so
 * stopping the Orchestrator cascades to all in-flight children (D4).
 *
 * ## Purity
 *
 * No React / IPC / logger imports (ADR-0019) — all app-side machinery hides
 * behind `ctx.subagentRunner` (interface in `./types`, implementation in the
 * conversation-runtime store).
 */

import { z } from "zod";

import type { SubagentDispatchInput, ToolDef } from "./types";

/**
 * The dispatchable subagent roles (ADR-0050 D1), as a literal enum.
 *
 * Declared LOCALLY (mirroring `SUBAGENT_ROLE_NAMES` from
 * `@/lib/ai-roles`) for two reasons, both with precedent in `look-at.ts`'s
 * `ENTITY_KINDS`:
 *
 * 1. The role registry is the composition root — it imports the worldbook
 *    builders, which import THIS module for the orchestrator's dispatch
 *    spread. Importing `SUBAGENT_ROLE_NAMES` back from the registry would
 *    close a module-evaluation cycle and hit the TDZ while this module's
 *    top-level schema is being built.
 * 2. A literal tuple (not `readonly string[]`) gives zod the literal union
 *    for precise parse errors and a typed `role` field, and keeps the
 *    schema + model-facing description stable regardless of type-level
 *    refactors.
 *
 * MUST stay in lockstep with `SUBAGENT_ROLE_NAMES` (registry roster order).
 */
const SUBAGENT_ROLES = [
  "explorer",
  "curator",
  "scribe",
  "historian",
  "editor",
  "plotter",
  "writer",
  "critic",
] as const satisfies readonly string[];

const inputSchema = z.object({
  role: z
    .enum(SUBAGENT_ROLES)
    .describe(
      "The specialist subagent to dispatch (one of the eight roster roles). Dispatching a role whose model is unbound returns status \"unconfigured\" — report that to the user.",
    ),
  task: z
    .string()
    .min(1)
    .describe(
      "A COMPLETE, self-contained task brief for the subagent. The subagent shares NO memory with you or with other runs — this brief is the ONLY context it gets. Include every entity id, name, file, requirement, and constraint needed to finish the job in one pass (artifacts it must write, questions it must answer, tone/length expectations).",
    ),
});

/** Dispatch tool factory, keyed by `snake_case` name. */
export function subagentTools(): Record<string, ToolDef> {
  return {
    dispatch_subagent: {
      description:
        "Dispatch a specialist subagent to execute a task and wait for its report. " +
        "ONE dispatch = ONE fresh one-shot run: the subagent starts with no memory of this conversation, sees ONLY the task brief you write, does its work (reading/writing the database through its own tools), and returns its final report message. " +
        "Write the brief accordingly — include every id, name, and requirement the subagent needs; never refer to \"above\" or \"as discussed\". " +
        "Dispatches emitted as SIBLING calls in one step run concurrently and all block until they finish — prefer that for independent work (e.g. one writer per scene); sequence dispatches across steps when a later task depends on an earlier result. " +
        "The result carries { runId, status, finalMessage, usage }: status \"completed\" with the subagent's final report; \"unconfigured\" when that role has no model bound (tell the user to bind one in Settings and ask how to proceed); \"aborted\"/\"stopped\" with whatever partial text exists; \"error\" with the failure. " +
        "Do not re-dispatch a task that already succeeded; inspect the report and decide.",
      inputSchema,
      consentLevel: "auto",
      execute: async (input, ctx, call) => {
        const { role, task } = input as SubagentDispatchInput;
        // Anchor the parent-link back-reference. The SDK assigns the
        // toolCallId in the execute options and buildToolSet threads it
        // through ToolCallOptions; the UUID fallback only fires for direct
        // (test) execute calls that omit it.
        const parentToolCallId = call.toolCallId ?? crypto.randomUUID();
        // Verbatim pass-through: validation, run lifecycle, status mapping,
        // and never-reject semantics all live in the runner (ADR-0018
        // extended to the dispatch composite, D4).
        return ctx.subagentRunner.run({ role, task, parentToolCallId }, call.abortSignal);
      },
    },
  };
}
