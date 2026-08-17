import { describe, expect, it } from "vitest";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

import {
  AgentLoop,
  ConfigError,
  ProviderError,
  defineTool,
  type AgentEvent,
  type ModelMessage,
} from "@/lib/ai";

// ─── Stream fixtures (provider-level V3 chunk shapes) ────────────────────

/**
 * The provider-level V3 stream-chunk shapes used in these tests (a structural
 * subset of `LanguageModelV3StreamPart` from `@ai-sdk/provider`).
 */
type V3Chunk =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "error";
      error: unknown;
    }
  | {
      type: "finish";
      finishReason: { unified: "stop" | "tool-calls"; raw: undefined };
      usage: ReturnType<typeof v3Usage>;
    };

/** Nested V3 provider usage shape (as emitted inside the `finish` part). */
const v3Usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: outputTokens,
    text: outputTokens,
    reasoning: undefined,
  },
});

const finish = (unified: "stop" | "tool-calls", inputTokens: number, outputTokens: number): V3Chunk => ({
  type: "finish",
  finishReason: { unified, raw: undefined },
  usage: v3Usage(inputTokens, outputTokens),
});

/** Chunks for one text-only model step. */
function textChunks(text: string, inputTokens = 3, outputTokens = 5): V3Chunk[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finish("stop", inputTokens, outputTokens),
  ];
}

/** Chunks for one tool-calling model step (input must be a JSON string). */
function toolCallChunks(
  toolCallId: string,
  toolName: string,
  input: unknown,
  inputTokens = 3,
  outputTokens = 5,
): V3Chunk[] {
  return [
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    finish("tool-calls", inputTokens, outputTokens),
  ];
}

const streamOf = (chunks: V3Chunk[], chunkDelayInMs?: number) => ({
  stream: simulateReadableStream({ chunks, chunkDelayInMs }),
});

/** Text content of a ModelMessage, tolerating string or part-array content. */
function messageText(message: ModelMessage | undefined): string {
  if (!message) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

const USER_MESSAGE: ModelMessage = { role: "user", content: "go" };

function makeLoop(model: MockLanguageModelV3, maxSteps = 4) {
  return new AgentLoop({
    model,
    systemPrompt: "test",
    tools: {},
    maxSteps,
  });
}

// ─── Construction ─────────────────────────────────────────────────────────

describe("AgentLoop construction", () => {
  const model = new MockLanguageModelV3({});

  it("throws ConfigError when maxSteps is less than 1", () => {
    expect(() => makeLoop(model, 0)).toThrowError(ConfigError);
  });

  it("throws ConfigError when maxSteps is not an integer", () => {
    expect(() => makeLoop(model, 1.5)).toThrowError(ConfigError);
  });
});

// ─── Stop ─────────────────────────────────────────────────────────────────

describe("AgentLoop stop", () => {
  it("resolves with finishReason stop, final text, usage and a frozen result", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("done"))] });
    const loop = makeLoop(model);
    const events: AgentEvent[] = [];

    const handle = loop.run({ messages: [USER_MESSAGE] });
    handle.subscribe((event) => events.push(event));
    const result = await handle.result;

    expect(result.finishReason).toBe("stop");
    expect(result.finalText).toBe("done");
    expect(result.steps).toHaveLength(1);
    expect(result.totalUsage.inputTokens).toBe(3);
    expect(result.totalUsage.outputTokens).toBe(5);
    expect(result.totalUsage.totalTokens).toBe(8);
    expect(result.error).toBeUndefined();
    expect("error" in result).toBe(false);

    // Messages: defensive frozen copy of [input..., assistant response].
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messageText(result.messages[1])).toBe("done");
    expect(result.messages).not.toBe([USER_MESSAGE]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);

    // The model received the constructor's system prompt + the input thread.
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.prompt[0]).toEqual({
      role: "system",
      content: "test",
    });
    expect(model.doStreamCalls[0]?.prompt[1]?.role).toBe("user");

    // Event stream: run_start first, run_end last, exactly one step.
    expect(events[0]?.type).toBe("run_start");
    expect(events[0]).toMatchObject({
      type: "run_start",
      inputMessageCount: 1,
    });
    expect(events[events.length - 1]?.type).toBe("run_end");
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "step_start",
      "text_delta",
      "step_end",
      "run_end",
    ]);
    expect(events.every((e) => e.runId === handle.runId)).toBe(true);
  });

  it("does not mutate the caller's input array", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("ok"))] });
    const loop = makeLoop(model);
    const input: ModelMessage[] = [{ role: "user", content: "keep me" }];

    const handle = loop.run({ messages: input });
    const result = await handle.result;

    expect(input).toHaveLength(1);
    expect(input[0]?.role).toBe("user");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).not.toBe(input); // fresh frozen copy
  });
});

// ─── Tool loop ────────────────────────────────────────────────────────────

describe("AgentLoop tool loop", () => {
  it("executes the tool, feeds the result back, and stops on the follow-up step", async () => {
    const executions: unknown[] = [];
    const echo = defineTool({
      description: "echo the message back",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => {
        executions.push(input);
        return { echoed: input.msg };
      },
    });

    const model = new MockLanguageModelV3({
      doStream: [
        streamOf(toolCallChunks("call-1", "echo", { msg: "hi" })),
        streamOf(textChunks("done", 7, 11)),
      ],
    });
    const loop = new AgentLoop({
      model,
      systemPrompt: "test",
      tools: { echo },
      maxSteps: 2,
    });
    const events: AgentEvent[] = [];

    const handle = loop.run({ messages: [USER_MESSAGE] });
    handle.subscribe((event) => events.push(event));
    const result = await handle.result;

    // Tool executed exactly once, with the parsed input.
    expect(executions).toEqual([{ msg: "hi" }]);

    // Two model calls: tool step then text step.
    expect(result.finishReason).toBe("stop");
    expect(result.finalText).toBe("done");
    expect(result.steps).toHaveLength(2);
    expect(model.doStreamCalls).toHaveLength(2);

    // Step 2's prompt carries the tool-call + tool-result pair.
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("call-1");
    expect(secondPrompt).toContain("echoed");

    // Accumulated thread: user → assistant(tool-call) → tool(result) → assistant(text).
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messageText(result.messages[3])).toBe("done");

    // Usage summed across both steps.
    expect(result.totalUsage.inputTokens).toBe(10);
    expect(result.totalUsage.outputTokens).toBe(16);

    // Full event sequence.
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "step_start", // step 0
      "tool_call",
      "tool_result",
      "step_end",
      "step_start", // step 1
      "text_delta",
      "step_end",
      "run_end",
    ]);
    const toolCallEvent = events.find((e) => e.type === "tool_call");
    expect(toolCallEvent).toMatchObject({
      toolCallId: "call-1",
      toolName: "echo",
      input: { msg: "hi" },
    });
    const toolResultEvent = events.find((e) => e.type === "tool_result");
    expect(toolResultEvent).toMatchObject({
      toolCallId: "call-1",
      toolName: "echo",
      output: { echoed: "hi" },
    });
  });
});

// ─── Max steps ────────────────────────────────────────────────────────────

describe("AgentLoop max steps", () => {
  it("stops with finishReason max-steps once the budget is exhausted", async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        streamOf(toolCallChunks("call-a", "noop", {})),
        streamOf(toolCallChunks("call-b", "noop", {})),
        streamOf(toolCallChunks("call-c", "noop", {})), // never consumed
      ],
    });
    const loop = makeLoop(model, 2);

    const handle = loop.run({ messages: [USER_MESSAGE] });
    const result = await handle.result;

    expect(result.finishReason).toBe("max-steps");
    expect(result.steps).toHaveLength(2);
    expect(model.doStreamCalls).toHaveLength(2); // third stream never requested
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(result.finalText).toBe(""); // tool-only steps produce no text
    expect(result.error).toBeUndefined();
  });
});

// ─── Abort (ADR-0018 — every termination resolves) ───────────────────────

describe("AgentLoop abort", () => {
  it("resolves with finishReason aborted when the input signal is ALREADY aborted", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("nope"))] });
    const loop = makeLoop(model);
    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];

    const handle = loop.run({
      messages: [USER_MESSAGE],
      abortSignal: controller.signal,
    });
    handle.subscribe((event) => events.push(event));
    const result = await handle.result;

    expect(result.finishReason).toBe("aborted");
    expect(result.error).toBeUndefined();
    // Aborted before the first step — the model was never called.
    expect(model.doStreamCalls).toHaveLength(0);
    expect(result.messages).toHaveLength(1);
    expect(result.finalText).toBe("");
    expect(events.map((e) => e.type)).toEqual(["run_start", "abort", "run_end"]);
  });

  it("resolves with finishReason aborted when handle.abort() fires before the loop starts", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("nope"))] });
    const loop = makeLoop(model);
    const events: AgentEvent[] = [];

    const handle = loop.run({ messages: [USER_MESSAGE] });
    handle.subscribe((event) => events.push(event));
    handle.abort("changed my mind");
    const result = await handle.result;

    expect(result.finishReason).toBe("aborted");
    expect(model.doStreamCalls).toHaveLength(0);
    const abortEvent = events.find((event) => event.type === "abort");
    expect(abortEvent).toMatchObject({ type: "abort", reason: "changed my mind" });
    expect(events[events.length - 1]?.type).toBe("run_end");
  });

  it("ALWAYS resolves (never rejects) on a mid-stream abort, salvaging partial output", async () => {
    const model = new MockLanguageModelV3({
      doStream: streamOf(
        [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello" },
          { type: "text-delta", id: "t1", delta: " world" },
          { type: "text-end", id: "t1" },
          finish("stop", 1, 1),
        ],
        40,
      ),
    });
    const loop = makeLoop(model);

    const handle = loop.run({ messages: [USER_MESSAGE] });
    handle.subscribe((event) => {
      if (event.type === "text_delta") {
        handle.abort("user canceled");
      }
    });
    const result = await handle.result; // must resolve, not reject

    expect(result.finishReason).toBe("aborted");
    expect(result.error).toBeUndefined();
    // The partial assistant text that streamed before the abort is salvaged.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.role).toBe("assistant");
    expect(messageText(result.messages[1])).toBe("Hello");
  });

  it("is idempotent — aborting again after settle is a no-op", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("done"))] });
    const loop = makeLoop(model);

    const handle = loop.run({ messages: [USER_MESSAGE] });
    const result = await handle.result;
    handle.abort("late");

    expect(result.finishReason).toBe("stop");
  });
});

// ─── Error (ADR-0018 — errors surface via result.error) ─────────────────

describe("AgentLoop error", () => {
  it("resolves with finishReason error and a classified ProviderError", async () => {
    const apiError = new APICallError({
      message: "boom",
      url: "https://api.example.test/v1/chat",
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: true,
      responseBody: "upstream said no",
    });
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [{ type: "error", error: apiError }],
        }),
      },
    });
    const loop = makeLoop(model);
    const events: AgentEvent[] = [];

    const handle = loop.run({ messages: [USER_MESSAGE] });
    handle.subscribe((event) => events.push(event));
    const result = await handle.result; // must resolve, not reject

    expect(result.finishReason).toBe("error");
    expect(result.error).toBeInstanceOf(ProviderError);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.fatal).toBe(true);
    expect(result.error?.message).toBe("boom");
    expect(result.error?.cause).toBe(apiError);
    expect(result.steps).toHaveLength(0);
    expect(result.finalText).toBe("");
    expect(events[events.length - 1]?.type).toBe("run_end");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ─── Concurrency guard ────────────────────────────────────────────────────

describe("AgentLoop concurrency guard", () => {
  it("throws ConfigError on a second run while one is active, then recovers", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => streamOf(textChunks("slow"), 80),
    });
    const loop = makeLoop(model);

    const first = loop.run({ messages: [USER_MESSAGE] });

    expect(() => loop.run({ messages: [USER_MESSAGE] })).toThrowError(ConfigError);

    // Clean up + verify sequential reuse works once the first run settles.
    first.abort();
    const firstResult = await first.result;
    expect(firstResult.finishReason).toBe("aborted");

    const second = loop.run({ messages: [USER_MESSAGE] });
    const secondResult = await second.result;
    expect(secondResult.finishReason).toBe("stop");
    expect(secondResult.finalText).toBe("slow");
  });
});

// ─── Subscription semantics ───────────────────────────────────────────────

describe("AgentLoop subscribe", () => {
  it("unregistering a listener stops its delivery without affecting others", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("done"))] });
    const loop = makeLoop(model);
    const firstEvents: AgentEvent[] = [];
    const secondEvents: AgentEvent[] = [];

    const handle = loop.run({ messages: [USER_MESSAGE] });
    const unsubscribeFirst = handle.subscribe((e) => firstEvents.push(e));
    handle.subscribe((e) => secondEvents.push(e));
    unsubscribeFirst();
    // Idempotent unsubscribe — a second call is a no-op.
    unsubscribeFirst();
    await handle.result;

    expect(firstEvents).toHaveLength(0);
    expect(secondEvents[0]?.type).toBe("run_start");
    expect(secondEvents[secondEvents.length - 1]?.type).toBe("run_end");
  });

  it("isolates a throwing subscriber — the run and other subscribers are unaffected", async () => {
    const model = new MockLanguageModelV3({ doStream: [streamOf(textChunks("done"))] });
    const loop = makeLoop(model);
    const healthy: AgentEvent[] = [];

    const handle = loop.run({ messages: [USER_MESSAGE] });
    handle.subscribe(() => {
      throw new Error("buggy listener");
    });
    handle.subscribe((e) => healthy.push(e));
    const result = await handle.result;

    expect(result.finishReason).toBe("stop");
    expect(healthy.map((e) => e.type)).toEqual([
      "run_start",
      "step_start",
      "text_delta",
      "step_end",
      "run_end",
    ]);
  });
});
