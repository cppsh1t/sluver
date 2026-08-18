/**
 * Tool infrastructure types — the declarative tool definition pattern with
 * built-in consent levels and the approval gate contract.
 *
 * This module bridges the pure AI runtime's `defineTool` / `ToolSet` with the
 * application layer's IPC-backed CRUD operations. Tool factories across
 * `src/lib/tools/worldbook/` declare `ToolDef` objects with an explicit
 * `consentLevel`; `buildToolSet` compiles them into an SDK `ToolSet`, wiring
 * the consent gate into each tool's `execute` closure.
 *
 * ## Purity
 *
 * Imports `defineTool` + types from the pure AI library (`@/lib/ai`) and
 * `SpaceId` / `WorldId` from `@/types`. Does NOT import React, the logger, or
 * IPC — those live in the concrete tool factories and the gate
 * implementation. The `ApprovalGate` interface is pure; its concrete
 * implementation (which patches the zustand store) lives in the
 * conversation-runtime layer.
 *
 * Related: ADR-0019 (library purity), ADR-0025 (execute-blocking gate).
 */

import type { FlexibleSchema, ToolCallPart, ToolResultPart } from "ai";

import type { Plan } from "@/lib/ai/session/plan";
import { defineTool, type ToolSet } from "@/lib/ai";
import type { EnabledSkill, SpaceId, WorldId } from "@/types";

// ─── Consent levels ───────────────────────────────────────────────────────

/**
 * The safety classification declared on each tool definition. Governs whether
 * the user must explicitly approve a tool call before it executes.
 *
 * - `auto`          — read-only operations (list, get, count). Execute
 *   without asking.
 * - `configurable`  — create operations. Execute without asking only if the
 *   agent's `autoExecuteDangerousTools` flag is enabled; otherwise require
 *   approval.
 * - `always`        — edit, delete, and reorder operations. Always require
 *   explicit approval regardless of configuration.
 *
 * See CONTEXT.md → ConsentLevel.
 */
export type ConsentLevel = "auto" | "configurable" | "always";

/**
 * Determine whether a tool call at the given consent level requires user
 * approval, given the agent's `autoExecuteDangerousTools` setting.
 */
export function needsConsent(
  level: ConsentLevel,
  autoExecuteDangerousTools: boolean,
): boolean {
  switch (level) {
    case "auto":
      return false;
    case "configurable":
      return !autoExecuteDangerousTools;
    case "always":
      return true;
  }
}

// ─── Approval gate ────────────────────────────────────────────────────────

/** Options passed to the SDK's tool `execute` function. */
interface ExecuteOptions {
  readonly toolCallId: string;
  readonly abortSignal: AbortSignal;
  readonly messages: unknown[];
}

/**
 * A request for user approval, carrying the information the UI needs to
 * render the consent banner / inline approve-deny buttons.
 */
export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly consentLevel: ConsentLevel;
}

/**
 * The contract for blocking tool execution until the user approves or denies.
 * Injected into each tool's `execute` closure via {@link ToolContext}.
 *
 * The interface is pure (no React / IPC / store dependencies). The concrete
 * implementation lives in the conversation-runtime layer, where it patches
 * the zustand store's `pendingApprovals` state and resolves the Promise when
 * the user acts (or auto-denies on abort).
 *
 * ## Contract
 *
 * - `request()` must **never reject** — denial resolves `false`, approval
 *   resolves `true`. The caller (`buildToolSet`) converts `false` into a
 *   thrown `ToolDeniedError`.
 * - If the run's abort signal fires while a request is pending, the gate
 *   auto-denies (resolves `false`) so the execute unblocks and the run can
 *   terminate cleanly.
 */
export interface ApprovalGate {
  request(req: ApprovalRequest & { readonly abortSignal: AbortSignal }): Promise<boolean>;
}

// ─── Plan access ──────────────────────────────────────────────────────────

/**
 * Runtime access to the Agent's Plan state, used by tools that need to read
 * or write the working agenda. Currently only the `plan` tool consumes this.
 *
 * Per ADR-0029 Phase 1, this is the ONLY new field on {@link ToolContext} for
 * Plan mode. Phase 2 (Context mode, deferred) adds `threadLookup` separately.
 *
 * ## Purity
 *
 * The interface is pure (no React/IPC/store dependencies). The concrete
 * implementation lives in the conversation-runtime layer, where it closes
 * over the live `Agent` via an agentRef pattern (ADR-0029). Tools see only
 * this narrow interface — they never touch the Agent directly.
 *
 * ## Snapshot semantics (CRITICAL — ADR-0028 invariant 2)
 *
 * `get()` returns the LIVE in-memory value of `Agent.plan`. This is safe
 * because the `plan` tool uses `get()` only to compute output counts at the
 * moment of execution (right after calling `set()`). The Plan reminder that
 * enters the model's input is snapshotted separately at `Agent.run()` entry
 * via the pipeline's plan-injector — `planAccess.get()` is NOT the path by
 * which the model sees the Plan.
 *
 * `set()` mutates `Agent.plan` synchronously AND fire-and-forget persists it.
 * Per ADR-0028 invariant 2, the new Plan takes effect on the NEXT
 * `Agent.run()`, not the current one.
 */
export interface PlanAccess {
  /** Read the current Plan (live value). */
  get(): Plan | null;
  /**
   * Write a new Plan. Sets Agent state synchronously; persists
   * fire-and-forget. Takes effect on the NEXT `Agent.run()` per
   * ADR-0028 invariant 2.
   */
  set(plan: Plan): Promise<void>;
}

// ─── Thread lookup (Context mode — ADR-0031 Phase 1) ───────────────────────

/**
 * Reverse channel into the Persisted Thread, used by the `context_read` tool
 * to expand a compacted tool-call stub back to its original input + output on
 * demand (ADR-0031 §5 — Refinement A).
 *
 * Per ADR-0028 invariant 1, the Persisted Thread (`Agent.messages`) is the
 * source of truth and ALWAYS carries original, uncompacted content. Compaction
 * only reshapes the Derived Model Input (a transient copy built at `run()`
 * entry); it never mutates what `threadLookup` reads. So a tool that pulls via
 * this interface always sees the real args and the real result, regardless of
 * whether the model is currently looking at a stub.
 *
 * ## Purity
 *
 * The interface is pure (no React/IPC/store dependencies). The concrete
 * implementation lives in the conversation-runtime layer, where it closes
 * over the live `Agent` via the same agentRef chicken-and-egg pattern used by
 * {@link PlanAccess} (ADR-0029 §Negative). Tools see only this narrow
 * interface — they never touch the Agent directly.
 *
 * ## Why `findToolPair` and not `findToolResult`
 *
 * ADR-0029 §Phase 2 originally specified `findToolResult(toolCallId):
 * ModelMessage | undefined` — returning only the result, not the call args.
 * The actual requirement ("查参数和结果" — "look up params AND result") needs
 * both. Refined to `findToolPair` returning the call + result together
 * (ADR-0031 §5 Refinement A documents the change; ADR-0029 is not amended).
 */
export interface ThreadLookup {
  /**
   * Find the original (uncompacted) tool-call + tool-result pair for a given
   * `toolCallId` in the Persisted Thread. Returns `undefined` when no such
   * pair exists (wrong id, in-flight call without a result, etc.).
   *
   * @param toolCallId The id printed in a `[tool_call {id}] …` stub.
   */
  findToolPair(toolCallId: string): {
    readonly call: ToolCallPart;
    readonly result: ToolResultPart;
  } | undefined;
}

// ─── Tool context ─────────────────────────────────────────────────────────

/**
 * Runtime context injected into every tool factory. Carries the identifiers
 * and infrastructure the tool needs to execute: the Space/World scope, the
 * approval gate, the agent's consent configuration, access to the Agent's
 * working Plan state (Plan mode — ADR-0029 Phase 1), reverse-channel
 * access to the Persisted Thread for stub expansion (Context mode — ADR-0031
 * Phase 1), and the enabled Agent Skills with their activation dedup state
 * (ADR-0043).
 *
 * Constructed per-conversation in the conversation-runtime store and passed
 * to `RoleBehavior.buildTools(ctx)`.
 */
export interface ToolContext {
  readonly spaceId: SpaceId;
  readonly worldId: WorldId;
  readonly approvalGate: ApprovalGate;
  readonly autoExecuteDangerousTools: boolean;
  /**
   * Whether the shell execution tool (`run_shell_command`) is registered
   * for this conversation's role (ADR-0042). Gating happens at
   * REGISTRATION time (the toolset is built once per conversation);
   * when registered, the tool auto-executes (`consentLevel: "auto"`).
   */
  readonly shellToolEnabled: boolean;
  /**
   * Access to the Agent's Plan state. Used by the `plan` tool (Plan mode —
   * ADR-0029 Phase 1).
   */
  readonly planAccess: PlanAccess;
  /**
   * Reverse channel into the Persisted Thread. Used by the `context_read`
   * tool (Context mode — ADR-0031 Phase 1) to expand compacted tool-call
   * stubs back to their original input + output on demand.
   */
  readonly threadLookup: ThreadLookup;
  /**
   * Agent Skills enabled for this conversation's role (ADR-0043 §3).
   * Populated at Agent construction from the Space-scoped per-AgentConfig
   * enablement (live resolution, same lifecycle as the model —
   * ADR-0023/0024). Empty array = no skills enabled → the skill tools are
   * not registered at all (mirrors the `shellToolEnabled` registration-time
   * gate) and no `<available_skills>` catalog is injected.
   */
  readonly skills: EnabledSkill[];
  /**
   * Per-conversation activation dedup state (ADR-0043 §3): skill names
   * already activated in this conversation. Starts empty; mutated by the
   * `activate_skill` tool's execute — a name is added only AFTER its
   * `readSkillEntry` succeeds, so a failed activation can be retried. The
   * Set reference lives on the context (built once per conversation,
   * alongside the Agent cache — ADR-0024).
   */
  readonly activatedSkills: Set<string>;
}

// ─── Per-call options ──────────────────────────────────────────────────────

/**
 * Per-call runtime data forwarded to {@link ToolDef.execute} as the third
 * argument (ADR-0041 §3).
 *
 * Sourced from the SDK's tool `execute` options by `buildToolSet` — the same
 * object that feeds the approval gate. Unlike {@link ToolContext} (built once
 * per conversation), this carries data whose scope is a SINGLE run: each
 * `Agent.run()` creates a fresh internal `AbortController`, so the signal must
 * not live on the context.
 */
export interface ToolCallOptions {
  /** Abort signal for the current run — fires on user Stop / termination. */
  readonly abortSignal: AbortSignal;
}

// ─── Declarative tool definition ──────────────────────────────────────────

/**
 * A declarative tool definition with an explicit consent level.
 *
 * Unlike the SDK's `tool()` (which has no concept of consent), a `ToolDef`
 * bundles the description, input schema, consent classification, and the
 * execution logic into one self-describing unit. `buildToolSet` compiles
 * these into SDK `Tool` objects, wiring the consent gate automatically.
 *
 * The `execute` function receives a superset of the SDK's execute
 * `(args, options)`: the parsed input, the per-conversation
 * {@link ToolContext} (so tools can access `ctx.spaceId`, `ctx.worldId`,
 * etc. without closure capture at the factory level), and the per-call
 * {@link ToolCallOptions} carrying run-scoped runtime data such as the
 * abort signal (ADR-0041 §3).
 */
export interface ToolDef<I = unknown, O = unknown> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<I>;
  readonly consentLevel: ConsentLevel;
  readonly execute: (input: I, ctx: ToolContext, call: ToolCallOptions) => Promise<O>;
}

// ─── Tool denied error ────────────────────────────────────────────────────

/**
 * Thrown by the consent-gated `execute` wrapper when the user denies a tool
 * call. The SDK converts this into a non-fatal `tool-error` stream part — the
 * model sees the error message and can adapt its approach (e.g. suggest
 * alternatives instead of retrying the denied action).
 */
export class ToolDeniedError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `The user denied the "${toolName}" tool call. Do not retry the same action without changing your approach.`,
    );
    this.name = "ToolDeniedError";
    this.toolName = toolName;
  }
}

// ─── ToolSet compiler ─────────────────────────────────────────────────────

// The `defineTool` wrapper uses a conditional type (`NeverOptional<OUTPUT>`)
// that TypeScript cannot reduce while OUTPUT is an open generic. We cast
// through `unknown` at the call boundary — at every concrete callsite (where
// OUTPUT is fixed) the structural match is exact. This mirrors the approach
// already used inside `defineTool` itself (see its docstring).

type AnyToolDef = ToolDef<unknown, unknown>;

/**
 * Compile a record of {@link ToolDef} declarations into an SDK `ToolSet`,
 * wiring the consent gate into each tool's `execute`.
 *
 * For each tool:
 * 1. If `needsConsent(level, autoExecute)` is `false`, execute proceeds
 *    immediately.
 * 2. If `true`, the gate's `request()` is called (blocking inside `execute`).
 *    The UI shows the pending approval; the user approves or denies.
 * 3. If denied, `ToolDeniedError` is thrown (non-fatal — the model adapts).
 * 4. If approved, the tool's real `execute` runs with the
 * {@link ToolContext} and {@link ToolCallOptions} (the run's abort signal,
 * forwarded from the SDK execute options — ADR-0041 §3).
 *
 * The `ctx` is captured in each tool's closure — built once per conversation
 * at Agent construction time.
 */
export function buildToolSet(
  defs: Record<string, AnyToolDef>,
  ctx: ToolContext,
): ToolSet {
  const tools: ToolSet = {};
  for (const [name, def] of Object.entries(defs)) {
    const { consentLevel, description, inputSchema } = def;
    const mustAsk = needsConsent(consentLevel, ctx.autoExecuteDangerousTools);

    // The execute wrapper: consent gate → real execute.
    const wrappedExecute = async (
      input: unknown,
      options: ExecuteOptions,
    ): Promise<unknown> => {
      if (mustAsk) {
        const approved = await ctx.approvalGate.request({
          toolCallId: options.toolCallId,
          toolName: name,
          input,
          consentLevel,
          abortSignal: options.abortSignal,
        });
        if (!approved) {
          throw new ToolDeniedError(name);
        }
      }
      return def.execute(input, ctx, { abortSignal: options.abortSignal });
    };

    tools[name] = defineTool({
      description,
      inputSchema,
      execute: wrappedExecute as never,
    });
  }
  return tools;
}
