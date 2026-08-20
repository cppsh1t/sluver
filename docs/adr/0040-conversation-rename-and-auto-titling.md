# Conversation rename + auto-titling via the non-conversational `namer` agent

**Status**: accepted.

Conversations launch untitled (`title` NULL — the list renders a placeholder) and, before this, could never be named. Two additions:

## 1. Rename (user-initiated)

`update_conversation_title` Tauri command mirrors `update_conversation_plan` (blind `UPDATE ... SET title, updated_at` + `rows_affected == 0 → NotFound`). Renaming bumps `updated_at` so the recency-sorted conversation list reorders — consistent with how `append_messages` already floats active conversations. The chat sidebar gains inline rename (double-click title or hover pencil button; Enter/blur commits, Escape cancels) following the note-tree pattern.

## 2. Auto-titling (system-initiated)

A third AgentConfig named `"namer"`, seeded exactly like `explorer`/`writer` (`do_create_space` loop + `SPACE_MIGRATION_007` `INSERT OR IGNORE` for pre-existing Spaces — the migration runs at connection open, i.e. before the seed loop, so both INSERTs must be conflict-tolerant against the `name` UNIQUE constraint).

Key properties:

- **Not a chat role.** `namer` is never added to `ROLE_BEHAVIOR` nor to the conversation-list role picker (hardcoded `["explorer", "writer"]`) — it is structurally not user-invokable as a conversation partner. ADR-0023's role binding is about *conversations*; `namer` binds to no conversation and carries no behavior bundle.
- **Configured = enabled.** Its card on the Space config page shows only the model picker (auto-execute / context-compaction / system-prompt override are meaningless for a one-shot call and are hidden for this role). `model_id NULL` — the seed default — means auto-titling is silently disabled. Configuring a model is the opt-in gate; there is no separate enable flag.
- **First one-shot LLM usage.** Auto-titling bypasses `AgentLoop` / `Agent` / `SessionStore` entirely: a pure module calls `generateText` on `createLanguageModel(resolved namer config)` — no tools, no loop, no persistence. ADR-0019's purity boundary is preserved (the module is React-free; resolution is injected from the provider layer). The prompt input is the conversation's first user message **truncated to its first 1500 chars** — nothing else. *(Amended: originally the last assistant reply (≤1500 chars) was sent alongside; it was dropped for token economy — the title names the topic, and the topic is established up front. The trigger timing below is unchanged; only the prompt payload shrank.)*
- **Trigger: run finalization.** The conversation runtime store's single termination point (ADR-0018 guarantees all runs resolve there) fires when `conversation.title == null` **and the run completed cleanly** — aborted/errored runs resolve there too but never trigger titling (their partial streamed text is not title material). The call is fire-and-forget, guarded by an in-flight flag on the runtime slot. The callback title-checks the DB **before** generating (a title that landed externally — e.g. a user rename — is returned as-is) and re-checks **after** generating (the one-IPC race window); either check's observed title is written back into the slot's cached conversation, which permanently stops re-triggering. On a clean path it persists via `update_conversation_title`, invalidates the conversations query, and patches the cache — the title becoming non-null is what prevents re-triggering on later runs.
- **Silent by design.** No toasts, no UI state; failures surface only via `logger.warn` (`chat.auto_title.*`, snake_case fields per ADR-0016). The title is generated in the language of the user's first message, post-processed (surrounding quotes stripped, whitespace collapsed, length clamped).

## Tradeoffs

- **Rejected: routing `namer` through `AgentLoop`.** A tool loop, streaming, and session persistence are all wrong for a single completion, and it would require a `ROLE_BEHAVIOR` entry — blurring "role = conversation behavior bundle".
- **Rejected: titling mid-stream (before the reply finishes).** The trigger still waits for the first completed exchange — it reuses the one existing termination hook instead of adding a mid-stream one, and aborted/errored runs (whose partial text is not title material) stay excluded. *(Amended: an earlier version also included the assistant reply in the prompt for title quality on thin openers like "hello"; that input was later dropped — token economy won, accepting vaguer titles for thin first messages. The user can always rename.)*
- **Rejected: a dedicated `titled` boolean.** `title == null` is the natural discriminator; once set — by user or by namer — it is never returned to null (there is no un-title flow), so user renames permanently suppress auto-titling for that conversation.
- **Accepted race window:** a manual rename landing between the pre-write re-check and the `UPDATE` could still be overwritten; the window is one IPC round-trip and judged negligible.
- **`namer` appears in every `list_agent_configs` result.** Consumers that assumed exactly `explorer` + `writer` must filter by name; the Space config page (the only generic consumer) handles it via the role-variant card.
