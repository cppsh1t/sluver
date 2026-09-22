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
 * Plus the subagent dispatch runtime (ADR-0050 D2/D3/D4): hidden run
 * conversation creation with parent linkage, the shared event path driving
 * the child, the DispatchResult contract mapping (completed / unconfigured
 * / loading-retry), parent-abort cascade → "aborted", and per-child stop →
 * "stopped" via the abort-reason channel.
 *
 * Plus the chapter anchor context injection: a `kind === "chapter"`
 * conversation's Agent system prompt gains a `<chapter_context>` block
 * (chapterId + title from a mocked `getChapter`), world-kind conversations
 * gain nothing, and a rejecting `getChapter` degrades to a block-less but
 * fully runnable Agent.
 *
 * Plus the cached-Agent config revalidation (ADR-0023): a cached Agent is
 * reused while its config fingerprint is unchanged, rebuilt when it changes
 * and the slot is idle, kept while a run is in flight, and a removed config
 * surfaces MODEL_NOT_CONFIGURED without dropping the cached Agent.
 *
 * The heavy collaborators are mocked at their module boundaries
 * (`@/lib/ai`, `@/lib/ai-store`, `@/lib/ai-roles`, `@/api/conversation`,
 * `@/api/novel`, `@/lib/notify`, `@/lib/logger`); the store under test is
 * REAL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelUsage, ModelMessage, UserContent } from "ai";

import {
  createConversationRuntimeStore,
  MAX_DRAFT_ATTACHMENTS,
  type AutoTitleCallback,
  type ConversationView,
  type DraftAttachment,
  type ModelResolver,
  type PersistErrorHandler,
} from "./store";
import {
  Agent,
  AgentLoop,
  type AgentLoopRunResult,
  type LanguageModel,
  type SessionMessage,
} from "@/lib/ai";
import type { SubagentRunner, ToolContext } from "@/lib/tools/types";
import {
  createConversation as createConversationIpc,
  deleteMessages as deleteMessagesIpc,
  loadMessages as loadMessagesIpc,
  updateMessage as updateMessageIpc,
} from "@/api/conversation";
import { getChapter } from "@/api/novel";
import { logger } from "@/lib/logger";
import {
  chapterIdSchema,
  chapterSchema,
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
 * `contexts` captures every ToolContext handed to the (registry-mocked)
 * `buildTools` — the dispatch tests reach the live SubagentRunner through
 * the Orchestrator conversation's captured context.
 */
const agentMocks = vi.hoisted(() => ({
  run: vi.fn(),
  getMessages: vi.fn((): SessionMessage[] => []),
  removeMessages: vi.fn(),
  replaceMessage: vi.fn(),
  contexts: [] as ToolContext[],
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
  // Name-aware: "orchestrator" is the (only) conversational role and gets
  // the live dispatch runner; every other name is a subagent kind and gets
  // the throwing stub — mirroring the real registry's kind split so the
  // store's runner wiring is exercised exactly as in production.
  getRoleDefinition: vi.fn((name: string) => ({
    name,
    kind: name === "orchestrator" ? "conversational" : "subagent",
    systemPrompt: "stub role prompt",
    maxSteps: 3,
    buildTools: (ctx: ToolContext) => {
      agentMocks.contexts.push(ctx);
      return {};
    },
  })),
  buildSubagentRosterBlock: vi.fn(() => "<subagent_roster>stub</subagent_roster>"),
  // Identity passthrough — the stub prompt has no <context> block, and the
  // store tests assert structure, not prompt text.
  injectContextNote: vi.fn((prompt: string) => prompt),
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
  // ADR-0050 D2 — hidden subagent run creation (flat linkage fields).
  createConversation: vi.fn(),
}));

// Chapter context injection — only `getChapter` is on the store's import
// surface from `@/api/novel`; each test scripts its own outcome.
vi.mock("@/api/novel", () => ({
  getChapter: vi.fn(),
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────

const WORLD_ID = "w1";
const NOW = "2026-01-01T00:00:00.000Z";
const SPACE_ID = spaceIdSchema.parse("space-1");

function makeConversation(
  id: string,
  meta: Conversation["meta"] = { kind: "world" },
): Conversation {
  return conversationSchema.parse({
    id,
    agentConfigName: "orchestrator",
    title: null,
    meta,
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
  contextNote: "",
  maxSteps: null,
  skills: [],
  visionConfig: null,
  configSignature: "sig-default",
});

/**
 * A ready resolver with a specific config fingerprint — the ADR-0023
 * revalidation tests vary ONLY the signature to prove the cached-Agent
 * reuse/rebuild decision is driven by it.
 */
const signatureResolver =
  (signature: string): ModelResolver =>
  () => ({
    status: "ready",
    model: stubModel,
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    contextCompaction: { enabled: false, turnAge: 3 },
    contextNote: "",
    maxSteps: null,
    skills: [],
    visionConfig: null,
    configSignature: signature,
  });

/** An unconfigured resolver — every role reports "no model bound". */
const unconfiguredResolver: ModelResolver = () => ({
  status: "unconfigured",
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
  agentMocks.contexts.length = 0;
  runCounter = 0;
  vi.mocked(getChapter).mockReset();
  // Default createConversation: a valid kind=subagent row with a fresh id
  // (individual tests may override). Mirrors the Rust command's read-back.
  let convCounter = 0;
  vi.mocked(createConversationIpc).mockImplementation(
    async (_spaceId, _worldId, input) =>
      conversationSchema.parse({
        id: `run-conv-${++convCounter}`,
        agentConfigName: input.agentConfigName,
        title: null,
        meta: {
          kind: "subagent",
          parentConversationId: input.parentConversationId ?? "conv-parent",
          parentToolCallId: input.parentToolCallId ?? "tc-0",
          role: input.role ?? input.agentConfigName,
        },
        createdAt: NOW,
        updatedAt: NOW,
      }) satisfies Conversation,
  );
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
    const first = Array.from({ length: MAX_DRAFT_ATTACHMENTS }, (_, i) => draft(`f${i}`));
    store.getState().addDraftAttachments(WORLD_ID, "conv-1", first);
    expect(viewOf(store, "conv-1").draftAttachments).toHaveLength(MAX_DRAFT_ATTACHMENTS);

    // The 9th is ignored.
    store.getState().addDraftAttachments(WORLD_ID, "conv-1", [draft("ninth")]);
    expect(viewOf(store, "conv-1").draftAttachments).toHaveLength(MAX_DRAFT_ATTACHMENTS);
    expect(viewOf(store, "conv-1").draftAttachments.some((d) => d.id === "ninth")).toBe(false);
  });

  it("accepts only the fitting prefix of an oversized batch", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), loadingResolver, noopPersistError);

    // 5 staged + a batch of 5 → only 3 of the second batch fit.
    store.getState().addDraftAttachments(
      WORLD_ID,
      "conv-1",
      Array.from({ length: 5 }, (_, i) => draft(`a${i}`)),
    );
    store.getState().addDraftAttachments(
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
      .send(WORLD_ID, "conv-1", content, readyResolver, noopPersistError, noopAutoTitle, visionYes);
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
      .send(
        WORLD_ID,
        "conv-1",
        "hi",
        readyResolver,
        noopPersistError,
        noopAutoTitle,
        visionUnknown,
      );
    await flush();

    expect(agentMocks.run).toHaveBeenCalledWith("hi", {
      imageInputSupported: undefined,
    });
  });
});

// ─── Cached-Agent config revalidation (ADR-0023) ───────────────────────────

describe("cached-Agent config revalidation (ADR-0023)", () => {
  it("reuses the cached Agent while the config fingerprint is unchanged", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);

    // Same fingerprint → pure cache hit, no reconstruction.
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);
  });

  it("rebuilds an idle cached Agent when the fingerprint changes", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);

    // Config changed (e.g. provider swapped in Settings) + idle → rebuild.
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-b"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(2);
    expect(viewOf(store, "conv-1").error).toBeNull();
  });

  it("keeps the old Agent while a run is in flight; the rebuild lands once idle", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();

    // Simulate an in-flight run, then a config change: no swap mid-run.
    patchView(store, "conv-1", { isRunning: true });
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-b"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);

    // Run finished → idle again: the SAME changed config now rebuilds.
    patchView(store, "conv-1", { isRunning: false });
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-b"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(2);
  });

  it("surfaces MODEL_NOT_CONFIGURED when the config is removed, and clears it when the same config returns", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);

    // Config removed (credential deleted / model unbound) while idle.
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), unconfiguredResolver, noopPersistError);
    await flush();
    expect(viewOf(store, "conv-1").error?.code).toBe("MODEL_NOT_CONFIGURED");
    // The cached Agent is retained — no extra construction.
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);

    // Same config re-added → the stale banner dies, the cached Agent is
    // reused (fingerprint matches), still no extra construction.
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();
    expect(viewOf(store, "conv-1").error).toBeNull();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);
  });

  it("keeps the old Agent AND stays silent when the config is removed while a run is in flight", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();

    // Busy + unconfigured: cached Agent kept, NO error surfaced (the
    // in-flight run owns the view until it ends).
    patchView(store, "conv-1", { isRunning: true });
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-1"), unconfiguredResolver, noopPersistError);
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);
    expect(viewOf(store, "conv-1").error).toBeNull();
  });

  it("memoizes in-flight construction — a send racing a rebuild constructs exactly one Agent", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-a"),
        noopPersistError,
      );
    await flush();
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(1);

    // Fire a config-changed ensure AND a send BEFORE either can settle —
    // both land inside the reconstruction window. The memo must collapse
    // them into ONE Agent.open (two instances would each accept their own
    // run, interleaving persistence into the same session).
    agentMocks.run.mockReturnValue(makeRunHandle());
    const ensure = store
      .getState()
      .ensureRuntime(
        WORLD_ID,
        makeConversation("conv-1"),
        signatureResolver("sig-b"),
        noopPersistError,
      );
    const sent = store
      .getState()
      .send(
        WORLD_ID,
        "conv-1",
        "race",
        signatureResolver("sig-b"),
        noopPersistError,
        noopAutoTitle,
        visionUnknown,
      );
    await Promise.all([ensure, sent]);
    await flush();
    await flush();

    // Initial construction + exactly ONE rebuild; the run drove the
    // rebuilt Agent once.
    expect(vi.mocked(Agent.open)).toHaveBeenCalledTimes(2);
    expect(agentMocks.run).toHaveBeenCalledTimes(1);
    expect(viewOf(store, "conv-1").error).toBeNull();
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
  agentMocks.replaceMessage.mockImplementation((id: string, next: SessionMessage) => {
    const idx = thread.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    thread.splice(idx, 1, next);
    return true;
  });
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

    await expect(store.getState().deleteMessage(WORLD_ID, "conv-m", "u2")).rejects.toThrow(
      "ipc down",
    );

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

    const ok = await store.getState().editMessage(WORLD_ID, "conv-m", "u1", null, "new text");

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

    const ok = await store.getState().editMessage(WORLD_ID, "conv-m", "a2", 0, "edited prose");

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

    const ok = await store.getState().editMessage(WORLD_ID, "conv-m", "u2", null, "edited");

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

    const ok = await store.getState().editMessage(WORLD_ID, "conv-m", "u2", null, "edited");

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

    const ok = await store.getState().editMessage(WORLD_ID, "conv-m", "u2", null, "edited");

    // The durable edit committed — true — but the Agent thread was NOT
    // touched mid-run; the view keeps the pre-edit shape until the next
    // runtime resolve re-syncs memory with the DB.
    expect(ok).toBe(true);
    expect(vi.mocked(updateMessageIpc)).toHaveBeenCalledTimes(1);
    expect(agentMocks.replaceMessage).not.toHaveBeenCalled();
    expect(viewOf(store, "conv-m").messages).toBe(before.messages);
  });
});

// ─── Auto-title gating (ADR-0040 + ADR-0050 D2) ────────────────────────────

describe("auto-title gating", () => {
  /** Seed a store + completed run over a conversation with extractable user text. */
  async function runOnce(conv: Conversation, autoTitle: AutoTitleCallback): Promise<void> {
    agentMocks.getMessages.mockImplementation(() => [
      sess("u1", { role: "user", content: "first question" }),
      sess("a1", { role: "assistant", content: "first answer" }),
    ]);
    const store = createConversationRuntimeStore(SPACE_ID);
    await store.getState().ensureRuntime(WORLD_ID, conv, readyResolver, noopPersistError);
    await flush(); // let Agent.open + view patch settle
    agentMocks.run.mockReturnValue(makeRunHandle());
    await store
      .getState()
      .send(WORLD_ID, conv.id, "hi", readyResolver, noopPersistError, autoTitle, visionUnknown);
    await flush();
    await flush(); // run finalization is a .then chain
  }

  it("triggers autoTitle after the first completed run on an untitled world conversation", async () => {
    const autoTitle = vi.fn(async (_input: unknown) => "A Title");
    await runOnce(makeConversation("conv-t"), autoTitle);

    expect(autoTitle).toHaveBeenCalledTimes(1);
    expect(autoTitle).toHaveBeenCalledWith({
      worldId: WORLD_ID,
      conversationId: "conv-t",
      userText: "first question",
    });
  });

  it("skips autoTitle for kind=subagent conversations (hidden runs, ADR-0050 D2)", async () => {
    const autoTitle = vi.fn(async (_input: unknown) => "A Title");
    await runOnce(
      makeConversation("conv-run", {
        kind: "subagent",
        parentConversationId: "conv-parent",
        parentToolCallId: "tc-77",
        role: "writer",
      }),
      autoTitle,
    );

    expect(autoTitle).not.toHaveBeenCalled();
  });
});

// ─── Subagent dispatch runtime (ADR-0050 D2/D3/D4) ────────────────────────

/**
 * A scripted run handle: `result` resolves only when the test says so, and
 * `abort(reason)` delivers an `{type: "abort", reason}` event to every
 * subscriber — mimicking the real loop's reason propagation
 * (`AgentRunHandle.abort(reason)` → `AbortSignal.reason` → abort event) so
 * the dispatch runtime's source mapping is exercised faithfully.
 */
function makeScriptedHandle() {
  const listeners: Array<(event: unknown) => void> = [];
  let resolveResult!: (value: unknown) => void;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  return {
    runId: `run-${++runCounter}`,
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    abort: vi.fn((reason?: string) => {
      for (const listener of listeners) listener({ type: "abort", reason });
    }),
    result,
    resolveResult,
  };
}

/** Build a minimal AgentLoopRunResult for handle.result resolution. */
function runResult(
  finishReason: AgentLoopRunResult["finishReason"],
  messages: ModelMessage[],
  totalUsage: { inputTokens: number; outputTokens: number },
): AgentLoopRunResult {
  return {
    runId: "run-x",
    finishReason,
    messages,
    finalText: "",
    totalUsage: totalUsage as unknown as LanguageModelUsage,
    steps: [],
  };
}

/**
 * Seed a store + an Orchestrator conversation whose (mocked) buildTools
 * captured the live ToolContext — the dispatch tests drive
 * `ctx.subagentRunner`, the real production surface.
 */
async function seedOrchestrator(
  resolver: ModelResolver = readyResolver,
): Promise<{ store: ReturnType<typeof createConversationRuntimeStore>; runner: SubagentRunner }> {
  const store = createConversationRuntimeStore(SPACE_ID);
  await store
    .getState()
    .ensureRuntime(WORLD_ID, makeConversation("conv-parent"), resolver, noopPersistError);
  await flush(); // let Agent.open + view patch settle
  const ctx = agentMocks.contexts[agentMocks.contexts.length - 1];
  if (!ctx) throw new Error("no ToolContext captured — buildTools was not called");
  return { store, runner: ctx.subagentRunner };
}

describe("subagent dispatch runtime", () => {
  it("creates the hidden run conversation with parent linkage, drives the child with the task, and resolves the contract", async () => {
    const { store, runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);

    const promise = runner.run(
      { role: "writer", task: "write the scene", parentToolCallId: "tc-9" },
      new AbortController().signal,
    );
    await flush();

    // Hidden conversation created with the FLAT linkage fields (Rust builds
    // meta server-side) + the child Agent driven with the bare task brief.
    expect(vi.mocked(createConversationIpc)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createConversationIpc)).toHaveBeenCalledWith(SPACE_ID, WORLD_ID, {
      agentConfigName: "writer",
      kind: "subagent",
      parentConversationId: "conv-parent",
      parentToolCallId: "tc-9",
      role: "writer",
    });
    expect(agentMocks.run).toHaveBeenCalledTimes(1);
    expect(agentMocks.run).toHaveBeenCalledWith("write the scene", {});
    // The child got its own runtime slot and is live in it (shared event
    // path — its stream state is the drill-in surface).
    expect(store.getState().worlds.get(WORLD_ID)?.get("run-conv-1")?.view.isRunning).toBe(true);

    handle.resolveResult(
      runResult(
        "stop",
        [
          { role: "user", content: "write the scene" },
          { role: "assistant", content: "Scene written (812 words)." },
        ],
        { inputTokens: 11, outputTokens: 7 },
      ),
    );
    await flush();
    await flush();

    await expect(promise).resolves.toEqual({
      runId: "run-conv-1",
      status: "completed",
      finalMessage: "Scene written (812 words).",
      usage: { input: 11, output: 7 },
    });
    // Finalization settled the child slot.
    expect(store.getState().worlds.get(WORLD_ID)?.get("run-conv-1")?.view.isRunning).toBe(false);

    // The CHILD's ToolContext carries the dispatch STUB (D1 — subagents
    // never dispatch); calling it rejects loudly.
    expect(agentMocks.contexts.length).toBe(2); // parent + child
    const childCtx = agentMocks.contexts[1];
    await expect(
      childCtx.subagentRunner.run(
        { role: "scribe", task: "recursive dispatch" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("ADR-0050 D1");
  });

  it("returns unconfigured guidance WITHOUT creating a conversation when the child role's model is unbound (D6)", async () => {
    const unconfiguredWriter: ModelResolver = (role) =>
      role === "writer" ? { status: "unconfigured" } : readyResolver(role);
    const { runner } = await seedOrchestrator(unconfiguredWriter);

    const got = await runner.run(
      { role: "writer", task: "write the scene", parentToolCallId: "tc-1" },
      new AbortController().signal,
    );

    expect(got.runId).toBeNull();
    expect(got.status).toBe("unconfigured");
    expect(got.finalMessage).toContain("writer");
    expect(got.usage).toEqual({ input: 0, output: 0 });
    expect(vi.mocked(createConversationIpc)).not.toHaveBeenCalled();
    expect(agentMocks.run).not.toHaveBeenCalled();
  });

  it("retries a transient loading resolution and proceeds once the config lands", async () => {
    let writerCalls = 0;
    const slowResolver: ModelResolver = (role) => {
      if (role === "writer") {
        writerCalls += 1;
        return writerCalls <= 1 ? { status: "loading" } : readyResolver(role);
      }
      return readyResolver(role);
    };
    const { runner } = await seedOrchestrator(slowResolver);
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);

    const promise = runner.run(
      { role: "writer", task: "write the scene", parentToolCallId: "tc-2" },
      new AbortController().signal,
    );
    await flush();
    // Still polling — no conversation yet after the first microtask flush.
    expect(vi.mocked(createConversationIpc)).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 200)); // > one poll interval
    expect(vi.mocked(createConversationIpc)).toHaveBeenCalledTimes(1);
    handle.resolveResult(
      runResult("stop", [{ role: "assistant", content: "done" }], {
        inputTokens: 1,
        outputTokens: 1,
      }),
    );
    await expect(promise).resolves.toMatchObject({ status: "completed" });
  });

  it("maps an errored child run to status error with the AgentError description", async () => {
    const { runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);
    const promise = runner.run(
      { role: "curator", task: "tidy the worldbook", parentToolCallId: "tc-3" },
      new AbortController().signal,
    );
    await flush();

    const errored = runResult("error", [], { inputTokens: 2, outputTokens: 0 });
    (errored as { error?: unknown }).error = {
      code: "PROVIDER_ERROR",
      message: "upstream 502",
    };
    handle.resolveResult(errored);
    await flush();
    await flush();

    await expect(promise).resolves.toMatchObject({
      status: "error",
      finalMessage: "PROVIDER_ERROR: upstream 502",
    });
  });

  it("cascades a parent abort reason-less and resolves status aborted with the partial text (D4)", async () => {
    const { store, runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);
    const parentController = new AbortController();

    const promise = runner.run(
      { role: "explorer", task: "survey the worldbook", parentToolCallId: "tc-4" },
      parentController.signal,
    );
    await flush();

    parentController.abort();
    // The cascade aborts the child WITHOUT the stop reason — anything else
    // would mislabel a parent stop as a per-child stop.
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(handle.abort).toHaveBeenCalledWith();

    handle.resolveResult(
      runResult(
        "aborted",
        [
          { role: "user", content: "survey the worldbook" },
          { role: "assistant", content: "Partial findings: 3 characters…" },
        ],
        { inputTokens: 5, outputTokens: 2 },
      ),
    );
    await flush();
    await flush();

    await expect(promise).resolves.toEqual({
      runId: "run-conv-1",
      status: "aborted",
      finalMessage: "Partial findings: 3 characters…",
      usage: { input: 5, output: 2 },
    });
    expect(store.getState().worlds.get(WORLD_ID)?.get("run-conv-1")?.view.isRunning).toBe(false);
  });

  it("stop(runId) aborts with the stop reason and resolves status stopped (D4)", async () => {
    const { runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);

    const promise = runner.run(
      { role: "writer", task: "write the scene", parentToolCallId: "tc-5" },
      new AbortController().signal,
    );
    await flush();

    runner.stop?.("run-conv-1");
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(handle.abort).toHaveBeenCalledWith("stopped");

    handle.resolveResult(
      runResult("aborted", [{ role: "assistant", content: "Half a scene…" }], {
        inputTokens: 3,
        outputTokens: 9,
      }),
    );
    await flush();
    await flush();

    await expect(promise).resolves.toMatchObject({
      status: "stopped",
      finalMessage:
        "The user stopped this subagent run. Partial output before the stop:\nHalf a scene…",
    });
  });

  it("never rejects: folds an unexpected internal throw into an error result (ADR-0018 composite)", async () => {
    const { runner } = await seedOrchestrator();
    // Conversation creation fails — the runner must resolve, not reject.
    vi.mocked(createConversationIpc).mockRejectedValueOnce(new Error("ipc down"));

    await expect(
      runner.run(
        { role: "scribe", task: "file the notes", parentToolCallId: "tc-6" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      runId: null,
      status: "error",
      finalMessage: expect.stringContaining("ipc down"),
    });
  });

  // ── Slot settlement (F1 terminalStatus + F3 Agent eviction) ──────────

  it("stamps terminalStatus completed on the child slot and evicts its cached Agent once the run settles (F1/F3)", async () => {
    const { store, runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);

    const promise = runner.run(
      { role: "writer", task: "write the scene", parentToolCallId: "tc-s1" },
      new AbortController().signal,
    );
    await flush();

    // Mid-run: the child Agent is cached on the slot and no terminal
    // status exists yet (driveRun's start-of-run reset keeps it null).
    const live = store.getState().worlds.get(WORLD_ID)?.get("run-conv-1");
    expect(live?.agent).not.toBeNull();
    expect(live?.view.terminalStatus).toBeNull();

    handle.resolveResult(
      runResult("stop", [{ role: "assistant", content: "done" }], {
        inputTokens: 1,
        outputTokens: 1,
      }),
    );
    await flush();
    await flush();
    await expect(promise).resolves.toMatchObject({ status: "completed" });

    // Settled: authoritative terminal status, Agent released (thread +
    // model handle), but the slot itself — view + conversation — stays
    // for drill-in replay.
    const settled = store.getState().worlds.get(WORLD_ID)?.get("run-conv-1");
    expect(settled).toBeDefined();
    expect(settled?.view.terminalStatus).toBe("completed");
    expect(settled?.agent).toBeNull();
  });

  it("stamps terminalStatus stopped (not aborted) after a user-initiated stop of the child run (F1)", async () => {
    const { store, runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);

    const promise = runner.run(
      { role: "writer", task: "write the scene", parentToolCallId: "tc-s2" },
      new AbortController().signal,
    );
    await flush();

    // The Unit D Stop-button path: the store's abort action carrying the
    // SUBAGENT_STOP_REASON string.
    store.getState().abort(WORLD_ID, "run-conv-1");
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(handle.abort).toHaveBeenCalledWith("stopped");

    handle.resolveResult(
      runResult("aborted", [{ role: "assistant", content: "Half a scene…" }], {
        inputTokens: 3,
        outputTokens: 9,
      }),
    );
    await flush();
    await flush();
    await expect(promise).resolves.toMatchObject({
      status: "stopped",
      // The user-stop notice leads; the partial text rides along.
      finalMessage: expect.stringContaining("The user stopped this subagent run"),
    });

    // The dispatch contract's authoritative word wins over driveRun's
    // generic stopReason, which alone would read "aborted".
    expect(viewOf(store, "run-conv-1").terminalStatus).toBe("stopped");
    expect(viewOf(store, "run-conv-1").stopReason).toBe("aborted");
    expect(store.getState().worlds.get(WORLD_ID)?.get("run-conv-1")?.agent).toBeNull();
  });

  it("removeConversation sweeps the parent slot AND its hidden subagent run slots (F4)", async () => {
    const { store, runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);

    const promise = runner.run(
      { role: "explorer", task: "survey the worldbook", parentToolCallId: "tc-s3" },
      new AbortController().signal,
    );
    await flush();
    // Both slots live: parent + in-flight hidden child.
    expect(store.getState().worlds.get(WORLD_ID)?.has("conv-parent")).toBe(true);
    expect(store.getState().worlds.get(WORLD_ID)?.has("run-conv-1")).toBe(true);

    store.getState().removeConversation(WORLD_ID, "conv-parent");
    await flush();

    // Rust cascades the hidden run rows on delete (F4-Rust) — the
    // in-memory map follows: parent AND child gone, empty bucket dropped.
    expect(store.getState().worlds.get(WORLD_ID)?.get("conv-parent")).toBeUndefined();
    expect(store.getState().worlds.get(WORLD_ID)?.get("run-conv-1")).toBeUndefined();
    expect(store.getState().worlds.has(WORLD_ID)).toBe(false);

    // The defensive child abort fired (reason-less → parent-cascade
    // semantics) and the dispatch still resolves its contract.
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(handle.abort).toHaveBeenCalledWith();
    handle.resolveResult(
      runResult("aborted", [{ role: "assistant", content: "Partial…" }], {
        inputTokens: 1,
        outputTokens: 1,
      }),
    );
    await flush();
    await flush();
    await expect(promise).resolves.toMatchObject({ status: "aborted" });
  });

  // ── approveAllForRun (ADR-0050 D5 — the Unit D approve-all surface) ──

  it("approveAllForRun resolves every pending approval on the child slot in one gesture (D5)", async () => {
    const { store, runner } = await seedOrchestrator();
    const handle = makeScriptedHandle();
    agentMocks.run.mockReturnValue(handle);
    const promise = runner.run(
      { role: "curator", task: "tidy the worldbook", parentToolCallId: "tc-7" },
      new AbortController().signal,
    );
    await flush();

    // contexts[1] is the CHILD's ToolContext — its gate is bound to the
    // child slot, which driveRun has put into streaming state.
    const childCtx = agentMocks.contexts[1];
    const reqA = childCtx.approvalGate.request({
      toolCallId: "tc-child-a",
      toolName: "create_character",
      input: {},
      consentLevel: "always",
      abortSignal: new AbortController().signal,
    });
    const reqB = childCtx.approvalGate.request({
      toolCallId: "tc-child-b",
      toolName: "delete_character",
      input: {},
      consentLevel: "always",
      abortSignal: new AbortController().signal,
    });
    await flush();
    expect(Object.keys(viewOf(store, "run-conv-1").stream?.pendingApprovals ?? {})).toEqual([
      "tc-child-a",
      "tc-child-b",
    ]);

    store.getState().approveAllForRun(WORLD_ID, "run-conv-1");
    await flush();

    // Every gate request unblocked as approved + the queue drained.
    await expect(reqA).resolves.toBe(true);
    await expect(reqB).resolves.toBe(true);
    expect(Object.keys(viewOf(store, "run-conv-1").stream?.pendingApprovals ?? {})).toEqual([]);

    // Settle the child so the dispatch promise resolves (test hygiene).
    handle.resolveResult(
      runResult("stop", [{ role: "assistant", content: "done" }], {
        inputTokens: 1,
        outputTokens: 1,
      }),
    );
    await flush();
    await flush();
    await promise;
  });

  it("approveAllForRun no-ops on an absent slot or idle stream", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    // Unknown run id — must not throw.
    expect(() => store.getState().approveAllForRun(WORLD_ID, "nope")).not.toThrow();

    // Existing slot WITHOUT stream state (idle) — equally a no-op.
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-idle"), loadingResolver, noopPersistError);
    expect(() => store.getState().approveAllForRun(WORLD_ID, "conv-idle")).not.toThrow();
  });
});

// ─── Chapter anchor context injection ──────────────────────────────────────

describe("chapter context injection", () => {
  /** A full Chapter row fixture (parsed to satisfy the branded ids). */
  const chapter = chapterSchema.parse({
    id: "ch-7",
    novelId: "nv-1",
    title: "The Ice Throne",
    summary: "",
    sceneIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

  function makeChapterConversation(): Conversation {
    return makeConversation("conv-ch", { kind: "chapter", chapterId: "ch-7" });
  }

  /**
   * The systemPrompt handed to the (module-mocked) AgentLoop on its latest
   * construction — constructAgent's `effectiveSystemPrompt` lands here, so
   * this is the seam the block-injection assertions read.
   */
  function lastLoopSystemPrompt(): string {
    const calls = vi.mocked(AgentLoop).mock.calls;
    const last = calls[calls.length - 1];
    if (!last) throw new Error("AgentLoop was not constructed");
    return last[0].systemPrompt;
  }

  it("injects a <chapter_context> block with the chapterId and title for chapter-kind conversations", async () => {
    vi.mocked(getChapter).mockResolvedValue(chapter);
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeChapterConversation(), readyResolver, noopPersistError);
    await flush();
    await flush(); // constructAgent awaits getChapter before Agent.open

    expect(vi.mocked(getChapter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getChapter)).toHaveBeenCalledWith(
      SPACE_ID,
      WORLD_ID,
      chapterIdSchema.parse("ch-7"),
    );

    const prompt = lastLoopSystemPrompt();
    expect(prompt).toContain("<chapter_context>");
    expect(prompt).toContain("ch-7");
    expect(prompt).toContain("The Ice Throne");
    expect(prompt).toContain("nv-1");
  });

  it("does not inject the block (nor fetch a chapter) for world-kind conversations", async () => {
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeConversation("conv-w"), readyResolver, noopPersistError);
    await flush();

    expect(vi.mocked(getChapter)).not.toHaveBeenCalled();
    expect(lastLoopSystemPrompt()).not.toContain("<chapter_context>");
  });

  it("still constructs a runnable agent when getChapter rejects: block skipped, failure logged", async () => {
    vi.mocked(getChapter).mockRejectedValue(new Error("chapter gone"));
    const store = createConversationRuntimeStore(SPACE_ID);
    await store
      .getState()
      .ensureRuntime(WORLD_ID, makeChapterConversation(), readyResolver, noopPersistError);
    await flush();
    await flush();

    // Construction succeeded — no view error, and a run goes through.
    expect(viewOf(store, "conv-ch").error).toBeNull();
    agentMocks.run.mockReturnValue(makeRunHandle());
    await store
      .getState()
      .send(
        WORLD_ID,
        "conv-ch",
        "hi",
        readyResolver,
        noopPersistError,
        noopAutoTitle,
        visionUnknown,
      );
    await flush();
    expect(agentMocks.run).toHaveBeenCalledTimes(1);

    // Degradation is deterministic: the whole block is absent.
    expect(lastLoopSystemPrompt()).not.toContain("<chapter_context>");
    expect(logger.warn).toHaveBeenCalledWith("chat.chapter_context.failed", {
      chapter_id: "ch-7",
      world_id: WORLD_ID,
      error: "chapter gone",
    });
  });
});
