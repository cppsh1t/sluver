/**
 * ConversationRuntimeProvider + companion hooks — the React binding for the
 * conversation runtime store.
 *
 * The Provider owns exactly one vanilla zustand store for the lifetime of the
 * Space window (mounted in `_space.tsx`). It resolves the bound model for each
 * role via `useResolvedModelConfig` (ADR-0023 — live resolution), builds a
 * `ModelResolver` + `onPersistError`, and exposes both — plus the store and
 * `spaceId` — via React Context.
 *
 * The hooks are thin: each reads the store (and where needed the resolver /
 * persist-error handler) from context and forwards to a store action. Selectors
 * target stable references (the `view` object, a boolean, a string) so plain
 * `useStore` with default `Object.is` equality is correct — no `useShallow`
 * needed.
 *
 * Related: ADR-0011 (one Space per window), ADR-0023 (live model resolution),
 * ADR-0024 (in-flight run survival across navigation).
 */

import { useStore, type StoreApi } from "zustand";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createLanguageModel } from "@/lib/ai";
import { useResolvedModelConfig } from "@/hooks/use-ai-config";
import { logger } from "@/lib/logger";
import {
  EMPTY_VIEW,
  createConversationRuntimeStore,
  type ConversationRuntimeState,
  type ConversationView,
  type ModelResolver,
  type PersistErrorHandler,
  type ResolvedModel,
} from "./store";

import type { Conversation, ConversationId, SpaceId } from "@/types";

// ─── Context ──────────────────────────────────────────────────────────────

interface ConversationRuntimeContextValue {
  readonly store: StoreApi<ConversationRuntimeState>;
  readonly spaceId: SpaceId;
  readonly modelResolver: ModelResolver;
  readonly onPersistError: PersistErrorHandler;
}

const ConversationRuntimeContext = createContext<ConversationRuntimeContextValue | null>(
  null,
);

function useRuntimeContext(): ConversationRuntimeContextValue {
  const ctx = useContext(ConversationRuntimeContext);
  if (!ctx) {
    throw new Error(
      "useConversation* hooks must be used within a <ConversationRuntimeProvider>.",
    );
  }
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────

interface ConversationRuntimeProviderProps {
  readonly spaceId: SpaceId;
  readonly children: ReactNode;
}

/**
 * Mount the conversation runtime for one Space window.
 *
 * The store is created once (`useRef` lazy init) so its lifetime is bound to
 * this component — when `_space.tsx` unmounts (the Space window is destroyed),
 * every Agent + in-flight runHandle is garbage-collected. Hiding the window to
 * the tray does NOT unmount this component, so runs keep streaming (ADR-0024).
 */
export function ConversationRuntimeProvider({
  spaceId,
  children,
}: ConversationRuntimeProviderProps) {
  // One store per Provider instance — never recreated across renders.
  const storeRef = useRef<StoreApi<ConversationRuntimeState> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createConversationRuntimeStore(spaceId);
  }
  const store = storeRef.current;

  // Live model resolution for both roles (ADR-0023). The bound model is read
  // from the Space's AgentConfig at Agent-construction time (lazy, on first
  // send/ensure per conversation). The constructed Agent is then cached in the
  // store for this Provider's lifetime, so a model change in Settings takes
  // effect for NEW conversations immediately and for existing ones the next
  // time the Space window is reopened (the Provider unmounts, dropping all
  // cached Agents — there is no per-conversation model rebind while open).
  const explorerConfig = useResolvedModelConfig(spaceId, "explorer");
  const writerConfig = useResolvedModelConfig(spaceId, "writer");

  const modelResolver = useMemo<ModelResolver>(() => {
    return (role: string): ResolvedModel => {
      const cfg = role === "writer" ? writerConfig : explorerConfig;
      // While the Space-scoped AI config is still loading, the role's
      // configured-ness is UNKNOWN. Returning "loading" (not "unconfigured")
      // prevents `resolveAgent` from flashing a spurious MODEL_NOT_CONFIGURED
      // before the queries resolve. Both whole config objects (carrying
      // `isLoading` + `config`) are in the deps below so this builder — and
      // thus the `useEnsureRuntime` effect — re-runs the moment config lands,
      // retrying resolution. They are themselves referentially stable
      // (`useResolvedModelConfig` memoizes), so this recomputes only on real
      // value changes, not every render.
      if (cfg.isLoading) return { status: "loading" };
      if (!cfg.config) return { status: "unconfigured" };
      try {
        return { status: "ready", model: createLanguageModel(cfg.config) };
      } catch (e) {
        // Provider package not installed / factory mismatch — surface as
        // "unconfigured" rather than crashing the turn.
        logger.warn("conversation.model_resolve_failed", {
          role,
          error: String(e),
        });
        return { status: "unconfigured" };
      }
    };
  }, [explorerConfig, writerConfig]);

  const onPersistError = useCallback<PersistErrorHandler>((e) => {
    logger.error("conversation.persist_failed", { error: String(e) });
  }, []);

  const value = useMemo<ConversationRuntimeContextValue>(
    () => ({ store, spaceId, modelResolver, onPersistError }),
    [store, spaceId, modelResolver, onPersistError],
  );

  return (
    <ConversationRuntimeContext.Provider value={value}>
      {children}
    </ConversationRuntimeContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────

/**
 * Escape hatch — the raw store, for advanced selectors outside the curated
 * hooks below.
 */
export function useConversationStore(): StoreApi<ConversationRuntimeState> {
  return useRuntimeContext().store;
}

/**
 * Read the reactive `view` + `agentLoading` slice for one conversation. Two
 * independent `useStore` subscriptions (each returning a stable reference)
 * avoid the new-object-per-render trap that plain `useStore` would hit if the
 * selector built a fresh `{ view, agentLoading }` object each call.
 *
 * Returns the `EMPTY_VIEW` + `false` when the conversation isn't yet in the
 * store (before `useEnsureRuntime` runs) — the UI renders an empty state.
 */
export function useConversationView(
  worldId: string,
  conversationId: string,
): { view: ConversationView; agentLoading: boolean } {
  const { store } = useRuntimeContext();
  const view = useStore(store, (state) => {
    const data = state.worlds.get(worldId)?.get(conversationId);
    return data?.view ?? EMPTY_VIEW;
  });
  const agentLoading = useStore(store, (state) => {
    return state.worlds.get(worldId)?.get(conversationId)?.agentLoading ?? false;
  });
  return { view, agentLoading };
}

/**
 * Returns a turn driver bound to the store's `send` action, with the live
 * `modelResolver` + `onPersistError` injected from context.
 */
export function useSend(
  worldId: string,
): (conversationId: ConversationId, text: string) => Promise<void> {
  const { store, modelResolver, onPersistError } = useRuntimeContext();
  return useCallback(
    async (conversationId: ConversationId, text: string) => {
      await store
        .getState()
        .send(worldId, conversationId, text, modelResolver, onPersistError);
    },
    [store, worldId, modelResolver, onPersistError],
  );
}

/**
 * Returns an abort driver bound to the store's `abort` action.
 */
export function useAbort(
  worldId: string,
): (conversationId: ConversationId) => void {
  const { store } = useRuntimeContext();
  return useCallback(
    (conversationId: ConversationId) => {
      store.getState().abort(worldId, conversationId);
    },
    [store, worldId],
  );
}

/**
 * Read + write the composer draft for one conversation. The draft is part of
 * the per-conversation view, so it survives conversation switches (ADR-0024).
 */
export function useDraft(
  worldId: string,
  conversationId: string,
): [string, (text: string) => void] {
  const { store } = useRuntimeContext();
  const draft = useStore(
    store,
    (state) => state.worlds.get(worldId)?.get(conversationId)?.view.draft ?? "",
  );
  const setDraft = useCallback(
    (text: string) => {
      store.getState().setDraft(worldId, conversationId, text);
    },
    [store, worldId, conversationId],
  );
  return [draft, setDraft];
}

/**
 * Ensure the runtime (stateful Agent) exists for the current conversation.
 *
 * The chat view calls this on mount / when the conversation changes. It is
 * idempotent: once the Agent is constructed (or loading is in flight) the
 * effect no-ops. Returns `agentLoading` so the UI can show a spinner while the
 * persisted thread is being loaded.
 */
export function useEnsureRuntime(
  worldId: string,
  conversation: Conversation,
): boolean {
  const { store, modelResolver, onPersistError } = useRuntimeContext();
  const conversationId = conversation.id;
  const agentLoading = useStore(
    store,
    (state) => state.worlds.get(worldId)?.get(conversationId)?.agentLoading ?? false,
  );
  // `useState` gives a stable boolean that flips true once the Agent is ready,
  // so the effect doesn't re-fire on every unrelated store update.
  const [agentReady, setAgentReady] = useState(false);
  const agentExists = useStore(
    store,
    (state) => state.worlds.get(worldId)?.get(conversationId)?.agent != null,
  );

  useEffect(() => {
    if (agentExists !== agentReady) setAgentReady(agentExists);
    if (!agentExists && !agentLoading) {
      void store
        .getState()
        .ensureRuntime(worldId, conversation, modelResolver, onPersistError);
    }
  }, [
    store,
    worldId,
    conversation,
    modelResolver,
    onPersistError,
    agentExists,
    agentLoading,
    agentReady,
  ]);

  return agentLoading;
}

/**
 * Returns a remover bound to the store's `removeConversation` action. Aborts
 * any in-flight run before dropping the slot (handled inside the action).
 */
export function useRemoveConversation(
  worldId: string,
): (conversationId: ConversationId) => void {
  const { store } = useRuntimeContext();
  return useCallback(
    (conversationId: ConversationId) => {
      store.getState().removeConversation(worldId, conversationId);
    },
    [store, worldId],
  );
}

// Re-exported for the barrel (./index.ts) plus direct consumers.
export type { ConversationRuntimeState };
