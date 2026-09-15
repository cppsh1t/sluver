# ADR-0053: Chapter-scoped conversations — per-chapter listing, construction-time context injection, two-level cascade sweep

**Status**: accepted. Extends ADR-0022 (its reserved "future per-chapter chat" is now real); implemented end to end (backend command, runtime injection, chapter-editor panel, deletion sweeps).

## Context

The chapter editor's edit mode gained a right-side agent chat panel — conversations are created, switched, renamed, and deleted from a corner menu, the newest conversation is auto-selected, and nothing is ever auto-created. ADR-0022 already reserved the storage design: conversations live in `world.db`, `meta.kind: "chapter"` carries the camelCase `chapterId`, and the chapter FK never crosses a DB boundary. That reservation left three decisions open — how chapter conversations are listed, how the agent learns which chapter it is attached to, and what happens to them when a chapter or novel dies. This ADR records those three decisions. (UI affordances are not the decision and get no further ink.)

## Decision

### 1. Listing via a dedicated command, not a filter parameter

A new `list_chapter_conversations(space_id, world_id, chapter_id)` (`src-tauri/src/commands/conversation.rs`, with the usual `do_*` split for no-mock-runtime tests) returns the `kind = 'chapter'` conversations bound to one chapter, `ORDER BY updated_at DESC`. Newest-first is load-bearing: the panel auto-selects `conversations[0]`, so the ordering contract is what makes "reopen the chapter, land in the most recently touched chat" work with zero extra state. The World chat page's `list_conversations` stays `kind = 'world'`-only, unchanged — each surface reads exactly its own rows.

Zero schema migration: the chapter linkage lives entirely in the `meta` JSON column, so this is one prepared statement. The camelCase SQLite JSON path (`meta->>'chapterId'`) is load-bearing in both directions — `create_conversation` builds meta server-side and writes `{"kind":"chapter","chapterId":...}`, and a snake_case read would silently match nothing (no error, empty list). The same invariant is stated in the command's doc comment because it is invisible to both the type system and any test that hand-writes meta.

Frontend side, `conversationKeys.chapter(spaceId, worldId, chapterId)` (`src/hooks/use-conversations.ts`) is a structural child of `conversationKeys.all(...)`: `["conversations", spaceId, worldId, "chapter", chapterId]` extends the `all` prefix, so the existing create/rename/delete/auto-title invalidations — which all target `all(...)` — prefix-match the per-chapter query for free. No dual invalidation anywhere.

**Rejected:** widening `list_conversations` with a kind/chapter filter parameter. One consumer would pay for a permanently wider command surface on the hottest list path, and ADR-0022's Q6b reservation already anticipated dedicated per-chapter commands rather than a parameterized world list.

### 2. Chapter context is injected at agent construction, never persisted

For chapter-kind conversations, the conversation runtime (`src/lib/conversation-runtime/store.ts::constructAgent`) awaits a `buildChapterContextBlock` — one `getChapter` read — and appends the resulting `<chapter_context>` block **last** in the effective system prompt, after the role base prompt + context note, the subagent roster, the look_at teaching, and the skills catalog. The block carries the chapter title (a blank title degrades to the title-less form), the `chapter_id`, the `novel_id`, and a pointer to the `get_chapter_overview` tool: the model is told which chapter it is attached to and how to pull structure on demand, not handed the structure inline.

The build is tolerant: a rejecting `getChapter` (chapter deleted, cross-window race, IPC hiccup) logs `logger.warn("chat.chapter_context.failed", …)` and resolves `null` — the block is skipped and Agent construction proceeds anyway. An accepted consequence of construction-time injection: agents are cached per Space-window lifecycle (ADR-0024), so a chapter renamed mid-window does not refresh an already-constructed agent's prompt until the runtime cache is torn down. The `chapter_id` anchor itself is stable, so tool calls stay correctly targeted; renames mid-chat are rare enough that the stale title is the cheaper defect.

Nothing chapter-related ever enters the persisted thread — `meta` already held the linkage, and the block is pure prompt-side state.

**Rejected:** injecting via a first-turn tool result or user message (pollutes the Persisted Thread, which ADR-0028 keeps verbatim, and auto-title text extraction would read it); per-turn re-resolution of the block (churn against a cached agent for no benefit — the anchor id never changes).

### 3. Chapter/novel deletion sweeps conversations two levels deep, inside the delete transaction

The `meta`-JSON linkage is invisible to SQLite FKs, so `do_delete_chapter` and `do_delete_novel` (`src-tauri/src/commands/novel.rs`) sweep explicitly, in order, all inside the delete transaction:

1. `kind = 'subagent'` children whose `meta->>'parentConversationId'` is in the swept set (ADR-0050 run conversations parented to chapter conversations);
2. the `kind = 'chapter'` conversations themselves;
3. then the chapter/novel row delete (whose FK cascade handles scenes/chapters as before).

Children-before-parents order is load-bearing: once the `kind = 'chapter'` parents are gone, the child subquery finds nothing and the orphans would outlive their anchor forever. On the novel path the sweeps must additionally resolve before `DELETE FROM novels`, because that row's FK cascade takes the chapter rows — the join source of `meta->>'chapterId' IN (SELECT id FROM chapters WHERE novel_id = ?1)` — with it. Swept conversations' messages and attachment blobs ride the existing FK cascade chain (conversations → messages → message_attachments, world migration 013). Zero swept rows is fine; only a missing chapter/novel is a `NotFound`, and the transaction rollback keeps that error path side-effect-free.

This extends `do_delete_conversation`'s subagent-child sweep precedent to two more deletion paths; all the relevant doc comments carry the CASCADE DISCLOSURE per the ADR-0006 convention. World-kind conversations (and subagent runs parented to them) are novel-independent and survive novel deletion — they die only with the World.

**Rejected:** orphan-tolerant acceptance (rows + messages + blobs accumulate forever, unreachable from any UI — the exact bug class two review passes flagged on this very feature); a janitor pass at world open (deferred, invisible correctness cost, and it would have to replicate the two-level sweep anyway).

## Consequences

- Auto-titling works for chapter conversations with zero changes to the namer flow: the pre-check and post-generation race guard resolve the conversation via `getConversation` (which fetches any kind) instead of searching the world-only list, so they were already kind-agnostic — chapter conversations get auto-titled by the namer agent per ADR-0040.
- Subagent runs are unaffected by the injection: `buildChapterContextBlock` returns `null` for any non-`chapter` meta, and runs are dispatched briefs, not chapter conversations. They are, however, the second level of the deletion sweep — deleting a chapter conversation (or its chapter) takes its runs with it.
- The panel shares the `ConversationView` / consent-gate machinery unchanged (ADR-0025 / ADR-0050), including the subagent drill-in; only conversation selection and lifecycle wiring are panel-local.
- Deletion is silent on the backend: the ADR-0006 disclosure convention is honored in the `do_delete_*` doc comments, but no UI disclosure dialog was added enumerating the conversations (and runs) that die with a chapter or novel. The panel's own delete confirm shows only the conversation title, matching the World chat list. A fuller UI disclosure is possible future work.
- Renames mid-chat leave a stale chapter title in a cached agent's prompt until the window's runtime cache drops (§2, accepted); the chapter id anchor stays correct regardless.

## References

- ADR-0022 (extended — its per-chapter reservation is now real), ADR-0024 (conversation runtime cache, why injection is construction-time), ADR-0028 (three-layer message model, why the block is prompt-side and never a message), ADR-0050 (subagent runs — the children level of the sweep), ADR-0006 (deletion disclosure convention), ADR-0040 (auto-titling), ADR-0001 / ADR-0004 (world isolation, why the chapter FK never crosses a DB boundary)
