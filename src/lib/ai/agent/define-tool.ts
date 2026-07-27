/**
 * `defineTool` — the project's single entry point for declaring agent tools.
 *
 * It is a thin wrapper around the SDK's `tool()` helper that centralises two
 * conventions so they cannot be forgotten at callsites:
 *
 * 1. **`description` is required** (the SDK makes it optional; we don't — every
 *    tool must be self-describing so the model can pick it).
 * 2. **`inputSchema` is required** (a Zod v4 / Standard Schema schema).
 *
 * Concrete tool *factories* (closure-capture pattern, ADR-0019) live outside
 * this library — see `src/lib/tools/worldbook.ts`. They import `defineTool`
 * from here rather than `tool` from `"ai"`, so the convention is enforced in
 * one place.
 *
 * Related: ADR-0019 (library purity boundary; tools are opaque to the runtime).
 */

import {
  tool,
  type FlexibleSchema,
  type Tool,
  type ToolExecuteFunction,
} from "ai";

/**
 * Define a tool with a required description and input schema.
 *
 * The `execute` signature is passed through unchanged (including its
 * `abortSignal` / `messages` / `toolCallId` execution options). `CONTEXT`
 * defaults to an empty record — override it when a tool consumes typed runtime
 * context captured by its factory closure.
 *
 * @returns a {@link Tool} ready to drop into an `AgentOptions.tools` map.
 */
export function defineTool<
  INPUT,
  OUTPUT,
  CONTEXT extends Record<string, unknown> = Record<string, unknown>,
>(options: {
  /** Human-readable description of what the tool does (sent to the model). Required. */
  description: string;
  /** Zod v4 / Standard Schema describing the tool's input. Required. */
  inputSchema: FlexibleSchema<INPUT>;
  /** Execute function; receives `(input, options)` with `options.abortSignal`. */
  execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
}): Tool<INPUT, OUTPUT, CONTEXT> {
  // `tool()` is a runtime identity — it returns its argument unchanged; its
  // sole purpose is type-level inference / ExecutableTool narrowing. The
  // argument is asserted through `unknown` because the SDK's `Tool` type uses
  // `NeverOptional<OUTPUT>`, a conditional type that TypeScript cannot reduce
  // while `OUTPUT` is still an open type parameter. At every concrete callsite
  // (where OUTPUT is fixed to a real type), the conditional resolves and the
  // structural match between our `options` shape and `Tool<INPUT, OUTPUT,
  // CONTEXT>` is exact — the cast exists only to bridge that unresolved
  // conditional, not to suppress a real type mismatch.
  return tool<INPUT, OUTPUT, CONTEXT>(
    options as unknown as Tool<INPUT, OUTPUT, CONTEXT>,
  );
}
