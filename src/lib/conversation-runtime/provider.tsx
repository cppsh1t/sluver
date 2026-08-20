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
import type { UserContent } from "ai";

import { useQueryClient } from "@tanstack/react-query";

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

import { listConversations, updateConversationTitle } from "@/api";
import { createLanguageModel } from "@/lib/ai";
import { generateConversationTitle } from "@/lib/ai/auto-title";
import {
  useAgentConfigs,
  useModelsDevCatalog,
  useResolvedModelConfig,
} from "@/hooks/use-ai-config";
import { conversationKeys } from "@/hooks/use-conversations";
import { useEnabledSkills } from "@/hooks/use-enabled-skills";
import { logger } from "@/lib/logger";
import {
  EMPTY_VIEW,
  MAX_DRAFT_ATTACHMENTS,
  createConversationRuntimeStore,
  type AutoTitleCallback,
  type ConversationRuntimeState,
  type ConversationView,
  type DraftAttachment,
  type ImageInputSupportedResolver,
  type ModelResolver,
  type PersistErrorHandler,
  type ResolvedModel,
} from "./store";
import { imageInputSupportedForModel } from "./vision";

import type { Conversation, ConversationId, SpaceId } from "@/types";

// ─── Context ──────────────────────────────────────────────────────────────

interface ConversationRuntimeContextValue {
  readonly store: StoreApi<ConversationRuntimeState>;
  readonly spaceId: SpaceId;
  readonly modelResolver: ModelResolver;
  readonly onPersistError: PersistErrorHandler;
  /**
   * Per-role vision capability for the currently bound model (ADR-0044 §D9
   * step 2). Built by the Provider from the models.dev catalog react-query
   * data (the store is non-React, so the Provider captures the resolved
   * data here and forwards it with each `send`). Tri-state: `undefined`
   * while queries load / for custom models — NEVER defaulted to `false`.
   */
  readonly resolveImageInputSupported: ImageInputSupportedResolver;
  /**
   * Silent auto-titling entry point (ADR-0040). Injected by the Provider
   * (which owns the `"namer"` agent's resolved model config) and forwarded
   * into the store's `send` by {@link useSend}. Resolves to the
   * conversation's current title — generated + persisted by us, or observed
   * from the DB when one is already set (e.g. a sidebar rename) — or `null`
   * on any skip/failure. It NEVER rejects.
   */
  readonly autoTitle: AutoTitleCallback;
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
  // The dedicated naming agent (ADR-0040) — a one-shot `generateText` call,
  // never routed through the conversation AgentLoop or the chat role picker.
  // `config: null` (model unbound / credential missing / still loading) is
  // the "not configured" gate: auto-titling silently does nothing. The
  // namer never carries skills (ADR-0043 §3) — no query for it.
  const namerConfig = useResolvedModelConfig(spaceId, "namer");
  // The dedicated vision agent (ADR-0045) — one-shot `generateText` behind
  // the `look_at` tool, shared by both roles (Space-scoped, not per-role).
  // Same "configured = enabled, silent when unconfigured" gate as the
  // namer: `config ?? null` rides the model resolver into the ToolContext;
  // unbound → the tool is simply not registered. Shares every underlying
  // react-query with the resolvers above (no extra IPC); never carries
  // skills — no query for it.
  const visionConfig = useResolvedModelConfig(spaceId, "vision");
  // Per-role enabled Agent Skills (ADR-0043 §3) — feed the `<available_skills>`
  // catalog + skill tool registration at Agent-construction time, with the
  // same live-resolution lifecycle as the model config above. Only `data` /
  // `isLoading` are read (primitives, extracted during render so react-query
  // prop-tracking sees them) — the resolver below consumes those.
  const explorerSkills = useEnabledSkills(spaceId, "explorer");
  const writerSkills = useEnabledSkills(spaceId, "writer");
  const explorerSkillsData = explorerSkills.data;
  const explorerSkillsLoading = explorerSkills.isLoading;
  const writerSkillsData = writerSkills.data;
  const writerSkillsLoading = writerSkills.isLoading;

  const modelResolver = useMemo<ModelResolver>(() => {
    return (role: string): ResolvedModel => {
      const cfg = role === "writer" ? writerConfig : explorerConfig;
      const skillsData = role === "writer" ? writerSkillsData : explorerSkillsData;
      const skillsLoading = role === "writer" ? writerSkillsLoading : explorerSkillsLoading;
      // While the Space-scoped AI config is still loading, the role's
      // configured-ness is UNKNOWN. Returning "loading" (not "unconfigured")
      // prevents `resolveAgent` from flashing a spurious MODEL_NOT_CONFIGURED
      // before the queries resolve. Both whole config objects (carrying
      // `isLoading` + `config`) are in the deps below so this builder — and
      // thus the `useEnsureRuntime` effect — re-runs the moment config lands,
      // retrying resolution. They are themselves referentially stable
      // (`useResolvedModelConfig` memoizes), so this recomputes only on real
      // value changes, not every render.
      //
      // The enabled-skills query rides the SAME gate: constructing the Agent
      // before it resolves would cache a skillless Agent for the window's
      // lifetime (ADR-0024), silently dropping the role's skills. On query
      // error `isLoading` settles false and `data` is undefined → `[]`.
      if (cfg.isLoading || skillsLoading) return { status: "loading" };
      if (!cfg.config) return { status: "unconfigured" };
      try {
        return {
          status: "ready",
          model: createLanguageModel(cfg.config),
          autoExecuteDangerousTools: cfg.autoExecuteDangerousTools,
          shellToolEnabled: cfg.shellToolEnabled,
          contextCompaction: cfg.contextCompaction,
          systemPrompt: cfg.systemPrompt,
          skills: skillsData ?? [],
          // ADR-0045 — Space-scoped vision agent config for `look_at`.
          // `null` (unbound / still loading) → tool not registered. The
          // vision query shares its react-query keys with the role config
          // above, so by the time the role is "ready" this has settled too.
          visionConfig: visionConfig.config ?? null,
        };
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
  }, [
    explorerConfig,
    writerConfig,
    visionConfig,
    explorerSkillsData,
    explorerSkillsLoading,
    writerSkillsData,
    writerSkillsLoading,
  ]);

  const onPersistError = useCallback<PersistErrorHandler>((e) => {
    logger.error("conversation.persist_failed", { error: String(e) });
  }, []);

  // ── Vision capability resolution (ADR-0044 §D9 step 2) ──────────────────
  // Same data the token-status-bar joins for `contextWindow` (the established
  // catalog-access precedent): the Space's agent configs + the global
  // models.dev catalog. Both queries are shared/cache-hit with the ones
  // `useResolvedModelConfig` runs above — no extra IPC. Only `data` is
  // extracted during render (primitive, prop-tracking friendly); the
  // resolver below consumes it per-send.
  const agentConfigs = useAgentConfigs(spaceId);
  const modelsDevCatalog = useModelsDevCatalog();
  const agentConfigsData = agentConfigs.data;
  const catalogData = modelsDevCatalog.data;

  const resolveImageInputSupported = useCallback<ImageInputSupportedResolver>(
    (role) => {
      const agentConfig = agentConfigsData?.find((a) => a.name === role);
      return imageInputSupportedForModel(
        catalogData,
        agentConfig?.modelId ?? null,
      );
    },
    [agentConfigsData, catalogData],
  );

  // QueryClient is safe to use here: the Provider mounts inside
  // QueryClientProvider (the Space layout root).
  const qc = useQueryClient();

  /**
   * Silent background auto-titling (ADR-0040). Called fire-and-forget by the
   * store after the FIRST completed assistant run on an untitled
   * conversation. Flow: DB pre-check (bails BEFORE spending an LLM call when
   * a title is already set — e.g. a sidebar rename the slot cache never
   * saw) → `generateConversationTitle` → post-generation race re-check →
   * `updateConversationTitle` + list invalidation. Resolves to the
   * conversation's current title — generated by us, or observed from the
   * DB — or `null` when nothing was done. Completely silent by contract: no
   * toasts, no UI state, failures surface only via `logger.warn`, and the
   * returned promise NEVER rejects (the store adds a defensive `.catch`
   * regardless).
   */
  const autoTitle = useCallback<AutoTitleCallback>(
    async (input) => {
      // Gate: no fully-resolved namer model → skip silently. Covers
      // "model unbound", "credential missing", and "config still loading".
      if (namerConfig.isLoading || !namerConfig.config) return null;

      try {
        // PRE-CHECK: consult the DB BEFORE spending an LLM call. The store's
        // trigger reads its SLOT-CACHED `conversation.title`, which a
        // sidebar rename never touches — without this check, every later
        // run finalization would re-fire the naming call and only discover
        // the non-null DB title afterwards (a silent wasted API call per
        // turn until the window reopens).
        const preList = await listConversations(spaceId, input.worldId);
        const existing = preList.find((c) => c.id === input.conversationId);
        // Conversation deleted in the meantime → nothing to title.
        if (!existing) return null;
        // Already titled → return the OBSERVED title (not null): the
        // store's non-null patch writes it into the slot cache,
        // permanently stopping re-triggering.
        if (existing.title !== null) return existing.title;

        let title: string;
        try {
          title = await generateConversationTitle(
            namerConfig.config,
            input.userText,
            input.assistantText,
          );
        } catch (e) {
          logger.warn("chat.auto_title.failed", {
            conversation_id: input.conversationId,
            world_id: input.worldId,
            error: String(e),
          });
          return null;
        }

        // Race guard (POST-GENERATION, covers the one-IPC race window): if
        // the user renamed (or a title otherwise landed) while the naming
        // call was in flight, never overwrite it — return the observed
        // title so the caller's cache catches up.
        const postList = await listConversations(spaceId, input.worldId);
        const current = postList.find((c) => c.id === input.conversationId);
        if (!current || current.title !== null) {
          return current?.title ?? null;
        }

        await updateConversationTitle(
          spaceId,
          input.worldId,
          input.conversationId,
          title,
        );
        // Refresh the conversation list so the new title appears.
        qc.invalidateQueries({
          queryKey: conversationKeys.all(spaceId, input.worldId),
        });
        return title;
      } catch (e) {
        logger.warn("chat.auto_title.failed", {
          conversation_id: input.conversationId,
          world_id: input.worldId,
          error: String(e),
        });
        return null;
      }
    },
    [spaceId, namerConfig, qc],
  );

  const value = useMemo<ConversationRuntimeContextValue>(
    () => ({
      store,
      spaceId,
      modelResolver,
      onPersistError,
      resolveImageInputSupported,
      autoTitle,
    }),
    [
      store,
      spaceId,
      modelResolver,
      onPersistError,
      resolveImageInputSupported,
      autoTitle,
    ],
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
 * `modelResolver` + `onPersistError` + `resolveImageInputSupported` +
 * `autoTitle` injected from context.
 *
 * The outgoing content is the SDK's `UserContent` (ADR-0044): a plain string
 * (the historical form — existing string callers compile unchanged) or a
 * parts array carrying text + image/text file attachments (data-URL `data`).
 */
export function useSend(
  worldId: string,
): (conversationId: ConversationId, content: UserContent) => Promise<void> {
  const { store, modelResolver, onPersistError, resolveImageInputSupported, autoTitle } =
    useRuntimeContext();
  return useCallback(
    async (conversationId: ConversationId, content: UserContent) => {
      await store
        .getState()
        .send(
          worldId,
          conversationId,
          content,
          modelResolver,
          onPersistError,
          autoTitle,
          resolveImageInputSupported,
        );
    },
    [
      store,
      worldId,
      modelResolver,
      onPersistError,
      resolveImageInputSupported,
      autoTitle,
    ],
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
 * Read + write the staged attachments for one conversation (ADR-0044 §D8) —
 * mirrors {@link useDraft}'s shape. The list is part of the per-conversation
 * view, so it survives conversation switches (ADR-0024); `send` clears it.
 *
 * `addAttachments` performs NO mime/size validation (Rust validates
 * authoritatively; the composer pre-validates in Wave 3) — only the
 * {@link MAX_DRAFT_ATTACHMENTS} count cap is enforced (overflow ignored).
 */
export function useDraftAttachments(
  worldId: string,
  conversationId: string,
): {
  draftAttachments: DraftAttachment[];
  addAttachments: (items: DraftAttachment[]) => void;
  removeAttachment: (id: string) => void;
  maxAttachments: number;
} {
  const { store } = useRuntimeContext();
  // Stable `[]` fallback (EMPTY_VIEW's array is a module constant) so the
  // selector keeps default Object.is equality semantics.
  const draftAttachments = useStore(
    store,
    (state) =>
      state.worlds.get(worldId)?.get(conversationId)?.view.draftAttachments ??
      EMPTY_VIEW.draftAttachments,
  );
  const addAttachments = useCallback(
    (items: DraftAttachment[]) => {
      store.getState().addDraftAttachments(worldId, conversationId, items);
    },
    [store, worldId, conversationId],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      store.getState().removeDraftAttachment(worldId, conversationId, id);
    },
    [store, worldId, conversationId],
  );
  return {
    draftAttachments,
    addAttachments,
    removeAttachment,
    maxAttachments: MAX_DRAFT_ATTACHMENTS,
  };
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

/**
 * Returns a resolver bound to the store's `resolveApproval` action. Called by
 * the consent UI when the user approves or denies a tool call.
 */
export function useResolveApproval(
  worldId: string,
): (conversationId: ConversationId, toolCallId: string, approved: boolean) => void {
  const { store } = useRuntimeContext();
  return useCallback(
    (conversationId: ConversationId, toolCallId: string, approved: boolean) => {
      store.getState().resolveApproval(worldId, conversationId, toolCallId, approved);
    },
    [store, worldId],
  );
}

// Re-exported for the barrel (./index.ts) plus direct consumers.
export type { ConversationRuntimeState };
