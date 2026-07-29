# Conversation runtime cache at the Space-layout layer

**Status**: accepted.

The reactive state that drives the chat UI — each Conversation's `Agent` instance, its live `AgentRunHandle` while a turn is streaming, and the accumulated messages/tool-card state — lives in a single **zustand** store mounted at the **Space layout** (`_space.tsx`), not at the World layout or inside the chat route component. The store is keyed two levels deep: `worldId` → `conversationId` → `ConversationRuntime`. `_space.tsx` is the highest layout that stays mounted for the entire lifetime of a Space window, so the store survives every kind of in-app navigation (page switches, World switches, conversation switches) without unmounting.

Each `ConversationRuntime` holds: the `Agent` (bound to that conversation's session, constructed with the correct World's `SessionStore`), the current `AgentRunHandle` if a turn is in flight, and the reactive per-conversation view (messages, streaming deltas, tool-card/expand state, draft text, scroll position). Events arriving for a non-displayed conversation still update its runtime, so switching back to it shows the continued or finished result. World isolation is preserved: each World's runtimes are constructed with that World's own `SessionStore` and never share DB access across Worlds.

Combined with ADR-0011's amended close behavior (Space window close → hide-to-tray, renderer stays alive), an in-flight AI conversation now survives **everything except explicit exit**: switching conversations, switching Worlds, navigating the Space, and closing the window. Streams are aborted only when the Space window is actually destroyed — i.e. the user explicitly exits from the tray or quits the app — which unmounts `_space.tsx`, tears down the store, and drops the World DB connections with it.

Tradeoffs:

- The rejected alternative was mounting the store at the World layout (`_world.tsx`). That would abort in-flight runs whenever the user left one World for another, which is inconsistent with both the "background work continues" stance and the close-to-tray behavior. Keying one level higher at `_space.tsx` is the smallest layer that survives World switches.
- The rejected alternative was aborting in-flight runs on conversation switch (keeping only the displayed conversation live). That violates the explicit requirement that switching conversations preserves in-flight state, and falls short of the "AI coding tool" feel where background tasks keep running.
- Memory grows with the number of live conversations across all Worlds in the Space. There is no eviction in v1 — runtimes live until the Space window is destroyed. Each runtime is a message array + a loop reference + (when streaming) an active HTTP connection; this is bounded by the number of conversations a user actively streams into, which stays small in practice.
- zustand is the project's first client-state dependency (server state remains React Query). It was chosen over a hand-rolled `useSyncExternalStore` store for stability and ergonomics on a Map-of-reactive-slices shape; the hand-roll was rejected as reinventing a solved primitive.
