/**
 * Agent event logger bridge — the consumer-side observability for the Agent
 * runtime library.
 *
 * This module lives **outside** the library purity boundary (ADR-0019): the
 * library itself (`src/lib/ai/loop/`) has zero logging code and never imports
 * `@/lib/logger`. Instead, an application wires an {@link AgentEvent} listener
 * that forwards the events it cares about into the project's `tracing`-backed
 * logger.
 *
 * ## Conventions
 *
 * - **snake_case field names** (ADR-0016) — these are the only TS callsites
 *   besides `@/lib/logger` where snake_case is correct; the unified log file is
 *   greppable with one pattern per field across Rust and TS origins.
 * - **Metadata-only** — never log creative content. Text / reasoning / tool-
 *   input deltas and full tool inputs/outputs are skipped; tool results and
 *   error messages are reduced to a length / code. Token counts and latencies
 *   are always safe.
 *
 * @example
 *   const handle = agent.run({ messages });
 *   handle.subscribe(createAgentEventLogger("writer"));
 *
 * Related: ADR-0014 (logging stack), ADR-0016 (snake_case fields), ADR-0019.
 */

import { logger } from "@/lib/logger";

import type { AgentEvent } from "@/lib/ai/loop";

/**
 * Create a subscriber that logs agent run lifecycle events under the given
 * `agentName` (e.g. `"writer"`, `"explorer"` — matches the persisted
 * `AgentConfig` name). Delta and `step_start` events are intentionally not
 * logged (creative content / too noisy).
 */
export function createAgentEventLogger(
  agentName: string,
): (event: AgentEvent) => void {
  return (event) => {
    switch (event.type) {
      case "run_start":
        logger.info("agent.run_started", {
          run_id: event.runId,
          agent_name: agentName,
          input_message_count: event.inputMessageCount,
        });
        return;

      case "step_end":
        logger.debug("agent.step_completed", {
          run_id: event.runId,
          agent_name: agentName,
          step_number: event.stepNumber,
          finish_reason: event.finishReason,
          // Omit token fields when the provider didn't report them so "0
          // tokens" and "unreported" stay distinguishable in log aggregation.
          ...(event.usage.inputTokens !== undefined && {
            tokens_input: event.usage.inputTokens,
          }),
          ...(event.usage.outputTokens !== undefined && {
            tokens_output: event.usage.outputTokens,
          }),
          latency_ms: Math.round(event.latencyMs),
        });
        return;

      case "tool_call":
        // No `input` field — creative content may be embedded in tool args.
        logger.debug("agent.tool_called", {
          run_id: event.runId,
          agent_name: agentName,
          tool_name: event.toolName,
          tool_call_id: event.toolCallId,
        });
        return;

      case "tool_result":
        // No `output` field — only its length (could contain scene/character content).
        logger.debug("agent.tool_completed", {
          run_id: event.runId,
          agent_name: agentName,
          tool_name: event.toolName,
          tool_call_id: event.toolCallId,
          output_length: lengthOf(event.output),
        });
        return;

      case "tool_error":
        // No error.message — surface only the stable code.
        logger.warn("agent.tool_failed", {
          run_id: event.runId,
          agent_name: agentName,
          tool_name: event.toolName,
          tool_call_id: event.toolCallId,
          error_code: event.error.code,
        });
        return;

      case "abort":
        logger.warn("agent.run_aborted", {
          run_id: event.runId,
          agent_name: agentName,
          reason: event.reason,
        });
        return;

      case "error":
        // No error.message — model errors can echo prompt content.
        logger.error("agent.run_failed", {
          run_id: event.runId,
          agent_name: agentName,
          step_number: event.stepNumber,
          error_code: event.error.code,
        });
        return;

      case "run_end":
        logger.info("agent.run_completed", {
          run_id: event.runId,
          agent_name: agentName,
          finish_reason: event.finishReason,
        });
        return;

      case "step_start":
      case "text_delta":
      case "reasoning_delta":
      case "tool_input_delta":
        // Intentionally not logged: step_start is noisy, and the delta events
        // carry creative content (model text / reasoning / tool argument text).
        return;

      default: {
        // Exhaustiveness guard — if a new event variant is added to the union,
        // this branch forces a compile error here so it gets a logging decision.
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };
}

/**
 * Best-effort length of a tool output, for size telemetry only. Never logs the
 * content itself.
 */
function lengthOf(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output !== null && typeof output === "object") {
    try {
      return JSON.stringify(output).length;
    } catch {
      return 0;
    }
  }
  return 0;
}
