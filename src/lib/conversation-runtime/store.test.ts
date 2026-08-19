/**
 * Conversation runtime store tests — draft attachments (ADR-0044 §D8):
 * add/remove/cap/clear-on-send + per-conversation independence, and the
 * widened `send` forwarding `UserContent` + the per-run `imageInputSupported`
 * (ADR-0044 §D9 step 2) to `Agent.run`.
 *
 * The heavy collaborators are mocked at their module boundaries
 * (`@/lib/ai`, `@/lib/ai-store`, `@/lib/ai-roles`, `@/api/conversation`,
 * `@/lib/notify`, `@/lib/logger`); the store under test is REAL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserContent } from "ai";

import {
  createConversationRuntimeStore,
  MAX_DRAFT_ATTACHMENTS,
  type DraftAttachment,
  type ModelResolver,
  type PersistErrorHandler,
} from "./store";
import type { LanguageModel } from "@/lib/ai";
import { conversationSchema, spaceIdSchema, type Conversation } from "@/types";

// ─── Module mocks ──────────────────────────────────────────────────────────

/**
 * The mocked `@/lib/ai` Agent surface. `run` captures the outgoing content
 * + options; `getMessages` feeds finalization (empty ⇒ no auto-title).
 */
const agentMocks = vi.hoisted(() => ({
  run: vi.fn(),
  getMessages: vi.fn(() => []),
}));

vi.mock("@/lib/ai", () => ({
  AgentLoop: vi.fn(),
  Agent: {
    open: vi.fn(async () => ({
      run: agentMocks.run,
      getMessages: agentMocks.getMessages,
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

/** Flush pending promise callbacks (run finalization is a `.then` chain). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  agentMocks.run.mockReset();
  agentMocks.getMessages.mockReset();
  agentMocks.getMessages.mockReturnValue([]);
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
