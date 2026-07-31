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

import type { FlexibleSchema } from "ai";

import { defineTool, type ToolSet } from "@/lib/ai";
import type { SpaceId, WorldId } from "@/types";

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

// ─── Tool context ─────────────────────────────────────────────────────────

/**
 * Runtime context injected into every tool factory. Carries the identifiers
 * and infrastructure the tool needs to execute: the Space/World scope, the
 * approval gate, and the agent's consent configuration.
 *
 * Constructed per-conversation in the conversation-runtime store and passed
 * to `RoleBehavior.buildTools(ctx)`.
 */
export interface ToolContext {
  readonly spaceId: SpaceId;
  readonly worldId: WorldId;
  readonly approvalGate: ApprovalGate;
  readonly autoExecuteDangerousTools: boolean;
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
 * The `execute` function receives the parsed input AND the
 * {@link ToolContext} — unlike the SDK's execute which only receives
 * `(args, options)`. This lets tools access `ctx.spaceId`, `ctx.worldId`,
 * etc. without closure capture at the factory level.
 */
export interface ToolDef<I = unknown, O = unknown> {
  readonly description: string;
  readonly inputSchema: FlexibleSchema<I>;
  readonly consentLevel: ConsentLevel;
  readonly execute: (input: I, ctx: ToolContext) => Promise<O>;
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
 *    {@link ToolContext}.
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
      return def.execute(input, ctx);
    };

    tools[name] = defineTool({
      description,
      inputSchema,
      execute: wrappedExecute as never,
    });
  }
  return tools;
}
