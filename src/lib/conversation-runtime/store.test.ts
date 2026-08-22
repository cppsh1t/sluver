/**
 * Conversation runtime store tests — draft attachments (ADR-0044 §D8):
 * add/remove/cap/clear-on-send + per-conversation independence, and the
 * widened `send` forwarding `UserContent` + the per-run `imageInputSupported`
 * (ADR-0044 §D9 step 2) to `Agent.run`.
 *
 * Plus the user-initiated message mutations (ADR-0047): `deleteMessage`
 * (pair expansion, view filtering, usage pruning, scoped `lastTurnUsage`
 * invalidation, in-flight guard, durable-first IPC failure) and
 * `editMessage` (in-place edit: raw-body surgery preserving
 * `attachment://` refs, durable-first, in-flight guard, memory/DB drift).
 *
 * The heavy collaborators are mocked at their module boundaries
 * (`@/lib/ai`, `@/lib/ai-store`, `@/lib/ai-roles`, `@/api/conversation`,
 * `@/lib/notify`, `@/lib/logger`); the store under test is REAL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelUsage, ModelMessage, UserContent } from "ai";

import {
  createConversationRuntimeStore,
  MAX_DRAFT_ATTACHMENTS,
  type ConversationView,
  type DraftAttachment,
  type ModelResolver,
  type PersistErrorHandler,
} from "./store";
import type { LanguageModel, SessionMessage } from "@/lib/ai";
import {
  deleteMessages as deleteMessagesIpc,
  loadMessages as loadMessagesIpc,
  updateMessage as updateMessageIpc,
} from "@/api/conversation";
import {
  conversationSchema,
  spaceIdSchema,
  type Conversation,
  type Message,
} from "@/types";

// ─── Module mocks ──────────────────────────────────────────────────────────

/**
 * The mocked `@/lib/ai` Agent surface. `run` captures the outgoing content
 * + options; `getMessages` feeds finalization (empty ⇒ no auto-title);
 * `removeMessages` / `replaceMessage` back ADR-0047 mutations (tests wire
 * them to a local `thread` array so the view refresh reflects the change).
 */
const agentMocks = vi.hoisted(() => ({
  run: vi.fn(),
  getMessages: vi.fn((): SessionMessage[] => []),
  removeMessages: vi.fn(),
  replaceMessage: vi.fn(),
}));

vi.mock("@/lib/ai", () => ({
  AgentLoop: vi.fn(),
  Agent: {
    open: vi.fn(async () => ({
      run: agentMocks.run,
      getMessages: agentMocks.getMessages,
      removeMessages: agentMocks.removeMessages,
      replaceMessage: agentMocks.replaceMessage,
    })),
  },
}));

vi.mock("@/lib/ai-store", () => ({
  TauriSessionStore: class TauriSessionStore {},
}));

vi.mock("@/lib/ai-roles", () => ({
  getRoleBehavior: vi.fn(() => ({
    systemPrompt: "stub role prompt",
    maxSteps: 3,
    buildTools: () => ({}),
  })),
}));

vi.mock("@/lib/ai/agent-logging", () => ({
  createAgentEventLogger: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/notify", () => ({
  notifyToolConsentRequested: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/api/conversation", () => ({
  loadMessages: vi.fn(async () => []),
  // ADR-0047 — message-mutation IPC (durable-first).
  deleteMessages: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────

const WORLD_ID = "w1";
const NOW = "2026-01-01T00:00:00.000Z";
const SPACE_ID = spaceIdSchema.parse("space-1");

function makeConversation(id: string): Conversation {
  return conversationSchema.parse({
    id,
    agentConfigName: "explorer",
    title: null,
    meta: { kind: "world" },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function draft(id: string): DraftAttachment {
  return {
    id,
    kind: "image",
    mime: "image/png",
    filename: `${id}.png`,
    sizeBytes: 8,
    dataUrl: `data:image/png;base64,${id}`,
  };
}

const stubModel = {} as unknown as LanguageModel;

/** A ready resolver — constructs the (mocked) Agent on first send/ensure. */
const readyResolver: ModelResolver = () => ({
  status: "ready",
  model: stubModel,
  autoExecuteDangerousTools: false,
  shellToolEnabled: false,
  contextCompaction: { enabled: false, turnAge: 3 },
  systemPrompt: "",
  skills: [],
  visionConfig: null,
});

/** A loading resolver — seeds the slot WITHOUT constructing an Agent. */
const loadingResolver: ModelResolver = () => ({ status: "loading" });

const noopPersistError: PersistErrorHandler = () => {};
const noopAutoTitle = vi.fn(async () => null);
const visionYes = vi.fn(() => true);
const visionNo = vi.fn(() => false);
const visionUnknown = vi.fn(() => undefined);

let runCounter = 0;
function makeRunHandle() {
  runCounter += 1;
  return {
    runId: `run-${runCounter}`,
    subscribe: vi.fn(() => vi.fn()),
    abort: vi.fn(),
    result: Promise.resolve({
      finishReason: "stop",
      totalUsage: { inputTokens: 7, outputTokens: 3 },
      steps: [{ usage: { inputTokens: 7 } }],
    }),
  };
}

function viewOf(store: ReturnType<typeof createConversationRuntimeStore>, convId: string) {
  const view = store.getState().worlds.get(WORLD_ID)?.get(convId)?.view;
  if (!view) throw new Error(`no view for ${convId}`);
  return view;
}

/**
 * Patch one conversation's view directly — the vanilla-store escape hatch
 * for seeding state only run finalization would produce (e.g.
 * `lastTurnUsage`) or simulating an in-flight run (`isRunning`).
 */
function patchView(
  store: ReturnType<typeof createConversationRuntimeStore>,
  convId: string,
  patch: Partial<ConversationView>,
): void {
  store.setState((state) => {
    const worldMap = state.worlds.get(WORLD_ID);
    const data = worldMap?.get(convId);
    if (!worldMap || !data) return state;
    const nextWorldMap = new Map(worldMap);
    nextWorldMap.set(convId, { ...data, view: { ...data.view, ...patch } });
    const nextWorlds = new Map(state.worlds);
    nextWorlds.set(WORLD_ID, nextWorldMap);
    return { worlds: nextWorlds };
  });
}

/** Stamp a ModelMessage into a SessionMessage row of the seeded thread. */
function sess(id: string, message: ModelMessage): SessionMessage {
  return { ...message, id, sessionId: "conv-m", createdAt: NOW };
}

/** A complete AI SDK v7 `LanguageModelUsage` (details fields are required). */
function usage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokenDetails: {
      noCacheTokens: input,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: output,
      reasoningTokens: undefined,
    },
  };
}

/** Flush pending promise callbacks (run finalization is a `.then` chain). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  agentMocks.run.mockReset();
  agentMocks.getMessages.mockReset();
  agentMocks.getMessages.mockReturnValue([]);
  agentMocks.removeMessages.mockReset();
  agentMocks.replaceMessage.mockReset();
  runCounter = 0;
});

// ─── Draft attachments (ADR-0044 §D8) ──────────────────────────────────────

describe("draft attachments", () => {
  it("adds and removes attachments on the per-conversation view", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), loadingResolver, noopPersistError);

    store.getState().addDraftAttachments(WORLD_ID, "conv-1", [draft("a"), draft("b")]);
    expect(viewOf(store, "conv-1").draftAttachments.map((d) => d.id)).toEqual(["a", "b"]);

    store.getState().removeDraftAttachment(WORLD_ID, "conv-1", "a");
    expect(viewOf(store, "conv-1").draftAttachments.map((d) => d.id)).toEqual(["b"]);
  });

  it("enforces the count cap by ignoring overflow", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), loadingResolver, noopPersistError);

    // Fill to the cap exactly.
    const first = Array.from({ length: MAX_DRAFT_ATTACHMENTS }, (_, i) =>
      draft(`f${i}`),
    );
    store.getState().addDraftAttachments(WORLD_ID, "conv-1", first);
    expect(viewOf(store, "conv-1").draftAttachments).toHaveLength(
      MAX_DRAFT_ATTACHMENTS,
    );

    // The 9th is ignored.
    store.getState().addDraftAttachments(WORLD_ID, "conv-1", [draft("ninth")]);
    expect(viewOf(store, "conv-1").draftAttachments).toHaveLength(
      MAX_DRAFT_ATTACHMENTS,
    );
    expect(
      viewOf(store, "conv-1").draftAttachments.some((d) => d.id === "ninth"),
    ).toBe(false);
  });

  it("accepts only the fitting prefix of an oversized batch", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), loadingResolver, noopPersistError);

    // 5 staged + a batch of 5 → only 3 of the second batch fit.
    store
      .getState()
      .addDraftAttachments(
        WORLD_ID,
        "conv-1",
        Array.from({ length: 5 }, (_, i) => draft(`a${i}`)),
      );
    store
      .getState()
      .addDraftAttachments(
        WORLD_ID,
        "conv-1",
        Array.from({ length: 5 }, (_, i) => draft(`b${i}`)),
      );
    const ids = viewOf(store, "conv-1").draftAttachments.map((d) => d.id);
    expect(ids).toHaveLength(MAX_DRAFT_ATTACHMENTS);
    expect(ids).toEqual(["a0", "a1", "a2", "a3", "a4", "b0", "b1", "b2"]);
  });

  it("keeps each conversation's drafts independent (survives switches)", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), loadingResolver, noopPersistError);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-2"), loadingResolver, noopPersistError);

    store.getState().addDraftAttachments(WORLD_ID, "conv-1", [draft("one")]);
    store.getState().addDraftAttachments(WORLD_ID, "conv-2", [draft("two")]);
    expect(viewOf(store, "conv-1").draftAttachments.map((d) => d.id)).toEqual(["one"]);
    expect(viewOf(store, "conv-2").draftAttachments.map((d) => d.id)).toEqual(["two"]);
  });
});

// ─── send widening (UserContent + imageInputSupported) ─────────────────────

describe("send", () => {
  it("forwards UserContent + resolved imageInputSupported to agent.run and clears drafts", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), readyResolver, noopPersistError);
    await flush(); // let Agent.open + view patch settle

    store.getState().addDraftAttachments(WORLD_ID, "conv-1", [draft("a")]);
    agentMocks.run.mockReturnValue(makeRunHandle());

    const content: UserContent = [
      { type: "text", text: "看看这张图" },
      {
        type: "file",
        data: "data:image/png;base64,AAAA",
        mediaType: "image/png",
        filename: "示意图.png",
      },
    ];

    await store
      .getState()
      .send(
        WORLD_ID,
        "conv-1",
        content,
        readyResolver,
        noopPersistError,
        noopAutoTitle,
        visionYes,
      );
    await flush();

    expect(agentMocks.run).toHaveBeenCalledTimes(1);
    expect(agentMocks.run).toHaveBeenCalledWith(content, {
      imageInputSupported: true,
    });
    // Staged attachments left with the turn (§D8: clear happens in send).
    expect(viewOf(store, "conv-1").draftAttachments).toEqual([]);
    expect(viewOf(store, "conv-1").isRunning).toBe(false);
  });

  it("passes a catalog-confirmed false through (downgrade) and keeps strings working", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), readyResolver, noopPersistError);
    await flush();
    agentMocks.run.mockReturnValue(makeRunHandle());

    // Plain-string content — the historical form must keep compiling/working.
    await store
      .getState()
      .send(WORLD_ID, "conv-1", "继续", readyResolver, noopPersistError, noopAutoTitle, visionNo);
    await flush();

    expect(agentMocks.run).toHaveBeenCalledWith("继续", {
      imageInputSupported: false,
    });
  });

  it("passes undefined through unchanged when capability is unknown", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), readyResolver, noopPersistError);
    await flush();
    agentMocks.run.mockReturnValue(makeRunHandle());

    await store
      .getState()
      .send(WORLD_ID, "conv-1", "hi", readyResolver, noopPersistError, noopAutoTitle, visionUnknown);
    await flush();

    expect(agentMocks.run).toHaveBeenCalledWith("hi", {
      imageInputSupported: undefined,
    });
  });
});

// ─── User-initiated message mutations (ADR-0047) ───────────────────────────

/**
 * Bootstrap a conversation whose Agent thread backs onto a LOCAL `thread`
 * array: `getMessages` snapshots it, `removeMessages` filters it, and
 * `replaceMessage` swaps one row in place — so the store's post-durable
 * view refresh reflects the mutation exactly like the real Agent.
 */
async function seedMutationStore(
  convId: string,
  thread: SessionMessage[],
): Promise<ReturnType<typeof createConversationRuntimeStore>> {
  agentMocks.getMessages.mockImplementation(() => [...thread]);
  agentMocks.removeMessages.mockImplementation((ids: Set<string>) => {
    const dead = new Set(ids);
    // Mutate the caller's array in place — the local binding stays live.
    thread.splice(0, thread.length, ...thread.filter((m) => !dead.has(m.id)));
  });
  agentMocks.replaceMessage.mockImplementation(
    (id: string, next: SessionMessage) => {
      const idx = thread.findIndex((m) => m.id === id);
      if (idx === -1) return false;
      thread.splice(idx, 1, next);
      return true;
    },
  );
  const store = createConversationRuntimeStore(SPACE_ID);
  await store
    .getState()
    .ensureRuntime(WORLD_ID, makeConversation(convId), readyResolver, noopPersistError);
  await flush(); // let Agent.open + view patch settle
  return store;
}

/** A two-turn thread whose second assistant turn carries a tool pair. */
function toolThread(): SessionMessage[] {
  return [
    sess("u1", { role: "user", content: "first question" }),
    sess("a1", { role: "assistant", content: "first answer" }),
    sess("u2", { role: "user", content: "second question" }),
    sess("a2", {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-call", toolCallId: "tc-9", toolName: "lookup", input: { q: "x" } },
      ],
    }),
    sess("t1", {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-9",
          toolName: "lookup",
          output: { type: "text", value: "found" },
        },
      ],
    }),
  ];
}

describe("deleteMessage", () => {
  it("deletes pair-expanded ids durably, filters the view, prunes usages, and clears lastTurnUsage when the deletion touches the last turn", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const lastTurnUsage = usage(10, 5);
    patchView(store, "conv-m", {
      lastTurnUsage,
      lastStepInputTokens: 42,
      messageUsages: {
        a1: { inputTokens: 3, outputTokens: 4 },
        a2: { inputTokens: 7, outputTokens: 8 },
      },
    });

    // Deleting the tool-carrying assistant takes its answering tool message.
    await store.getState().deleteMessage(WORLD_ID, "conv-m", "a2");

    expect(vi.mocked(deleteMessagesIpc)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteMessagesIpc)).toHaveBeenCalledWith(SPACE_ID, WORLD_ID, {
      conversationId: "conv-m",
      ids: ["a2", "t1"],
    });
    expect(viewOf(store, "conv-m").messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(viewOf(store, "conv-m").messageUsages).toEqual({
      a1: { inputTokens: 3, outputTokens: 4 },
    });
    // a2/t1 sit at/after the last user message (u2) → last-turn annotation dies.
    expect(viewOf(store, "conv-m").lastTurnUsage).toBeUndefined();
    expect(viewOf(store, "conv-m").lastStepInputTokens).toBeUndefined();
  });

  it("preserves lastTurnUsage when deleting a mid-thread message before the last user message", async () => {
    const thread = toolThread().slice(0, 4); // u1, a1, u2, a2 — no tool row
    const store = await seedMutationStore("conv-m", thread);
    const lastTurnUsage = usage(10, 5);
    patchView(store, "conv-m", { lastTurnUsage, lastStepInputTokens: 42 });

    // a1 precedes the last user message (u2) → the annotation stays accurate.
    await store.getState().deleteMessage(WORLD_ID, "conv-m", "a1");

    expect(vi.mocked(deleteMessagesIpc)).toHaveBeenCalledWith(SPACE_ID, WORLD_ID, {
      conversationId: "conv-m",
      ids: ["a1"],
    });
    expect(viewOf(store, "conv-m").messages.map((m) => m.id)).toEqual(["u1", "u2", "a2"]);
    expect(viewOf(store, "conv-m").lastTurnUsage).toBe(lastTurnUsage);
    expect(viewOf(store, "conv-m").lastStepInputTokens).toBe(42);
  });

  it("no-ops while a run is in flight: resolves, no IPC, view untouched", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    patchView(store, "conv-m", { isRunning: true });

    await store.getState().deleteMessage(WORLD_ID, "conv-m", "a2");

    expect(vi.mocked(deleteMessagesIpc)).not.toHaveBeenCalled();
    expect(agentMocks.removeMessages).not.toHaveBeenCalled();
    const after = viewOf(store, "conv-m");
    expect(after.messages).toBe(before.messages);
    expect(after.messageUsages).toBe(before.messageUsages);
  });

  it("rejects on IPC failure and leaves memory untouched (durable-first)", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    vi.mocked(deleteMessagesIpc).mockRejectedValueOnce(new Error("ipc down"));

    await expect(
      store.getState().deleteMessage(WORLD_ID, "conv-m", "u2"),
    ).rejects.toThrow("ipc down");

    expect(agentMocks.removeMessages).not.toHaveBeenCalled();
    const after = viewOf(store, "conv-m");
    expect(after.messages).toBe(before.messages);
    expect(after.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "t1"]);
  });

  it("skips the in-memory removal when a run starts inside the IPC window (TOCTOU): durable delete stands, memory untouched", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    // The IPC mock flips the runtime to running BEFORE resolving — a
    // `send` interleaving inside the await window.
    vi.mocked(deleteMessagesIpc).mockImplementationOnce(async () => {
      patchView(store, "conv-m", { isRunning: true });
    });

    await store.getState().deleteMessage(WORLD_ID, "conv-m", "a2");

    expect(vi.mocked(deleteMessagesIpc)).toHaveBeenCalledTimes(1);
    expect(agentMocks.removeMessages).not.toHaveBeenCalled();
    const after = viewOf(store, "conv-m");
    expect(after.messages).toBe(before.messages);
    expect(after.messageUsages).toBe(before.messageUsages);
  });
});

describe("editMessage", () => {
  /** Build raw `load_messages` rows (body = the persisted ModelMessage JSON). */
  function rawRows(...rows: Array<{ id: string; body: ModelMessage }>): Message[] {
    return rows.map((r) => ({
      id: r.id,
      conversationId: "conv-m",
      body: r.body,
      createdAt: NOW,
    }));
  }

  it("edits a user string message durably and in memory; nothing re-runs", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    vi.mocked(loadMessagesIpc).mockResolvedValue(
      rawRows({ id: "u1", body: { role: "user", content: "first question" } }),
    );

    const ok = await store
      .getState()
      .editMessage(WORLD_ID, "conv-m", "u1", null, "new text");

    expect(ok).toBe(true);
    expect(vi.mocked(updateMessageIpc)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessageIpc)).toHaveBeenCalledWith(SPACE_ID, WORLD_ID, {
      conversationId: "conv-m",
      id: "u1",
      body: { role: "user", content: "new text" },
    });
    // View reflects the edited text; the rest of the thread is intact.
    const messages = viewOf(store, "conv-m").messages;
    expect(messages[0]).toMatchObject({ id: "u1", role: "user", content: "new text" });
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "t1"]);
    // In-place edit — no run was kicked off, nothing deleted.
    expect(agentMocks.run).not.toHaveBeenCalled();
    expect(vi.mocked(deleteMessagesIpc)).not.toHaveBeenCalled();
  });

  it("performs raw-body surgery: the IPC body preserves the attachment:// file part AND carries the edited text part", async () => {
    // In-memory a2: hydrated shape (text + tool-call). The RAW row carries
    // an `attachment://` file part the hydrated copy no longer has.
    const store = await seedMutationStore("conv-m", toolThread());
    vi.mocked(loadMessagesIpc).mockResolvedValue(
      rawRows({
        id: "a2",
        body: {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "file",
              mediaType: "image/png",
              filename: "chart.png",
              data: "attachment://a1",
            },
          ],
        },
      }),
    );

    const ok = await store
      .getState()
      .editMessage(WORLD_ID, "conv-m", "a2", 0, "edited prose");

    expect(ok).toBe(true);
    expect(vi.mocked(updateMessageIpc)).toHaveBeenCalledWith(SPACE_ID, WORLD_ID, {
      conversationId: "conv-m",
      id: "a2",
      // The persisted body keeps the raw file part verbatim while the
      // targeted text part (index 0) carries the edit.
      body: {
        role: "assistant",
        content: [
          { type: "text", text: "edited prose" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "chart.png",
            data: "attachment://a1",
          },
        ],
      },
    });
    // The in-memory view was replaced with the hydrated-shape edit (the
    // in-memory copy's own content, tool-call part included).
    const a2 = viewOf(store, "conv-m").messages.find((m) => m.id === "a2");
    expect(a2).toMatchObject({
      id: "a2",
      role: "assistant",
      content: [
        { type: "text", text: "edited prose" },
        { type: "tool-call", toolCallId: "tc-9", toolName: "lookup", input: { q: "x" } },
      ],
    });
  });

  it("resolves false without IPC while a run is in flight", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    patchView(store, "conv-m", { isRunning: true });

    const ok = await store
      .getState()
      .editMessage(WORLD_ID, "conv-m", "u2", null, "edited question");

    expect(ok).toBe(false);
    expect(vi.mocked(updateMessageIpc)).not.toHaveBeenCalled();
    expect(agentMocks.replaceMessage).not.toHaveBeenCalled();
    const after = viewOf(store, "conv-m");
    expect(after.messages).toBe(before.messages);
  });

  it("rejects on IPC failure and leaves memory untouched (durable-first)", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    vi.mocked(loadMessagesIpc).mockResolvedValue(
      rawRows({ id: "u2", body: { role: "user", content: "second question" } }),
    );
    vi.mocked(updateMessageIpc).mockRejectedValueOnce(new Error("ipc down"));

    await expect(
      store.getState().editMessage(WORLD_ID, "conv-m", "u2", null, "edited"),
    ).rejects.toThrow("ipc down");

    expect(agentMocks.replaceMessage).not.toHaveBeenCalled();
    const after = viewOf(store, "conv-m");
    expect(after.messages).toBe(before.messages);
    expect(after.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "t1"]);
  });

  it("resolves false when the raw row is missing (memory/DB drift): no update, memory unchanged", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    // Rows come back WITHOUT the target id.
    vi.mocked(loadMessagesIpc).mockResolvedValue(
      rawRows({ id: "u1", body: { role: "user", content: "first question" } }),
    );

    const ok = await store
      .getState()
      .editMessage(WORLD_ID, "conv-m", "u2", null, "edited");

    expect(ok).toBe(false);
    expect(vi.mocked(updateMessageIpc)).not.toHaveBeenCalled();
    expect(agentMocks.replaceMessage).not.toHaveBeenCalled();
    const after = viewOf(store, "conv-m");
    expect(after.messages).toBe(before.messages);
  });

  it("resolves false when a run starts during the raw-row load (TOCTOU pre-write): no durable write", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    vi.mocked(loadMessagesIpc).mockImplementationOnce(async () => {
      patchView(store, "conv-m", { isRunning: true });
      return rawRows({ id: "u2", body: { role: "user", content: "second question" } });
    });

    const ok = await store
      .getState()
      .editMessage(WORLD_ID, "conv-m", "u2", null, "edited");

    expect(ok).toBe(false);
    expect(vi.mocked(updateMessageIpc)).not.toHaveBeenCalled();
    expect(agentMocks.replaceMessage).not.toHaveBeenCalled();
    expect(viewOf(store, "conv-m").messages).toBe(before.messages);
  });

  it("resolves true but skips the in-memory swap when a run starts during the durable write (TOCTOU post-write)", async () => {
    const store = await seedMutationStore("conv-m", toolThread());
    const before = viewOf(store, "conv-m");
    vi.mocked(loadMessagesIpc).mockResolvedValue(
      rawRows({ id: "u2", body: { role: "user", content: "second question" } }),
    );
    vi.mocked(updateMessageIpc).mockImplementationOnce(async () => {
      patchView(store, "conv-m", { isRunning: true });
    });

    const ok = await store
      .getState()
      .editMessage(WORLD_ID, "conv-m", "u2", null, "edited");

    // The durable edit committed — true — but the Agent thread was NOT
    // touched mid-run; the view keeps the pre-edit shape until the next
    // runtime resolve re-syncs memory with the DB.
    expect(ok).toBe(true);
    expect(vi.mocked(updateMessageIpc)).toHaveBeenCalledTimes(1);
    expect(agentMocks.replaceMessage).not.toHaveBeenCalled();
    expect(viewOf(store, "conv-m").messages).toBe(before.messages);
  });
});
