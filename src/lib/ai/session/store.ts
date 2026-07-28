/**
 * Session persistence contracts — the pure interface boundary for conversation
 * memory.
 *
 * The {@link SessionStore} interface is defined inside the library purity
 * boundary (ADR-0019): it imports only the `ai` SDK's `ModelMessage` type.
 * Concrete implementations (SQLite, IndexedDB, etc.) live **outside** the
 * library, mirroring the tool-closure-capture pattern — the library treats the
 * store as an opaque persistence service and never inspects its internals.
 *
 * Related: ADR-0019 (library purity boundary), ADR-0020 (session layer).
 */

import type { ModelMessage } from "@/lib/ai/loop";

// ─── Session message ─────────────────────────────────────────────────────

/**
 * A persisted conversation message — a {@link ModelMessage} enriched with
 * identity, session binding, and timestamp.
 *
 * The atomic unit of conversation history. The session layer converts freely
 * between `SessionMessage` (persisted, UI-ready) and `ModelMessage` (SDK-
 * internal) by adding or stripping the three metadata fields:
 * {@link toModelMessage} / {@link toSessionMessage}.
 *
 * `id` is a UUID v4 (`crypto.randomUUID()`) — sufficient as a unique
 * identifier; chronological ordering is handled by `createdAt`, not the ID.
 * `createdAt` is ISO 8601 with millisecond precision (matching `now_iso()`).
 */
export type SessionMessage = ModelMessage & {
  /** UUID v4 (`crypto.randomUUID()`) — unique per message. */
  readonly id: string;
  /** The session this message belongs to. */
  readonly sessionId: string;
  /** ISO 8601 ms-precision timestamp of when the message was created. */
  readonly createdAt: string;
};

// ─── Session record ──────────────────────────────────────────────────────

/**
 * Metadata for a persisted session. Returned by {@link SessionStore.listSessions}
 * and {@link SessionStore.createSession}.
 *
 * `meta` is an opaque escape hatch for app-specific metadata (e.g. a Scene FK,
 * display title, tags). The library does not interpret it — it stores and
 * returns it as-is. The app-side wrapper provides typed access.
 */
export interface SessionRecord {
  /** UUID v7 session identity. */
  readonly id: string;
  /** ISO 8601 ms-precision creation timestamp. */
  readonly createdAt: string;
  /** ISO 8601 ms-precision timestamp of the last message append. */
  readonly updatedAt: string;
  /**
   * Opaque app-specific metadata (e.g. Scene FK, title). The library does not
   * interpret this field — it is stored and returned verbatim. `undefined` if
   * the session has no app metadata.
   */
  readonly meta?: unknown;
}

/**
 * Initialization options for creating a new session via
 * {@link SessionStore.createSession}.
 */
export interface SessionInit {
  /**
   * Optional opaque metadata for the session (e.g. Scene FK, title).
   * The library does not interpret this.
   */
  readonly meta?: unknown;
}

// ─── Store interface ─────────────────────────────────────────────────────

/**
 * Pure persistence interface for conversation sessions.
 *
 * Defined inside the library purity boundary (ADR-0019); concrete
 * implementations live outside (e.g. `SqliteSessionStore` in the app layer).
 * The library treats the store as opaque and never inspects its internals.
 *
 * ## Write model: delta append
 *
 * {@link appendMessages} takes only the NEW messages from a turn (user message
 * + assistant response + tool messages), not the full thread. This minimizes
 * write amplification on long conversations and gives each message a stable
 * row identity. The store implementation SHOULD write the batch as a single
 * transaction.
 *
 * ## Who uses what
 *
 * - `Agent` (stateful wrapper) uses only `loadMessages` + `appendMessages`.
 * - A session manager (app layer) additionally uses `createSession` /
 *   `listSessions` / `deleteSession`.
 *
 * Related: ADR-0020 (session layer).
 */
export interface SessionStore {
  // ── Session lifecycle (used by session managers) ──

  /**
   * Create a new session record. Returns the persisted record with generated
   * `id`, `createdAt`, `updatedAt`.
   */
  createSession(init?: SessionInit): Promise<SessionRecord>;

  /**
   * List all sessions (metadata only, no messages). Order is implementation-
   * defined (typically most-recently-updated first).
   */
  listSessions(): Promise<SessionRecord[]>;

  /**
   * Delete a session AND all its messages. Should be atomic (cascade delete
   * in one transaction).
   */
  deleteSession(id: string): Promise<void>;

  // ── Messages (used by Agent) ──

  /**
   * Load all messages for a session, in chronological order. Returns an empty
   * array for a nonexistent or empty session (never throws).
   */
  loadMessages(sessionId: string): Promise<SessionMessage[]>;

  /**
   * Append new messages to a session. Called once per conversation turn with
   * the delta (user message + assistant response). The store SHOULD write the
   * batch atomically and bump the session's `updatedAt`.
   */
  appendMessages(sessionId: string, delta: SessionMessage[]): Promise<void>;
}

// ─── Conversion helpers ──────────────────────────────────────────────────

/**
 * Strip the three metadata fields from a {@link SessionMessage}, yielding a
 * plain {@link ModelMessage} suitable for feeding to `AgentLoop.run()`.
 *
 * The returned object is a new shallow copy — the input is not mutated.
 */
export function toModelMessage(message: SessionMessage): ModelMessage {
  const { id: _id, sessionId: _sessionId, createdAt: _createdAt, ...rest } = message;
  return rest as ModelMessage;
}

/**
 * Wrap a {@link ModelMessage} with persistence metadata, yielding a
 * {@link SessionMessage}. The caller supplies `sessionId`; `id` and
 * `createdAt` are generated (UUID v4 + ISO ms).
 */
export function toSessionMessage(
  message: ModelMessage,
  sessionId: string,
): SessionMessage {
  return {
    ...message,
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
  };
}
