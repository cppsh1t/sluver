/**
 * `TauriSessionStore` -- the concrete {@link SessionStore} implementation that
 * bridges the pure AI agent library to the conversation IPC commands.
 *
 * The pure library (ADR-0019) defines {@link SessionStore} as an opaque
 * persistence interface; this module is its app-side realization. It routes
 * every method to the corresponding Tauri command in `@/api/conversation`,
 * translating between the library's `SessionMessage` / `SessionRecord` shapes
 * and the persisted `Message` / `Conversation` rows.
 *
 * ## Who calls what
 *
 * - The **runtime** creates conversations directly via `createConversation()`
 *   (with the role name), NOT via `store.createSession()`. `createSession` is
 *   implemented defensively only to fully satisfy the {@link SessionStore}
 *   contract -- it is not on the runtime's hot path.
 * - The **Agent** (stateful wrapper) uses only `loadMessages` +
 *   `appendMessages`, both of which are exercised every turn.
 *
 * Related: ADR-0019 (library purity boundary), ADR-0020 (session layer),
 * ADR-0021 (novel scene autosave -- same full-replacement persistence idiom).
 */

import {
  appendMessages as appendMessagesApi,
  createConversation,
  deleteConversation,
  listConversations,
  loadMessages,
} from "@/api/conversation";
import {
  toModelMessage,
  type ModelMessage,
  type SessionInit,
  type SessionMessage,
  type SessionRecord,
  type SessionStore,
} from "@/lib/ai";
import type {
  Conversation,
  ConversationId,
  Message,
  WorldId,
} from "@/types";

// --- Construction ---------------------------------------------------------

export interface TauriSessionStoreOptions {
  /** Plain (unbranded) Space id from the route param. */
  readonly spaceId: string;
  /** Plain (unbranded) World id from the route param. */
  readonly worldId: string;
}

// --- Meta shape (read defensively by createSession) -----------------------

/**
 * The typed projection of {@link SessionInit.meta} that this store understands.
 * `meta` is `unknown` at the library boundary (ADR-0019 keeps it opaque); this
 * interface narrows it to the fields `createConversation` requires.
 */
interface TauriSessionMeta {
  readonly agentConfigName: string;
  readonly kind: "world" | "chapter";
  readonly chapterId?: string;
}

// --- Store ----------------------------------------------------------------

/**
 * A {@link SessionStore} backed by the conversation IPC commands.
 *
 * One instance is constructed per (Space, World) pair -- the runtime builds a
 * fresh one for each `Agent`. `spaceId` + `worldId` are captured at
 * construction; branded-id casts (`as WorldId` / `as ConversationId`) happen
 * here, at the IPC boundary, matching the existing route-param cast convention
 * (see `_space.tsx`, `world-sidebar.tsx`).
 */
export class TauriSessionStore implements SessionStore {
  constructor(private readonly options: TauriSessionStoreOptions) {}

  // -- Session lifecycle --

  /**
   * Create a conversation record.
   *
   * **Not used by the runtime** -- the runtime calls `createConversation()`
   * directly (with the resolved role name) so it can pass the conversation
   * straight into `ensureRuntime`. This method exists only to satisfy the
   * {@link SessionStore} contract for completeness.
   *
   * Reads `agentConfigName` + `kind` from `init.meta`. When `meta` is absent
   * entirely it defaults to `{ agentConfigName: "explorer", kind: "world" }`
   * (the most common role). When `meta` is present but `agentConfigName` is
   * missing, it throws -- a malformed call that should surface loudly.
   */
  async createSession(init?: SessionInit): Promise<SessionRecord> {
    let agentConfigName: string;
    let kind: "world" | "chapter" = "world";
    let chapterId: string | undefined;

    if (init?.meta === undefined) {
      // No meta at all -- the conservative default.
      agentConfigName = "explorer";
    } else {
      const meta = init.meta as TauriSessionMeta;
      if (!meta.agentConfigName) {
        throw new Error(
          "TauriSessionStore.createSession: init.meta.agentConfigName is required when meta is provided. " +
            "The runtime should create conversations via createConversation() directly.",
        );
      }
      agentConfigName = meta.agentConfigName;
      kind = meta.kind ?? "world";
      chapterId = meta.chapterId;
    }

    const conversation = await createConversation(
      this.options.spaceId,
      this.options.worldId as WorldId,
      {
        agentConfigName,
        kind,
        ...(chapterId !== undefined ? { chapterId } : {}),
      },
    );
    return conversationToSessionRecord(conversation);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const conversations = await listConversations(
      this.options.spaceId,
      this.options.worldId as WorldId,
    );
    return conversations.map(conversationToSessionRecord);
  }

  async deleteSession(id: string): Promise<void> {
    await deleteConversation(
      this.options.spaceId,
      this.options.worldId as WorldId,
      id as ConversationId,
    );
  }

  // -- Messages (used by Agent) --

  async loadMessages(sessionId: string): Promise<SessionMessage[]> {
    const messages = await loadMessages(
      this.options.spaceId,
      this.options.worldId as WorldId,
      sessionId as ConversationId,
    );
    return messages.map(messageToSessionMessage);
  }

  async appendMessages(sessionId: string, delta: SessionMessage[]): Promise<void> {
    await appendMessagesApi(
      this.options.spaceId,
      this.options.worldId as WorldId,
      {
        conversationId: sessionId as ConversationId,
        messages: delta.map(sessionMessageToMessage),
      },
    );
  }
}

// --- Mapping helpers ------------------------------------------------------

/**
 * Project a persisted {@link Conversation} onto the library's {@link SessionRecord}.
 * `Conversation` carries extra fields (`agentConfigName`, `title`, `meta.kind`)
 * the library treats as opaque; only the four `SessionRecord` fields are kept.
 * `meta` flows through verbatim (the library does not interpret it).
 */
function conversationToSessionRecord(conversation: Conversation): SessionRecord {
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    meta: conversation.meta,
  };
}

/**
 * Reconstruct a {@link SessionMessage} from a persisted {@link Message} row.
 *
 * **Controlled boundary cast**: `message.body` is typed `unknown` at the
 * persistence layer (`types/conversation.ts` deliberately avoids a layering
 * dependency on the AI lib). It was written by {@link sessionMessageToMessage}
 * below -- i.e. it holds exactly the `ModelMessage` portion produced by
 * `toModelMessage`. Casting `unknown -> ModelMessage` is therefore sound: the DB
 * is a round-trip of our own output, not an arbitrary external value. This is
 * the single sanctioned `as` cast in this module.
 */
function messageToSessionMessage(message: Message): SessionMessage {
  const modelMessage = message.body as ModelMessage;
  return {
    ...modelMessage,
    id: message.id,
    sessionId: message.conversationId,
    createdAt: message.createdAt,
  };
}

/**
 * Project a {@link SessionMessage} onto the IPC {@link Message} shape. Strips
 * the three metadata fields (`id`, `sessionId`, `createdAt`) via
 * {@link toModelMessage} and carries them as sibling columns instead.
 */
function sessionMessageToMessage(sessionMessage: SessionMessage): Message {
  return {
    id: sessionMessage.id,
    conversationId: sessionMessage.sessionId,
    body: toModelMessage(sessionMessage),
    createdAt: sessionMessage.createdAt,
  };
}
