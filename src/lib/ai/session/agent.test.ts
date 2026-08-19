import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import type { UserContent } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import {
  Agent,
  AgentLoop,
  ConfigError,
  type LanguageModelUsage,
  type ModelMessage,
  type Plan,
  type SessionMessage,
  type SessionStore,
} from "@/lib/ai";

const SID = "session-1";
const ROLE_PROMPT = "You are the worldbuilding role.";

// ─── Stream fixtures ──────────────────────────────────────────────────────

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

/** A model whose every stream replies with a fixed text (per-call fresh). */
function replyModel(text: string, chunkDelayInMs?: number): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs,
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: v3Usage(3, 5),
          },
        ],
      }),
    }),
  });
}

// ─── In-memory SessionStore fake ──────────────────────────────────────────

interface AppendCall {
  sessionId: string;
  delta: SessionMessage[];
  turnUsage?: LanguageModelUsage;
}

function createStore(initial: { messages?: SessionMessage[]; plan?: Plan | null } = {}) {
  const state = {
    messages: [...(initial.messages ?? [])],
    plan: initial.plan ?? null,
    appendFailuresRemaining: 0,
  };
  const appendCalls: AppendCall[] = [];
  const savePlanCalls: Array<{ sessionId: string; plan: Plan }> = [];
  const loadMessagesCalls: string[] = [];

  const store: SessionStore = {
    createSession: () => Promise.reject(new Error("unused")),
    listSessions: () => Promise.reject(new Error("unused")),
    deleteSession: () => Promise.reject(new Error("unused")),
    loadMessages: (sessionId) => {
      loadMessagesCalls.push(sessionId);
      return Promise.resolve([...state.messages]);
    },
    appendMessages: (sessionId, delta, turnUsage) => {
      if (state.appendFailuresRemaining > 0) {
        state.appendFailuresRemaining -= 1;
        return Promise.reject(new Error("disk full"));
      }
      appendCalls.push({ sessionId, delta: [...delta], turnUsage });
      state.messages.push(...delta);
      return Promise.resolve();
    },
    loadPlan: () => Promise.resolve(state.plan),
    savePlan: (sessionId, plan) => {
      savePlanCalls.push({ sessionId, plan });
      state.plan = plan;
      return Promise.resolve();
    },
  };

  return {
    store,
    state,
    appendCalls,
    savePlanCalls,
    loadMessagesCalls,
    failNextAppend: () => {
      state.appendFailuresRemaining += 1;
    },
  };
}

/** Wrap a ModelMessage with deterministic persistence metadata. */
function sess(message: ModelMessage, n: number): SessionMessage {
  return {
    ...message,
    id: `msg-${n}`,
    sessionId: SID,
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  };
}

function makeAgent(model: MockLanguageModelV3, store: SessionStore, extra?: {
  compactionPolicy?: { enabled: boolean; turnAge: number };
  onPersistError?: (error: unknown) => void;
}) {
  return Agent.open({
    loop: new AgentLoop({
      model,
      systemPrompt: "constructor fallback",
      tools: {},
      maxSteps: 3,
    }),
    store,
    sessionId: SID,
    roleStaticPrompt: ROLE_PROMPT,
    ...extra,
  });
}

// ─── open() ───────────────────────────────────────────────────────────────

describe("Agent.open", () => {
  it("loads the persisted thread and plan from the store", async () => {
    const plan: Plan = { items: [{ text: "a task", status: "pending" }] };
    const preloaded = [
      sess({ role: "user", content: "earlier" }, 1),
      sess({ role: "assistant", content: [{ type: "text", text: "earlier reply" }] }, 2),
    ];
    const { store, loadMessagesCalls } = createStore({ messages: preloaded, plan });

    const agent = await makeAgent(replyModel("ok"), store);

    expect(agent.id).toBe(SID);
    expect(loadMessagesCalls).toEqual([SID]);
    expect(agent.getMessages()).toHaveLength(2);
    expect(agent.getMessages()[0]).toMatchObject({ role: "user", content: "earlier" });
    expect(agent.getPlan()).toBe(plan);
    // Defensive copy: a fresh array every call.
    expect(agent.getMessages()).not.toBe(agent.getMessages());
  });
});

// ─── run(): persistence, delta slicing, usage forwarding ─────────────────

describe("Agent.run persistence (ADR-0020 / ADR-0030)", () => {
  it("persists the user message WITHOUT usage first, then the delta WITH totalUsage", async () => {
    const preloaded = [
      sess({ role: "user", content: "earlier" }, 1),
      sess({ role: "assistant", content: [{ type: "text", text: "earlier reply" }] }, 2),
    ];
    const { store, appendCalls, state } = createStore({ messages: preloaded });
    const agent = await makeAgent(replyModel("Hello back"), store);

    const handle = agent.run("hi");
    const result = await handle.result;
    expect(result.finishReason).toBe("stop");

    // Exactly two appends, in order.
    expect(appendCalls).toHaveLength(2);
    const [userAppend, deltaAppend] = appendCalls;

    // 1st: the fresh user message only, no turnUsage.
    expect(userAppend.sessionId).toBe(SID);
    expect(userAppend.turnUsage).toBeUndefined();
    expect(userAppend.delta).toHaveLength(1);
    expect(userAppend.delta[0]).toMatchObject({
      role: "user",
      content: "hi",
      sessionId: SID,
    });

    // 2nd: exactly the run's NEW messages (not the prior thread), with usage.
    expect(deltaAppend.sessionId).toBe(SID);
    expect(deltaAppend.delta).toHaveLength(1);
    expect(deltaAppend.delta[0]?.role).toBe("assistant");
    expect(deltaAppend.turnUsage).toBe(result.totalUsage);

    // The in-memory thread is prior + user + assistant.
    expect(agent.getMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(state.messages).toHaveLength(4);
  });

  it("sends the composed role prompt plus the full thread to the model", async () => {
    const { store } = createStore();
    const model = replyModel("ok");
    const agent = await makeAgent(model, store);

    const handle = agent.run("hi");
    await handle.result;

    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt[0]).toEqual({ role: "system", content: ROLE_PROMPT });
    expect(prompt.map((m) => m.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(prompt)).toContain("hi");
  });

  it("skips the delta persist when the run produced no new messages", async () => {
    const { store, appendCalls } = createStore();
    // Pre-aborted run: no model output → empty delta → only the user append.
    const model = replyModel("never streamed");
    const agent = await makeAgent(model, store);

    const controller = new AbortController();
    controller.abort();
    const handle = agent.run("hi", { abortSignal: controller.signal });
    const result = await handle.result;

    expect(result.finishReason).toBe("aborted");
    expect(appendCalls).toHaveLength(1); // user message only
    expect(agent.getMessages().map((m) => m.role)).toEqual(["user"]);
  });
});

// ─── run(): Derived Model Input vs Persisted Thread (ADR-0028 / ADR-0031) ─

describe("Agent.run derived-model-input transforms", () => {
  function agedToolThread(): SessionMessage[] {
    return [
      sess({ role: "user", content: "first question" }, 1),
      sess(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
        },
        2,
      ),
      sess(
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc-1",
              toolName: "lookup",
              output: { type: "text", value: "found" },
            },
          ],
        },
        3,
      ),
    ];
  }

  it("compacts aged tool pairs in the model input but leaves the thread uncompacted", async () => {
    const { store } = createStore({ messages: agedToolThread() });
    const model = replyModel("answer");
    const agent = await makeAgent(model, store, {
      compactionPolicy: { enabled: true, turnAge: 1 },
    });

    const handle = agent.run("next question");
    await handle.result;

    // Model input: the aged assistant+tool pair collapsed into a stub user line.
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    const promptJson = JSON.stringify(prompt);
    expect(promptJson).toContain("first question");
    expect(promptJson).toContain("[tool_call tc-1] lookup \u2192 succeeded");
    expect(promptJson).not.toContain('"tool-call"');

    // Persisted thread: the ORIGINAL pair is intact.
    const thread = agent.getMessages();
    expect(thread.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(thread[1]?.content)).toContain("tool-call");
    expect(JSON.stringify(thread[2]?.content)).toContain("found");
  });

  it("strips delete snapshots at the model boundary but keeps them in the thread", async () => {
    const messages: SessionMessage[] = [
      sess({ role: "user", content: "delete Rome" }, 1),
      sess(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "ds-1",
              toolName: "delete_world",
              input: { id: "w-9" },
            },
          ],
        },
        2,
      ),
      sess(
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "ds-1",
              toolName: "delete_world",
              output: {
                type: "json",
                value: {
                  deleted: true,
                  id: "w-9",
                  snapshot: { name: "Rome", description: "pages of prose" },
                },
              },
            },
          ],
        },
        3,
      ),
    ];
    const { store } = createStore({ messages });
    const model = replyModel("deleted");
    const agent = await makeAgent(model, store); // default policy: compaction off

    const handle = agent.run("continue");
    await handle.result;

    // Model never sees the snapshot prose, only the compact echo.
    const promptJson = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(promptJson).toContain("Rome");
    expect(promptJson).not.toContain("snapshot");
    expect(promptJson).not.toContain("pages of prose");

    // The persisted thread keeps the full snapshot for the UI / context_read.
    const pair = agent.findToolPair("ds-1");
    expect(pair).toBeDefined();
    expect(JSON.stringify(pair?.result.output)).toContain("snapshot");
    expect(JSON.stringify(agent.getMessages()[2]?.content)).toContain("pages of prose");
  });
});

// ─── run(): multimodal content (ADR-0044 P2 — D3/D4/D9) ──────────────────

describe("Agent.run multimodal content", () => {
  /** Encode `text` as a base64 data URL (multi-byte UTF-8 safe). */
  function textAttachmentDataUrl(text: string, mime = "text/markdown"): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:${mime};base64,${btoa(binary)}`;
  }

  /**
   * Structural view of a provider prompt for exact text-part assertions
   * (JSON.stringify escapes quotes — containment on serialized strings is
   * brittle; comparing the decoded part text is exact).
   */
  type PromptMessage = {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };

  function promptTextsAt(prompt: PromptMessage[], index: number): string[] {
    const content = prompt[index]?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    );
  }

  /** Aged tool thread for the compaction + inputLength regression below. */
  function agedToolThread(): SessionMessage[] {
    return [
      sess({ role: "user", content: "first question" }, 1),
      sess(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-mm",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
        },
        2,
      ),
      sess(
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc-mm",
              toolName: "lookup",
              output: { type: "text", value: "found" },
            },
          ],
        },
        3,
      ),
    ];
  }

  it("lands parts-array user content verbatim in the thread; the model receives the text sentinel and the raw image", async () => {
    const pngB64 = btoa("FAKEPNGBYTES");
    const content: UserContent = [
      { type: "text", text: "look at these" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "sunset.png",
        data: `data:image/png;base64,${pngB64}`,
      },
      {
        type: "file",
        mediaType: "text/markdown",
        filename: "notes.md",
        data: textAttachmentDataUrl("# Title\nbody"),
      },
    ];
    const { store } = createStore();
    const model = replyModel("ok");
    const agent = await makeAgent(model, store);

    const handle = agent.run(content);
    await handle.result;

    // Persisted Thread: the user message content is the parts array VERBATIM.
    const thread = agent.getMessages();
    const userMsg = thread[0];
    if (userMsg?.role !== "user") throw new Error("expected user message");
    expect(userMsg.content).toEqual(content);

    // Derived Model Input: the text file became a sentinel TextPart; the
    // image passed through untouched (imageInputSupported absent = unknown).
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(promptTextsAt(prompt, 1)).toContain(
      '<attachment filename="notes.md" mime="text/markdown">\n# Title\nbody\n</attachment>',
    );
    expect(JSON.stringify(prompt)).not.toContain("data:text/markdown");
    expect(JSON.stringify(prompt)).toContain(pngB64);
  });

  it("downgrades image parts when imageInputSupported is explicitly false", async () => {
    const pngB64 = btoa("SECRETIMAGEBYTES");
    const content: UserContent = [
      { type: "text", text: "describe this" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "sunset.png",
        data: `data:image/png;base64,${pngB64}`,
      },
    ];
    const { store } = createStore();
    const model = replyModel("a sunset");
    const agent = await makeAgent(model, store);

    const handle = agent.run(content, { imageInputSupported: false });
    await handle.result;

    // The model sees the downgrade marker, never the image payload.
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(promptTextsAt(prompt, 1)).toContain(
      '[image attachment: "sunset.png" — image content NOT delivered: the bound model does not accept image input]',
    );
    expect(JSON.stringify(prompt)).not.toContain(pngB64);

    // The Persisted Thread keeps the original image FilePart (source of truth).
    const userMsg = agent.getMessages()[0];
    if (userMsg?.role !== "user") throw new Error("expected user message");
    expect(userMsg.content).toEqual(content);
  });

  it("passes image parts through when imageInputSupported is true", async () => {
    const pngB64 = btoa("FAKEPNGBYTES");
    const content: UserContent = [
      {
        type: "file",
        mediaType: "image/png",
        filename: "sunset.png",
        data: `data:image/png;base64,${pngB64}`,
      },
    ];
    const { store } = createStore();
    const model = replyModel("ok");
    const agent = await makeAgent(model, store);

    await agent.run(content, { imageInputSupported: true }).result;

    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(pngB64);
  });

  it("slices the delta correctly when attachments and compaction reshape the input (inputLength regression)", async () => {
    const content: UserContent = [
      { type: "text", text: "check these" },
      {
        type: "file",
        mediaType: "text/plain",
        filename: "lines.txt",
        data: textAttachmentDataUrl("alpha\nbeta", "text/plain"),
      },
    ];
    const { store, appendCalls } = createStore({ messages: agedToolThread() });
    const model = replyModel("answer");
    const agent = await makeAgent(model, store, {
      compactionPolicy: { enabled: true, turnAge: 1 },
    });

    const handle = agent.run(content);
    const result = await handle.result;
    expect(result.finishReason).toBe("stop");

    // Input reshaped: aged pair compacted to a stub user line + the new user
    // message with the inlined sentinel. The aged turn's ORIGINAL user
    // message survives (only the assistant+tool pair collapses), so the
    // prompt is system + 3 user messages. Count changes come ONLY from
    // compaction (before the inputLength snapshot); the part-mapping
    // transforms preserve the count.
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
    ]);
    expect(promptTextsAt(prompt, 2)).toContain(
      "[tool_call tc-mm] lookup \u2192 succeeded",
    );
    expect(promptTextsAt(prompt, 3)).toContain(
      '<attachment filename="lines.txt" mime="text/plain">\nalpha\nbeta\n</attachment>',
    );

    // inputLength invariant: the persisted delta is EXACTLY the run's new
    // assistant message — no reshaped user message ever leaks into it.
    expect(appendCalls[1]?.delta).toHaveLength(1);
    expect(appendCalls[1]?.delta[0]?.role).toBe("assistant");
    expect(agent.getMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
  });
});

// ─── setPlan ──────────────────────────────────────────────────────────────

describe("Agent.setPlan", () => {
  it("sets the plan synchronously and persists it via savePlan", async () => {
    const { store, savePlanCalls } = createStore();
    const agent = await makeAgent(replyModel("ok"), store);

    const plan: Plan = { items: [{ text: "new plan", status: "in_progress" }] };
    await agent.setPlan(plan);

    expect(agent.getPlan()).toBe(plan);
    await vi.waitFor(() => expect(savePlanCalls).toHaveLength(1));
    expect(savePlanCalls[0]?.sessionId).toBe(SID);
    expect(savePlanCalls[0]?.plan).toBe(plan);
  });
});

// ─── findToolPair (ADR-0031 §5 — context_read backing) ────────────────────

describe("Agent.findToolPair", () => {
  it("returns the original call + result pair from the persisted thread", async () => {
    const { store } = createStore({
      messages: [
        sess({ role: "user", content: "q" }, 1),
        sess(
          {
            role: "assistant",
            content: [
              { type: "text", text: "checking" },
              {
                type: "tool-call",
                toolCallId: "tc-9",
                toolName: "lookup",
                input: { q: "y" },
              },
            ],
          },
          2,
        ),
        sess(
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "tc-9",
                toolName: "lookup",
                output: { type: "text", value: "found" },
              },
            ],
          },
          3,
        ),
      ],
    });
    const agent = await makeAgent(replyModel("ok"), store);

    const pair = agent.findToolPair("tc-9");
    expect(pair).toBeDefined();
    expect(pair?.call).toMatchObject({
      type: "tool-call",
      toolCallId: "tc-9",
      toolName: "lookup",
    });
    expect(pair?.result).toMatchObject({
      type: "tool-result",
      toolCallId: "tc-9",
      toolName: "lookup",
      output: { type: "text", value: "found" },
    });
  });

  it("returns undefined for an unknown toolCallId", async () => {
    const { store } = createStore();
    const agent = await makeAgent(replyModel("ok"), store);
    expect(agent.findToolPair("does-not-exist")).toBeUndefined();
  });

  it("returns undefined when the call has no matching result yet", async () => {
    const { store } = createStore({
      messages: [
        sess(
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "no-res",
                toolName: "lookup",
                input: {},
              },
            ],
          },
          1,
        ),
      ],
    });
    const agent = await makeAgent(replyModel("ok"), store);
    expect(agent.findToolPair("no-res")).toBeUndefined();
  });
});

// ─── Persist error routing ────────────────────────────────────────────────

describe("Agent persist error routing", () => {
  it("routes a failing appendMessages to onPersistError and the run still resolves", async () => {
    const ctx = createStore();
    const onPersistError = vi.fn();
    const agent = await makeAgent(replyModel("fine"), ctx.store, { onPersistError });

    // The FIRST append (user message) rejects; the second (delta) succeeds.
    ctx.failNextAppend();

    const handle = agent.run("hi");
    const result = await handle.result;
    expect(result.finishReason).toBe("stop");

    // Failure was routed to the callback, never thrown.
    await vi.waitFor(() => expect(onPersistError).toHaveBeenCalledTimes(1));
    expect(onPersistError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    // The delta append still went through, and the in-memory thread is intact.
    expect(ctx.appendCalls).toHaveLength(1);
    expect(ctx.appendCalls[0]?.delta[0]?.role).toBe("assistant");
    expect(agent.getMessages().map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

// ─── Concurrent-turn guard (no side effects on ConfigError) ───────────────

describe("Agent concurrent-turn guard", () => {
  it("leaves the thread and store untouched when the loop rejects a second run", async () => {
    const ctx = createStore();
    const agent = await makeAgent(replyModel("slow reply", 100), ctx.store);

    const first = agent.run("first");
    expect(() => agent.run("second")).toThrowError(ConfigError);

    // Only "first" was committed — no "second" user message anywhere.
    expect(ctx.appendCalls).toHaveLength(1);
    expect(ctx.appendCalls[0]?.delta[0]).toMatchObject({ role: "user", content: "first" });
    expect(agent.getMessages().map((m) => m.role)).toEqual(["user"]);

    // Abort the in-flight run; it produced no output → still exactly one append.
    first.abort();
    const result = await first.result;
    expect(result.finishReason).toBe("aborted");
    expect(ctx.appendCalls).toHaveLength(1);
    expect(ctx.state.messages).toHaveLength(1);
  });
});
