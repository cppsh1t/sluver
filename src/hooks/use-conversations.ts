import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createConversation,
  deleteConversation,
  listConversations,
  updateConversationTitle,
} from "@/api";
import type { CreateConversationInput } from "@/api";
import type { Conversation, ConversationId, WorldId } from "@/types";

// ─── Query keys ───────────────────────────────────────────────────────────

/**
 * Query keys for the conversation surface. Each (space, world) pair gets its
 * own key namespace so invalidation can be scoped precisely.
 */
export const conversationKeys = {
  all: (spaceId: string, worldId: WorldId) =>
    ["conversations", spaceId, worldId] as const,
};

// ─── Queries ──────────────────────────────────────────────────────────────

export const useConversations = (spaceId: string, worldId: WorldId) =>
  useQuery({
    queryKey: conversationKeys.all(spaceId, worldId),
    queryFn: () => listConversations(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

// ─── Mutations ────────────────────────────────────────────────────────────

export const useCreateConversation = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConversationInput) =>
      createConversation(spaceId, worldId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: conversationKeys.all(spaceId, worldId) }),
  });
};

export const useDeleteConversation = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ConversationId) => deleteConversation(spaceId, worldId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: conversationKeys.all(spaceId, worldId) }),
  });
};

export const useRenameConversation = (spaceId: string, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      title,
    }: {
      conversationId: ConversationId;
      title: string;
    }) => updateConversationTitle(spaceId, worldId, conversationId, title),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: conversationKeys.all(spaceId, worldId) }),
  });
};

export type { Conversation };
