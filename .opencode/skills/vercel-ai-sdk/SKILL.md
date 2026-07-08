---
name: vercel-ai-sdk
description: "Build AI-powered applications with the Vercel AI SDK (the `ai` npm package and `@ai-sdk/*` packages). Use when developers: (1) Ask about AI SDK functions like generateText, streamText, ToolLoopAgent, embed, or tools, (2) Want to build AI agents, chatbots, RAG systems, or text generation features, (3) Have questions about AI providers (OpenAI, Anthropic, Google, etc.), streaming, tool calling, structured output, or embeddings, (4) Use React hooks like useChat or useCompletion, (5) Need to set up the AI Gateway, (6) Are migrating from AI SDK 6.x to 7.0. Triggers on: 'AI SDK', 'Vercel AI SDK', 'generateText', 'streamText', 'add AI to my app', 'build an agent', 'tool calling', 'structured output', 'useChat', 'AI Gateway', 'migration guide', 'v6 to v7'."
---

# Vercel AI SDK

The AI SDK by Vercel (`ai` on npm) is a TypeScript toolkit for building AI applications — unified API across providers for text generation, streaming, tool calling, agents, embeddings, and framework UI integrations.

- Repo: <https://github.com/vercel/ai>
- Docs: <https://ai-sdk.dev/docs>

## Critical: Never Trust Memory for AI SDK APIs

The SDK changes frequently — APIs are renamed, removed, added across versions. Training data almost certainly contains obsolete APIs and deprecated patterns. UI hooks (`useChat`) are among the most frequently changed.

**Never write AI SDK code from memory.** Always verify APIs, options, and patterns against the documentation and source for the installed version.

### Use Bundled, Version-Matched Docs

The `ai` package ships full docs + source inside `node_modules` — always match the installed version:

1. Ensure `ai` is installed. If `node_modules/ai/` is missing, install only `ai` first (`pnpm add ai`). Add provider (`@ai-sdk/openai`) and framework (`@ai-sdk/react`) packages when the task requires them.
2. Read/grep `node_modules/ai/docs/` and `node_modules/ai/src/`.
3. Provider/framework packages bundle their own docs at `node_modules/@ai-sdk/<name>/docs/`.
4. If not in bundled docs, search <https://ai-sdk.dev/docs> (append `.md` to any docs URL for markdown; search via `https://ai-sdk.dev/api/search-docs?q=query`).
5. If you cannot find an answer, say so explicitly — do not guess.

### Keep the SDK Current

- **Installed:** `version` in `node_modules/ai/package.json`.
- **Latest:** `npm view ai version`.

If a major version (or more) behind, tell the user and recommend upgrading. Migration guides: <https://ai-sdk.dev/docs/migration-guides>.

## AI Gateway: The Fastest Way to Start

The Vercel AI Gateway provides access to models from OpenAI, Anthropic, Google, and other providers through a single API — no provider packages or multiple API keys needed.

Setup:

1. Authenticate with OIDC (for Vercel deployments) or get an AI Gateway API key.
2. Provide it via the `AI_GATEWAY_API_KEY` environment variable.
3. Reference models with `provider/model` strings.

For exact setup, authentication, and usage, read the bundled guide and <https://ai-sdk.dev/docs>.

### Choosing a Model

Never use model IDs from memory — models are released and retired frequently. Fetch the current list before writing code. Do not truncate (e.g. with `head`) so the newest models are visible:

```bash
# All available models
curl -s https://ai-gateway.vercel.sh/v1/models | jq -r '.data[].id'

# Filter by provider (e.g. anthropic, openai, google)
curl -s https://ai-gateway.vercel.sh/v1/models | jq -r '[.data[] | select(.id | startswith("anthropic/")) | .id] | reverse | .[]'
```

When multiple versions of a model exist, prefer the one with the highest version number.

## Building and Consuming Agents

Use the SDK's built-in agent abstraction (such as `ToolLoopAgent`) rather than hand-rolling tool-calling loops. For end-to-end type safety, infer the UI message type from your agent definition when consuming it on the client (e.g. with `useChat`). Consuming an agent is framework-specific: check `package.json` to detect the stack, then follow the matching quickstart.

Look up the current agent, tool, and type-safety APIs in the bundled docs (`node_modules/ai/docs/`, especially the agents section) or at <https://ai-sdk.dev/docs>.

## DevTools

AI SDK DevTools captures AI SDK calls — requests, responses, tool calls, token usage, and multi-step runs — so you can inspect exactly what your agents do. It is a separate package, intended for local development only. For setup, read the bundled DevTools documentation.

## Migrating Between Versions

For step-by-step migration from AI SDK 6.x to 7.0 (API renames, breaking changes, package-specific checks), read [references/migration-v6-to-v7.md](references/migration-v6-to-v7.md).

## After Making Changes

Run the project's type checker. Be minimal — only set options that differ from defaults, checking docs/source for the defaults rather than over-specifying. Most type errors come from remembered, now-changed APIs; re-check current docs and source when they occur.
