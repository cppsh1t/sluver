# AI agent library purity boundary

**Status**: accepted.

The Agent runtime library at `src/lib/ai/agent/` is kept free of every application concern. It imports only the `ai` package, `zod`, and browser-native APIs (`crypto.randomUUID()` for run IDs). No React, no `@/lib/logger`, no `@/api` (Tauri IPC). Two design consequences follow.

Tool execution context (spaceId, worldId, database access) flows into tools via closure capture. Tools are constructed by factory functions outside the library, in `src/lib/tools/`, which can freely import `@/api`. The library treats tools as opaque `ToolSet` values and never inspects their internals. Logging is done by the consumer, not the library: the Agent emits events, and a separate helper `createAgentEventLogger(agentName)` at `src/lib/ai/agent-logging.ts` subscribes to those events and forwards them to `@/lib/logger` per the project's snake_case convention (ADR-0016) and redaction rules.

Tradeoffs:

- The rejected alternatives were a library-internal logger via an injected `AgentLogger` interface, and a library-internal tool registry with a runtime-context object. Both couple the library to a logging shape or to domain context types like `SpaceId` and `WorldId`, sacrificing reusability and testability for marginal convenience.
- The library is portable to any TypeScript project with zero adaptation. Sluver-specific concerns (which IPC commands exist, which log fields are required, which content is sensitive) all live outside it. The cost is two extra files (`agent-logging.ts`, tool factories) that would otherwise be unnecessary.
