# ADR-0047: User-initiated message mutations

**Status**: accepted.

## Context

The chat UI gains per-message hover actions: copy, edit, and delete. Copy is read-only and does not concern this ADR. Edit and delete do: they are the first features that need to remove or rewrite what is already in the Persisted Thread, which ADR-0028 invariant 1 declared append-only ("no transform may mutate it in place"). Until now the user could add to the thread but never take anything back.

The two mutations as built:

- **Edit is an in-place body edit, and it applies to both roles.** The text of a user message and the text parts of an assistant message are editable in place; saving persists the new content. An earlier design was edit-and-resend (delete the edited message plus everything after it, then submit the new text through the normal send path). It was rejected: the user's explicit requirement is that editing is content correction, not conversation branching. Fixing a typo or trimming a bad paragraph must not discard every turn that followed, and rewriting what an assistant message "said" has no resend equivalent anyway. So an edit triggers no resend, no truncation, no re-run: the next run simply derives its input from the edited thread.
- **Delete is a single logical message, pair-aware.** Deleting an assistant message that carries tool-call parts also deletes the tool messages answering those calls; deleting a tool message expands to its parent assistant message plus its siblings. Without this expansion the next Derived Model Input would contain dangling tool calls or orphaned tool results, which provider APIs reject or silently starve.

Two further constraints shape the mechanics. Messages have no position column, and same-turn messages can share `created_at` down to the millisecond, so there is no order-preserving cut the backend could compute on its own; thread order is known only to the client's in-memory copy. And the runtime library's purity boundary (ADR-0019) plus the settled `SessionStore` interface (ADR-0020) are surfaces we do not want to widen for a UI affordance.

## Decision

### 1. The relaxation, precisely scoped

ADR-0028 invariant 1 is relaxed from "append-only; no transform may mutate it in place" to:

> **Append-only under agent operation. User-initiated mutations are the sole sanctioned transform of the Persisted Thread.**

"Agent operation" covers everything the runtime does on its own: user submissions, Run Delta appends (including abort/error partials, ADR-0018), and the pipeline transforms, which operate on the Derived Model Input and still never touch the thread. The only writer permitted to remove or rewrite is an explicit user action. ADR-0028 is not rewritten; this ADR carves the exception, and its invariants 2 through 5 stand unchanged. The view invariant now reads: `view.messages` is a 1:1 mirror of the (possibly mutated) thread.

### 2. Mutation shapes

**`deleteMessage(id)`** expands one clicked message to the full id set:

| Clicked                                                | Deleted                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Plain user or assistant message (no tool parts)        | itself                                                                           |
| Assistant message carrying `ToolCallPart`s             | itself + every tool message answering those calls                                |
| Tool message                                           | itself + its parent assistant message + all sibling tool messages of that parent |

The expansion walks the part shapes, matching `ToolCallPart.toolCallId` against `ToolResultPart.toolCallId`; one assistant message may fan out to several tool messages. It is implemented as a pure module over `SessionMessage[]` and unit-tested on the ModelMessage part shapes directly.

**`editMessage(id, partIndex, nextText)`** rewrites text in place, for both roles. User message text and assistant text parts are editable; saving persists the new content. There is no resend, no truncation of later messages, no re-run: the next run simply derives its input from the edited thread. Editing a user message rewrites what was "asked"; editing an assistant message rewrites what the model "said", which is also what it will see as history on the next run.

**Part-level targeting for assistant messages.** An assistant message body may contain multiple parts (text, tool-call, reasoning), so an edit targets exactly one text part, addressed by its index within the message's content array. The render layer surfaces this address as the block id `${msg.id}#text-${partIndex}`; user messages, and assistant messages whose content is a bare string, address the whole text instead (`partIndex` null). File parts and tool-call parts pass through untouched. The replacement itself is a pure function over the message body: it swaps the targeted text and leaves every other part identical.

**Persistence goes through the raw body, never the hydrated copy.** The in-memory thread carries hydrated attachments (data URLs, ADR-0044 §3) while the persisted body carries `attachment://` refs, so a naive full-body write from memory would inline base64 into the body and orphan the sidecar rows. The edit path therefore first loads the raw persisted body (`load_messages`), applies the same pure text-replacement to it (file parts are opaque to the transform), and writes the full replacement body via the `update_message` Rust command, which touches the body column only (id, `created_at`, and usage columns are preserved).

### 3. Durable-first ordering

In the append-only world, memory and DB could only grow together, so ordering never mattered. With mutations, ordering decides which copy is truth on divergence. The rule: **the DB write completes before the in-memory sync.**

1. Delete: the app layer calls the `delete_messages` Rust command with the explicit id list. Message rows and their sidecar `message_attachments` rows (FK `ON DELETE CASCADE`, ADR-0044) are removed in one transaction. Only on success does it call `Agent.removeMessages(ids)` to sync in-memory state.
2. Edit: the app layer performs the raw-body surgery of §2 and calls `update_message`. Only on success does it call `Agent.replaceMessage(id, next)` to sync the in-memory copy.

On persistence failure, memory is never mutated, for either command: the operation simply did not happen anywhere, and the error surfaces to the user. Memory can therefore never run ahead of the DB. The remaining crash window (DB committed, process died before the in-memory sync ran) converges on next load, which rebuilds memory from the DB.

### 4. Explicit ID list, never timestamps

`delete_messages` takes an explicit id list (`Vec<String>`), never a timestamp bound or an "everything after X" cut. With no position column and millisecond-level `created_at` collisions inside a turn, any timestamp comparison is ambiguous or lossy. The id list is always computed client-side from the in-memory thread order (index-based selection), the only place that order exists.

### 5. Library surface: two memory-only methods

The pure library's entire share of the feature is `Agent.removeMessages(ids: string[])`, an in-memory filter over `Agent.messages`, plus `Agent.replaceMessage(id, next)`, an in-memory single-message swap. The `SessionStore` interface is deliberately NOT extended: durability (the `delete_messages` and `update_message` calls, their ordering, the attachment cascade, the raw-body surgery) is orchestrated by the app-layer conversation-runtime store (the ADR-0024 layer), which already owns persistence orchestration outside the library boundary. No React, IPC, or logger import enters `src/lib/ai`; ADR-0019 is intact.

### 6. Re-derivation and compaction interplay

Invariant 2 is unbroken by construction: the next `Agent.run()` re-derives the Derived Model Input from the mutated thread. A delete is simply a shorter thread; an edit is a same-shape thread with different text. ADR-0031 compaction needs no changes and no dangling-stub handling: because delete is pair-aware, a deleted tool pair is wholly absent from the thread, so the compactor never sees it and its stub simply stops appearing; and because edits target text parts only, never tool parts, stub pairing is untouched by an edit.

### 7. In-flight guard

Mutations are rejected while a run is in flight. The conversation runtime guards on its existing `isRunning` / run handle: `deleteMessage` and `editMessage` calls during a run are logged and rejected, not queued. Queueing would race the run's own Run Delta appends against the mutation; rejection keeps the two writer classes (runs append, users mutate) strictly serial.

## Consequences

**Positive:**

- The mental model stays small: one sanctioned transform with a precise definition, everything else in ADR-0028 unchanged. Future readers find an explicit carve-out, not a vague exception.
- Corrupt-thread safety: pair-aware expansion guarantees the Persisted Thread never contains a dangling tool call or an orphaned tool result, so every Derived Model Input derived from it is provider-valid by construction.
- Editing stays content correction: an edit touches exactly the targeted text and nothing else. Later messages survive, the thread's shape is unchanged, and no resend pipeline exists to diverge from the normal send path.
- Editing a message that carries attachments preserves them: the raw-body path rewrites text only, so `attachment://` refs and their sidecar rows ride through the edit untouched.
- Durable-first ordering means a crash can never strand a mutated in-memory thread without its persisted counterpart; reload always converges to DB truth.
- No `SessionStore` surface growth. The pure library gains two trivial methods and stays portable (ADR-0019 intact); all orchestration stays in the app layer where it already lived.

**Negative:**

- The append-only audit trail is voidable by the user. Deleted messages are gone for good (no soft delete, no tombstone), and an edit overwrites the original text in place with no revision history: nothing records that the thread was ever different.
- Editing an assistant message rewrites model-visible history with no provenance of the edit. The next run sees the edited text as what the model "said", and the original output is unrecoverable; the user must trust their own edits.
- Delete is irreversible. The UI must confirm via AlertDialog before executing; there is no undo.
- The pair-expansion logic must understand ModelMessage tool-call/tool-result part shapes (assistant fan-out, sibling tool messages). It is extracted and tested as a pure module; the cost is owning that shape knowledge in one more place.
- Mutations during a run are rejected rather than queued, so the user retries after the run finishes. Minor friction, chosen over racing the run's appends.

## References

- [ADR-0019](./0019-ai-agent-library-purity-boundary.md): purity boundary; why `removeMessages` and `replaceMessage` are memory-only and durability stays app-side.
- [ADR-0020](./0020-session-layer.md): session layer; the `Agent`/`SessionStore` split whose interface this ADR deliberately does not extend.
- [ADR-0028](./0028-three-layer-message-model.md): three-layer message model; invariant 1 is relaxed here, invariants 2 through 5 stand unchanged.
- [ADR-0031](./0031-tool-call-stub-compaction.md): stub compaction interplay; stubs of deleted pairs simply stop appearing, and edits never touch tool parts.
- [ADR-0044](./0044-chat-file-attachments.md): attachment hydration; why the edit path persists through the raw body (`attachment://` refs) rather than the hydrated in-memory copy, and why deleting messages cascades sidecar attachment rows.
