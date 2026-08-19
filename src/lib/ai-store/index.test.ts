/**
 * TauriSessionStore attachment boundary tests (ADR-0044 / plan D3).
 *
 * Covers the exported pure-ish helpers (`dehydrateAttachments` /
 * `hydrateAttachments`) plus their wiring into `appendMessages` /
 * `loadMessages` — with the IPC layer mocked so the payload shapes can be
 * asserted directly. The pure library (`@/lib/ai`) runs REAL (its
 * `toModelMessage` mapping is part of the append path).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePart, TextPart, UserContent } from "ai";

import {
  appendMessages as appendMessagesApi,
  loadMessages as loadMessagesApi,
} from "@/api/conversation";
import { getMessageAttachment } from "@/api/attachment";
import { base64Encode } from "@/lib/image-bytes";
import { logger } from "@/lib/logger";
import type { LanguageModelUsage, ModelMessage, SessionMessage } from "@/lib/ai";
import {
  TauriSessionStore,
  dehydrateAttachments,
  hydrateAttachments,
  type AttachmentFetcher,
} from "@/lib/ai-store";
import { conversationSchema, type AttachmentInput, type Conversation } from "@/types";

vi.mock("@/api/conversation", () => ({
  appendMessages: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listConversations: vi.fn(),
  loadMessages: vi.fn(),
  updateConversationPlan: vi.fn(),
}));

vi.mock("@/api/attachment", () => ({
  getMessageAttachment: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SPACE_ID = "space-1";
const WORLD_ID = "world-1";
const CONV_ID = "conv-1";
const NOW = "2026-01-01T00:00:00.000Z";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = base64Encode(PNG_BYTES);
// Multi-byte UTF-8 payload (Chinese content) — exercises byte-exact base64
// round-tripping through dehydrate → fetch → re-encode.
const MD_BYTES = new TextEncoder().encode("# 大纲\n第一章 世界观设定");
const MD_B64 = base64Encode(MD_BYTES);

function conversationFixture(): Conversation {
  return conversationSchema.parse({
    id: CONV_ID,
    agentConfigName: "explorer",
    title: null,
    meta: { kind: "world" },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function userMessage(content: UserContent, id: string): SessionMessage {
  return { role: "user", content, id, sessionId: CONV_ID, createdAt: NOW };
}

function assistantMessage(text: string, id: string): SessionMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    id,
    sessionId: CONV_ID,
    createdAt: NOW,
  };
}

/** Mixed user turn: text part + image attachment + text attachment. */
function mixedUserTurn(): SessionMessage {
  return userMessage(
    [
      { type: "text", text: "看看这两个文件" },
      {
        type: "file",
        data: `data:image/png;base64,${PNG_B64}`,
        mediaType: "image/png",
        filename: "示意图.png",
      },
      {
        type: "file",
        data: `data:text/markdown;base64,${MD_B64}`,
        mediaType: "text/markdown",
        filename: "大纲.md",
      },
    ],
    "msg-1",
  );
}

/** Narrow a message's content to its parts array (single test-local cast). */
function partsOf(message: SessionMessage): Array<TextPart | FilePart> {
  if (!Array.isArray(message.content)) {
    throw new Error("test fixture error: content is not an array");
  }
  return message.content as Array<TextPart | FilePart>;
}

/** Decode standard base64 to bytes (test-side mirror of the runtime form). */
function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Build an id → bytes map from a dehydrate result (round-trip fetcher). */
function bytesByIdFrom(
  attachmentsByMessage: Map<string, AttachmentInput[]>,
): Map<string, ArrayBuffer> {
  const map = new Map<string, ArrayBuffer>();
  for (const list of attachmentsByMessage.values()) {
    for (const a of list) {
      map.set(a.id, bytesFromBase64(a.dataBase64).slice().buffer as ArrayBuffer);
    }
  }
  return map;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── dehydrateAttachments ──────────────────────────────────────────────────

describe("dehydrateAttachments", () => {
  it("swaps data-URL file parts to attachment:// refs and mints AttachmentInput rows", () => {
    const { messages, attachmentsByMessage } = dehydrateAttachments([
      mixedUserTurn(),
      assistantMessage("收到", "msg-2"),
    ]);

    const attachments = attachmentsByMessage.get("msg-1");
    expect(attachments).toBeDefined();
    expect(attachments).toHaveLength(2);
    expect(attachments?.[0]).toMatchObject({
      position: 0,
      kind: "image",
      mime: "image/png",
      filename: "示意图.png",
      dataBase64: PNG_B64,
    });
    expect(attachments?.[1]).toMatchObject({
      position: 1,
      kind: "text",
      mime: "text/markdown",
      filename: "大纲.md",
      dataBase64: MD_B64,
    });
    // Client-minted UUIDs (plan D2 — stored verbatim server-side).
    expect(attachments?.[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const parts = partsOf(messages[0]!);
    expect(parts[0]).toEqual({ type: "text", text: "看看这两个文件" });
    expect(parts[1]?.type === "file" && parts[1].data).toBe(
      `attachment://${attachments?.[0].id}`,
    );
    expect(parts[2]?.type === "file" && parts[2].data).toBe(
      `attachment://${attachments?.[1].id}`,
    );

    // The assistant message passes through by reference; count preserved.
    expect(messages[1]).toBe(messages[1]);
    expect(messages).toHaveLength(2);
    // Messages with no eligible parts are passed through BY REFERENCE.
    expect(messages[1]).toEqual(assistantMessage("收到", "msg-2"));
  });

  it("leaves non-data-URL parts and unsupported media types untouched", () => {
    const alreadyRef = userMessage(
      [
        {
          type: "file",
          data: "attachment://existing-id",
          mediaType: "image/png",
          filename: "already.png",
        },
        {
          type: "file",
          data: "data:video/mp4;base64,AAAA",
          mediaType: "video/mp4",
          filename: "clip.mp4",
        },
        {
          type: "file",
          data: "data:image/png;base64", // malformed: no comma — left as-is
          mediaType: "image/png",
          filename: "bad.png",
        },
      ],
      "msg-1",
    );
    const plainString = userMessage("纯文本消息", "msg-2");

    const { messages, attachmentsByMessage } = dehydrateAttachments([
      alreadyRef,
      plainString,
      assistantMessage("ok", "msg-3"),
    ]);

    // Nothing eligible → every message passes through by reference, no rows.
    expect(messages[0]).toBe(alreadyRef);
    expect(messages[1]).toBe(plainString);
    expect(attachmentsByMessage.size).toBe(0);
    expect(messages).toHaveLength(3);
  });
});

// ─── hydrateAttachments ────────────────────────────────────────────────────

describe("hydrateAttachments", () => {
  it("round-trips a dehydrated mixed turn back to the original (multi-byte safe)", async () => {
    const original = mixedUserTurn();
    const assistant = assistantMessage("收到", "msg-2");
    const { messages, attachmentsByMessage } = dehydrateAttachments([
      original,
      assistant,
    ]);

    const bytesById = bytesByIdFrom(attachmentsByMessage);
    const fetcher: AttachmentFetcher = (id) =>
      Promise.resolve(bytesById.get(id) ?? null);

    const hydrated = await hydrateAttachments(messages, fetcher);

    // Byte-exact equality with the ORIGINAL runtime form (data URLs rebuilt
    // from the fetched bytes — covers the Chinese filename/content fixture).
    expect(hydrated).toHaveLength(2);
    expect(hydrated[0]).toEqual(original);
    expect(hydrated[1]).toBe(assistant);
  });

  it("degrades a missing row to an unavailable TextPart and warns (never throws)", async () => {
    const persisted = userMessage(
      [
        {
          type: "file",
          data: "attachment://missing-1",
          mediaType: "text/markdown",
          filename: "notes.md",
        },
      ],
      "msg-9",
    );

    const hydrated = await hydrateAttachments([persisted], async () => null);

    expect(hydrated).toHaveLength(1);
    expect(partsOf(hydrated[0]!)[0]).toEqual({
      type: "text",
      text: "[Attachment unavailable: notes.md]",
    });
    expect(logger.warn).toHaveBeenCalledWith("attachment.hydrate.missing", {
      attachment_id: "missing-1",
      message_id: "msg-9",
    });
  });

  it("never throws when the fetcher rejects (degrades to missing)", async () => {
    const persisted = userMessage(
      [
        {
          type: "file",
          data: "attachment://boom",
          mediaType: "image/png",
          filename: "pic.png",
        },
      ],
      "msg-10",
    );

    await expect(
      hydrateAttachments([persisted], async () => {
        throw new Error("ipc down");
      }),
    ).resolves.toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith("attachment.hydrate.missing", {
      attachment_id: "boom",
      message_id: "msg-10",
    });
  });

  it("passes messages without refs through by reference", async () => {
    const plain = userMessage("hello", "msg-1");
    const assistant = assistantMessage("hi", "msg-2");
    const hydrated = await hydrateAttachments(
      [plain, assistant],
      async () => null,
    );
    expect(hydrated[0]).toBe(plain);
    expect(hydrated[1]).toBe(assistant);
    expect(getMessageAttachment).not.toHaveBeenCalled();
  });
});

// ─── TauriSessionStore wiring ──────────────────────────────────────────────

describe("TauriSessionStore attachment wiring", () => {
  function makeStore(): TauriSessionStore {
    return new TauriSessionStore({
      spaceId: SPACE_ID,
      worldId: WORLD_ID,
      conversation: conversationFixture(),
    });
  }

  it("appendMessages carries AttachmentInput rows on the IPC payload", async () => {
    vi.mocked(appendMessagesApi).mockResolvedValue(undefined);
    const store = makeStore();
    const usage: LanguageModelUsage = {
      inputTokens: 7,
      outputTokens: 11,
      inputTokenDetails: {
        noCacheTokens: 7,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: 11, reasoningTokens: undefined },
      totalTokens: 18,
    };

    await store.appendMessages(
      CONV_ID,
      [mixedUserTurn(), assistantMessage("收到", "msg-2")],
      usage,
    );

    expect(appendMessagesApi).toHaveBeenCalledTimes(1);
    const [spaceArg, worldArg, payload] = vi.mocked(appendMessagesApi).mock
      .calls[0]!;
    expect(spaceArg).toBe(SPACE_ID);
    expect(worldArg).toBe(WORLD_ID);
    expect(payload.conversationId).toBe(CONV_ID);
    expect(payload.messages).toHaveLength(2);

    const [userRow, assistantRow] = payload.messages as Array<{
      id: string;
      body: ModelMessage;
      usageInputTokens?: number | null;
      usageOutputTokens?: number | null;
      attachments?: Array<{
        id: string;
        position: number;
        kind: string;
        mime: string;
        filename: string;
        dataBase64: string;
      }>;
    }>;

    // User row: inline attachments with the minted ids, body refs swapped.
    expect(userRow.id).toBe("msg-1");
    expect(userRow.attachments).toHaveLength(2);
    expect(userRow.attachments?.[0]).toMatchObject({
      position: 0,
      kind: "image",
      mime: "image/png",
      dataBase64: PNG_B64,
    });
    expect(userRow.attachments?.[1]).toMatchObject({
      position: 1,
      kind: "text",
      mime: "text/markdown",
      dataBase64: MD_B64,
    });
    const userParts = userRow.body
      ? ((userRow.body as { content: unknown }).content as Array<
          TextPart | FilePart
        >)
      : [];
    expect(userParts[1]?.type === "file" && userParts[1].data).toBe(
      `attachment://${userRow.attachments?.[0].id}`,
    );
    // Usage belongs to the assistant row only (ADR-0030 §2); no attachments.
    expect(assistantRow.usageInputTokens).toBe(7);
    expect(assistantRow.usageOutputTokens).toBe(11);
    expect(assistantRow.attachments).toBeUndefined();
  });

  it("loadMessages hydrates attachment refs via getMessageAttachment", async () => {
    vi.mocked(loadMessagesApi).mockResolvedValue([
      {
        id: "msg-1",
        conversationId: CONV_ID,
        createdAt: NOW,
        body: {
          role: "user",
          content: [
            {
              type: "file",
              data: "attachment://att-1",
              mediaType: "image/png",
              filename: "pic.png",
            },
          ],
        },
      },
    ]);
    vi.mocked(getMessageAttachment).mockResolvedValue(
      PNG_BYTES.slice().buffer as ArrayBuffer,
    );

    const store = makeStore();
    const messages = await store.loadMessages(CONV_ID);

    expect(getMessageAttachment).toHaveBeenCalledWith(
      SPACE_ID,
      WORLD_ID,
      "att-1",
    );
    const parts = partsOf(messages[0]!);
    expect(parts[0]?.type === "file" && parts[0].data).toBe(
      `data:image/png;base64,${PNG_B64}`,
    );
  });
});
