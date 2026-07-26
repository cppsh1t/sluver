# Frontend agent loop with ToolLoopAgent

**Status**: accepted.

The agent loop runs in the TypeScript frontend, using the AI SDK v7 `ToolLoopAgent` class as the loop core, a custom `useConversation` React hook for UI consumption, and `UIMessage` (via `InferAgentUIMessage`) as the single message type. Session persistence is deferred.

The deciding reason for the frontend is the AI SDK ecosystem. Building the provider abstraction, streaming, tool-call parsing, and the ReAct loop from scratch in Rust would duplicate what `ToolLoopAgent` + the `@ai-sdk/*` provider packages already give us. The "tools go through IPC" cost is negligible: Tauri `invoke()` is sub-millisecond in-process, dwarfed by LLM latency, and the Rust commands that tools call (`search_characters`, `update_scene_content`, …) must exist regardless for the UI's own data display.

`ToolLoopAgent` is preferred over hand-rolling a loop around `streamText` because the SDK's own guidance says to use the built-in agent abstraction, and it already handles context management, `stopWhen` conditions, lifecycle callbacks (`onStepEnd` for tracing), and `prepareStep` hooks. Wrapping `streamText` would re-implement what the SDK ships.

A custom `useConversation` hook is used instead of the SDK's `useChat` for two reasons. First, `@ai-sdk/react` is not installed and `useChat` is designed around an HTTP transport (`DefaultChatTransport` → `fetch` to an API route) — Tauri has no HTTP server. Second, `useChat`'s assumptions about routing and message IDs do not align with sluver's multi-agent, multi-world model. The hook wraps `agent.stream()` → `createAgentUIStream` → `readUIMessageStream`, building up `UIMessage[]` state directly.

`UIMessage` is the sole message type. Its `parts` array model — with typed `tool-{name}` parts carrying a state lifecycle (`input-streaming` → `input-available` → `output-available`) — is exactly what's needed for the rich UI: real-time in-progress tool display, click-to-expand result cards, and bespoke React components per tool type. `InferAgentUIMessage<typeof agent>` provides end-to-end type safety from tool definition to UI render.

Pi-agent's two-layer custom message system (`AgentMessage` with `BashExecutionMessage`/`CompactionSummaryMessage` etc. → `convertToLlm` → `Message`) is **not** replicated. That design was necessary because pi-agent built its loop from scratch and needed internal bookkeeping types that are neither standard LLM messages nor UI parts. The AI SDK already maintains a two-layer system internally (`UIMessage` for UI ↔ `CoreMessage` for model) and handles the conversion. In sluver, structured data flows through tool results (`part.output`), which UIMessage renders natively — no parallel custom message layer is needed. If context compression is added later, the SDK's `prepareStep` / context-management hooks are the intended extension point, not a custom message type.

System instructions are passed as a required parameter to `createAgent()` (the factory function) and do not touch the database in v1. The `Agent` model (`{id, name, modelId}`) has no `systemPrompt` field yet; where instructions ultimately live (Agent table column, separate config, user-editable) is a future decision.

Test tools (`add`, `time`) are included as temporary stubs under `agent/tools/` to prove the tool-calling mechanism end-to-end. They will be replaced by real worldbook/novel tools.

Tradeoffs:

- **AbortSignal does not propagate through IPC.** The TS layer can abort the LLM call, but a tool mid-flight in a Rust command won't receive the signal. Acceptable for v1 (tools are fast queries); a cancellation protocol can be added later.
- **No `useChat` means no built-in optimistic UI, retry, or persistence.** The custom hook owns all of this — more code, but full control. Acceptable because the hook is ~80 lines and session persistence is deferred anyway.
- **API keys live in frontend memory during a conversation.** They are fetched from `space.db` via IPC at conversation start and held in the `LanguageModel` instance. This is the same single-user-desktop threat model as storing them in `space.db` (ADR-0013) — the webview is local, not a remote browser.
