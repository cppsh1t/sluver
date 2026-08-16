/**
 * Conversation / Message IPC API.
 *
 * Persists AI chat transcripts scoped to a Space + World. A Conversation
 * is anchored to either the whole world or a single chapter (via `meta`).
 */

import type { Conversation, ConversationId, Message, WorldId } from '@/types';
import { call } from './client';
import type { CreateConversationInput } from './types';

// ─── Conversation ────────────────────────────────────────────────────────────

export function listConversations(spaceId: string, worldId: WorldId): Promise<Conversation[]> {
  return call<Conversation[]>('list_conversations', { spaceId, worldId });
}

export function createConversation(
  spaceId: string,
  worldId: WorldId,
  input: CreateConversationInput,
): Promise<Conversation> {
  return call<Conversation>('create_conversation', { spaceId, worldId, input });
}

export function deleteConversation(spaceId: string, worldId: WorldId, id: ConversationId): Promise<void> {
  return call<void>('delete_conversation', { spaceId, worldId, id });
}

/**
 * Update a conversation's Plan (the per-Conversation working agenda, ADR-0028).
 * Pass `null` to remove the plan field; pass a Plan object to set/replace it.
 * The Plan is stored at `meta.plan`; other meta fields (kind, chapterId) are preserved.
 */
// TODO: tighten to Plan type once src/lib/ai/session/plan.ts lands (T2).
export function updateConversationPlan(
  spaceId: string,
  worldId: string,
  conversationId: string,
  plan: unknown | null,
): Promise<void> {
  return call<void>('update_conversation_plan', {
    spaceId,
    worldId,
    conversationId,
    plan,
  });
}

/**
 * Rename a conversation (user-initiated inline rename in the chat sidebar).
 */
export function updateConversationTitle(
  spaceId: string,
  worldId: WorldId,
  conversationId: string,
  title: string,
): Promise<void> {
  return call<void>('update_conversation_title', {
    spaceId,
    worldId,
    conversationId,
    title,
  });
}

// ─── Message ─────────────────────────────────────────────────────────────────

export function loadMessages(
  spaceId: string,
  worldId: WorldId,
  conversationId: ConversationId,
): Promise<Message[]> {
  return call<Message[]>('load_messages', { spaceId, worldId, conversationId });
}

export function appendMessages(
  spaceId: string,
  worldId: WorldId,
  input: { conversationId: ConversationId; messages: Message[] },
): Promise<void> {
  return call<void>('append_messages', { spaceId, worldId, input });
}
