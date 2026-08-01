/**
 * Conversation runtime barrel — the reactive AI-chat runtime layer.
 *
 * Public surface:
 * - {@link ./provider} — `<ConversationRuntimeProvider>` + the hook family.
 * - {@link ./store}    — the vanilla zustand store factory + reactive view types.
 *
 * Import hooks + the Provider from here:
 *
 * ```ts
 * import {
 *   ConversationRuntimeProvider,
 *   useConversationView,
 *   useSend,
 *   useAbort,
 *   useDraft,
 *   useEnsureRuntime,
 *   useRemoveConversation,
 * } from "@/lib/conversation-runtime";
 * ```
 *
 * Related: ADR-0019 (library purity), ADR-0020 (session layer),
 * ADR-0023 (live model), ADR-0024 (in-flight run survival).
 */

export {
  ConversationRuntimeProvider,
  useAbort,
  useConversationStore,
  useConversationView,
  useDraft,
  useEnsureRuntime,
  useRemoveConversation,
  useResolveApproval,
  useSend,
} from "./provider";

export {
  EMPTY_VIEW,
  createConversationRuntimeStore,
  type ConversationRuntimeData,
  type ConversationRuntimeState,
  type ConversationView,
  type ModelResolver,
  type PendingApproval,
  type PersistErrorHandler,
  type ResolvedModel,
  type StreamSegment,
  type StreamState,
  type ToolCallView,
} from "./store";
