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

import type { FilePart, TextPart } from "ai";

import { getMessageAttachment } from "@/api/attachment";
import {
  appendMessages as appendMessagesApi,
  createConversation,
  deleteConversation,
  listConversations,
  loadMessages,
  updateConversationPlan,
} from "@/api/conversation";
import { base64Encode } from "@/lib/image-bytes";
import { logger } from "@/lib/logger";
import {
  toModelMessage,
  type LanguageModelUsage,
  type ModelMessage,
  type Plan,
  type SessionInit,
  type SessionMessage,
  type SessionRecord,
  type SessionStore,
} from "@/lib/ai";
import type {
  AttachmentInput,
  AttachmentKind,
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
  /**
   * The conversation this store is bound to. Captured at construction so
   * {@link loadPlan} can read `meta.plan` straight from the in-memory
   * {@link Conversation} object — no separate "read meta" IPC needed. The
   * conversation-runtime always has a fully-resolved Conversation in hand
   * when it constructs the store (it lives on
   * `ConversationRuntimeData.conversation`), so passing it through is free.
   *
   * Note: the captured reference is the runtime's SNAPSHOT at construction
   * time. {@link savePlan} deliberately does NOT keep it in sync with later
   * IPC writes — see its docstring.
   */
  readonly conversation: Conversation;
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
    // ADR-0044 D3 — hydrate `attachment://{id}` refs back into data URLs
    // after the row mapping. The fetcher swallows EVERY rejection into
    // `null` so `hydrateAttachments` (and therefore `loadMessages`) NEVER
    // throws — the per-part degradation + logger.warn happen inside.
    return hydrateAttachments(
      messages.map(messageToSessionMessage),
      (id) =>
        getMessageAttachment(
          this.options.spaceId,
          this.options.worldId as WorldId,
          id,
        ).catch(() => null),
    );
  }

  async appendMessages(
    sessionId: string,
    delta: SessionMessage[],
    turnUsage?: LanguageModelUsage,
  ): Promise<void> {
    // ADR-0044 D3 — dehydrate data-URL file parts into sidecar
    // AttachmentInput rows + `attachment://{id}` refs BEFORE building the
    // IPC payload, so the message bodies and their blobs land in ONE
    // transaction (plan D2).
    const { messages: dehydrated, attachmentsByMessage } =
      dehydrateAttachments(delta);
    await appendMessagesApi(
      this.options.spaceId,
      this.options.worldId as WorldId,
      {
        conversationId: sessionId as ConversationId,
        // ADR-0030 §2 — usage attaches to the LAST assistant row in the
        // delta. Every turn has at least one assistant (the model is called
        // at least once), so a non-`undefined` `turnUsage` always lands on
        // a real row. We find the index by scanning backwards; if no
        // assistant is found (defensive — should not happen for a real
        // turn) `turnUsage` is silently dropped rather than crashing.
        messages: dehydrated.map((sm, i) => {
          const row =
            i === lastAssistantIndex(delta) && turnUsage
              ? sessionMessageToMessage(sm, {
                  inputTokens: turnUsage.inputTokens,
                  outputTokens: turnUsage.outputTokens,
                })
              : sessionMessageToMessage(sm);
          const attachments = attachmentsByMessage.get(sm.id);
          return attachments ? { ...row, attachments } : row;
        }),
      },
    );
  }

  // -- Plan (ADR-0028, ADR-0029 Phase 1) --

  /**
   * Load the Plan for this conversation. The Plan is NOT a message — it lives
   * at `conversation.meta.plan` and is re-injected into the Derived Model Input
   * on every subsequent turn by the pipeline's plan-injector (ADR-0028).
   *
   * Reads straight from the {@link Conversation} captured at construction —
   * no IPC round-trip. The `_sessionId` parameter is kept for
   * {@link SessionStore} contract compliance; the data is already in memory,
   * keyed by the conversation reference the runtime handed us.
   *
   * ## Defensive narrowing (never throws)
   *
   * The persisted `meta` could be from an older app version, partially
   * migrated, or corrupted on disk. The contract says "Never throws — a
   * missing or malformed Plan resolves to `null`", so every check is
   * defensive: missing `meta`, non-object `meta`, missing `plan`, or a
   * `plan` whose `items` is not an array all return `null`. A return of
   * `null` means "no Plan to inject" — the agent starts with a clean slate.
   *
   * ## Boundary cast
   *
   * `Conversation.meta` is typed as {@link ConversationMeta} (a `{kind: …}`
   * discriminable union); the optional `plan` field is written by our own
   * `updateConversationPlan` IPC (T1). Reading `plan` requires projecting the
   * typed meta through `Record<string, unknown>` and then casting the
   * shape-verified candidate back to {@link Plan}. This mirrors the existing
   * `message.body as ModelMessage` boundary cast below (same justification:
   * our own IPC wrote it, so the cast is sound) and stays localized to this
   * one readsite.
   */
  async loadPlan(_sessionId: string): Promise<Plan | null> {
    const { meta } = this.options.conversation;
    // Defensive: meta is typed ConversationMeta (always an object), but be
    // resilient to malformed persisted rows from older app versions.
    if (!meta || typeof meta !== "object") return null;
    const candidate = (meta as Record<string, unknown>).plan;
    if (candidate == null) return null;
    // Shape check — never throw on malformed persisted data.
    const items = (candidate as Record<string, unknown>).items;
    if (!Array.isArray(items)) return null;
    // Normalize empty Plan to `null` per the SessionStore contract:
    // "Returns null if no Plan has been set OR if the persisted Plan is empty
    // ({items: []})." Both cases produce no reminder injection. Without this,
    // a cleared plan (savePlan({items: []})) round-trips as a truthy Plan
    // with zero items — Agent.plan would be non-null when the contract
    // promises null.
    if (items.length === 0) return null;
    // At this point we trust the shape (our own IPC wrote it). The cast is
    // the sanctioned boundary cast for this module (mirrors the existing
    // `message.body as ModelMessage` cast below).
    return candidate as Plan;
  }

  /**
   * Persist a new Plan, replacing any prior Plan wholesale. Routes to the
   * `update_conversation_plan` IPC (T1), which writes `meta.plan` while
   * preserving the other meta fields (`kind`, `chapterId`).
   *
   * Called by `Agent.setPlan` fire-and-forget — persistence errors route to
   * `Agent.onPersistError`, never back to the caller. Per ADR-0028 invariant
   * 2, the new Plan takes effect on the NEXT `Agent.run()` (which snapshots
   * `Agent.plan` at entry); the in-memory `Agent.plan` was already updated
   * synchronously by `Agent.setPlan` before this method runs.
   *
   * ## Why we don't mutate the captured conversation
   *
   * We deliberately do NOT write `this.options.conversation.meta.plan = plan`
   * in memory. The captured {@link Conversation} is the runtime's snapshot
   * from construction time; the source of truth for the persisted state is
   * the DB, and the runtime reconstructs a fresh Conversation from the IPC
   * layer on the next `list_conversations` / reopen. Mutating the cached
   * object here would create drift between this cached view and the persisted
   * truth. The live in-memory source of truth for the current session is
   * `Agent.plan` — that's what the plan-injector reads at `run()` entry.
   */
  async savePlan(sessionId: string, plan: Plan): Promise<void> {
    await updateConversationPlan(
      this.options.spaceId,
      this.options.worldId,
      sessionId,
      plan,
    );
  }
}

// --- Attachment boundary (ADR-0044 / plan D3) ------------------------------
//
// The single hydrate/dehydrate seam between the runtime thread (data URLs,
// provider-ready) and the persisted bodies (`attachment://{id}` refs,
// JSON-safe). Lives HERE — app layer — so the pure library never knows about
// `attachment://` (ADR-0019 purity, ADR-0028 layering).

/** Prefix marking a persisted FilePart `data` as an attachment ref. */
const ATTACHMENT_REF_PREFIX = "attachment://";
/** Prefix marking a runtime FilePart `data` as an inline base64 data URL. */
const DATA_URL_PREFIX = "data:";

/** Filename fallback when a FilePart carries none (display-only). */
const FALLBACK_FILENAME = "attachment";

/**
 * Map a media type onto the attachment kind domain (`image/*` → `"image"`,
 * `text/*` → `"text"`). Returns `null` for anything else — a defensive
 * guard: dehydrate passes such parts through UNCHANGED (Rust is the
 * authoritative validator; this boundary never invents kinds it cannot
 * persist).
 */
function attachmentKindForMediaType(mediaType: string): AttachmentKind | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("text/")) return "text";
  return null;
}

/** Result of {@link dehydrateAttachments}. */
export interface DehydratedDelta {
  /** Delta with data-URL file parts swapped to `attachment://{id}` refs.
   * Messages without eligible parts pass through BY REFERENCE. */
  readonly messages: SessionMessage[];
  /** Per-message-id attachment inputs, in position order. Empty for
   * messages without attachments. */
  readonly attachmentsByMessage: Map<string, AttachmentInput[]>;
}

/**
 * Dehydrate a turn delta for persistence (plan D3): walk USER messages with
 * array content; for each `FilePart` whose `data` is a base64 data URL of an
 * `image/*` / `text/*` media type, mint an attachment id
 * (`crypto.randomUUID()`), carry the base64 payload verbatim (sliced after
 * the data-URL comma — no decode/re-encode round-trip, so multi-byte
 * content needs no handling here), and swap the part's `data` to
 * `attachment://{id}` in a COPIED message.
 *
 * Everything else — non-user messages, string content, non-file parts,
 * non-data-URL data, unsupported media types — passes through untouched, by
 * reference. Message count and order are strictly preserved.
 */
export function dehydrateAttachments(
  delta: SessionMessage[],
): DehydratedDelta {
  const attachmentsByMessage = new Map<string, AttachmentInput[]>();
  const messages = delta.map((message) => {
    if (message.role !== "user") return message;
    const { content } = message;
    if (!Array.isArray(content)) return message;

    let position = 0;
    let touched = false;
    const rewrittenContent = content.map((part) => {
      if (
        part.type !== "file" ||
        typeof part.data !== "string" ||
        !part.data.startsWith(DATA_URL_PREFIX)
      ) {
        return part;
      }
      const kind = attachmentKindForMediaType(part.mediaType);
      if (kind === null) return part; // unsupported media type — leave as-is
      const comma = part.data.indexOf(",");
      if (comma === -1) return part; // malformed data URL — leave as-is
      const id = crypto.randomUUID();
      touched = true;
      const input: AttachmentInput = {
        id,
        position,
        kind,
        mime: part.mediaType,
        filename: part.filename ?? FALLBACK_FILENAME,
        dataBase64: part.data.slice(comma + 1),
      };
      position += 1;
      const existing = attachmentsByMessage.get(message.id);
      if (existing) existing.push(input);
      else attachmentsByMessage.set(message.id, [input]);
      return { ...part, data: `${ATTACHMENT_REF_PREFIX}${id}` };
    });
    return touched ? { ...message, content: rewrittenContent } : message;
  });
  return { messages, attachmentsByMessage };
}

/** Byte fetcher used by {@link hydrateAttachments}; `null` = row missing. */
export type AttachmentFetcher = (id: string) => Promise<ArrayBuffer | null>;

/**
 * Hydrate persisted `attachment://{id}` refs back into
 * `data:{mime};base64,…` data URLs (plan D3). Fetches for all refs run
 * concurrently (`Promise.all`); each result is swapped into a COPIED
 * message. Non-user messages, non-ref parts, and messages without refs pass
 * through by reference; message count and order are strictly preserved.
 *
 * NEVER throws (the `loadMessages` contract):
 * - a rejected fetch is defensively degraded to `null` (missing row);
 * - a missing row degrades that single part to a TextPart
 *   `[Attachment unavailable: {filename}]` and logs
 *   `attachment.hydrate.missing` with snake_case fields (ADR-0016).
 */
export async function hydrateAttachments(
  messages: SessionMessage[],
  fetcher: AttachmentFetcher,
): Promise<SessionMessage[]> {
  // Pass 1: collect every ref and kick off its fetch (deduped by id —
  // the same attachment can be referenced by multiple parts in theory).
  const inflight = new Map<string, Promise<ArrayBuffer | null>>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const { content } = message;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== "file" || typeof part.data !== "string") continue;
      if (!part.data.startsWith(ATTACHMENT_REF_PREFIX)) continue;
      const id = part.data.slice(ATTACHMENT_REF_PREFIX.length);
      if (!inflight.has(id)) {
        // Defensive catch-all: a rejecting fetcher must never break the
        // never-throws contract — degrade to "missing row".
        inflight.set(
          id,
          Promise.resolve(fetcher(id)).then(
            (buf) => buf,
            () => null,
          ),
        );
      }
    }
  }
  if (inflight.size === 0) return messages;

  const bytesById = new Map<string, ArrayBuffer | null>();
  await Promise.all(
    Array.from(inflight.entries(), async ([id, promise]) => {
      bytesById.set(id, await promise);
    }),
  );

  // Pass 2: rebuild only the messages that carry refs.
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const { content } = message;
    if (!Array.isArray(content)) return message;
    let touched = false;
    const rewrittenContent = content.map(
      (part): typeof part => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        if (!part.data.startsWith(ATTACHMENT_REF_PREFIX)) return part;
        const id = part.data.slice(ATTACHMENT_REF_PREFIX.length);
        const bytes = bytesById.get(id) ?? null;
        touched = true;
        if (bytes === null) {
          logger.warn("attachment.hydrate.missing", {
            attachment_id: id,
            message_id: message.id,
          });
          const degraded: TextPart = {
            type: "text",
            text: `[Attachment unavailable: ${part.filename ?? FALLBACK_FILENAME}]`,
          };
          return degraded;
        }
        const hydrated: FilePart = {
          ...part,
          data: `data:${part.mediaType};base64,${base64Encode(new Uint8Array(bytes))}`,
        };
        return hydrated;
      },
    );
    return touched ? { ...message, content: rewrittenContent } : message;
  });
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
 * Index of the LAST `role === "assistant"` message in `delta`, or `-1` if
 * none (defensive — every real turn has at least one assistant). Used by
 * {@link TauriSessionStore.appendMessages} to attach per-turn usage per
 * ADR-0030 §2. Backwards scan so it stops on the first hit.
 */
function lastAssistantIndex(delta: readonly SessionMessage[]): number {
  for (let i = delta.length - 1; i >= 0; i--) {
    if (delta[i].role === "assistant") return i;
  }
  return -1;
}

/**
 * Project a {@link SessionMessage} onto the IPC {@link Message} shape. Strips
 * the three metadata fields (`id`, `sessionId`, `createdAt`) via
 * {@link toModelMessage} and carries them as sibling columns instead.
 *
 * `usage` (optional, ADR-0030) attaches per-turn `inputTokens` /
 * `outputTokens` to this single row. `undefined → null` per ADR-0030 §4
 * (preserves the "unknown" vs "real zero" distinction end to end); a real
 * `0` is stored verbatim. When `usage` is omitted the resulting `Message`
 * leaves both fields `undefined` so they are absent from the JSON payload
 * and Rust writes NULL via the column default.
 */
function sessionMessageToMessage(
  sessionMessage: SessionMessage,
  usage?: { inputTokens?: number; outputTokens?: number },
): Message {
  const base = {
    id: sessionMessage.id,
    conversationId: sessionMessage.sessionId,
    body: toModelMessage(sessionMessage),
    createdAt: sessionMessage.createdAt,
  };
  if (usage === undefined) return base;
  return {
    ...base,
    usageInputTokens: usage.inputTokens ?? null,
    usageOutputTokens: usage.outputTokens ?? null,
  };
}
