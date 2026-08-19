# ADR-0044: Chat file attachments — sidecar blob table with hydration at the session-store boundary

**Status**: accepted. Records decisions D1–D10 of the implementation plan; implemented end to end (backend, runtime, UI).

## Context

Chat is currently string-only end to end: `Composer` → `useSend` → `store.send` → `agent.run(text)` → `toSessionMessage({role: "user", content: text})`. Users need to show the agent images (a mood reference, a map) and hand it text material (an outline markdown file, CSV notes) without pasting walls of text into the composer.

Constraints that shape the design:

- **Storage must be SQLite.** World export packages only the World's `.db` file (ADR-0032), so attachment bytes living outside `world.db` (e.g. a per-World attachment directory) would silently break export/import round-trips.
- **The runtime library stays pure** (ADR-0019): `src/lib/ai` has no React, no IPC, no logger. The lib must never learn the `attachment://` scheme; ref resolution is an app-layer concern.
- **The three-layer message model** (ADR-0028) already separates the Persisted Thread from the Derived Model Input and explicitly allows layers to reshape between them. Persisted bodies may therefore differ from what the model receives. That split is the load-bearing assumption for both the text sentinels (§4) and the vision downgrade (§7).
- **The SDK widening point is `UserContent`.** AI SDK v7 (`ai@7.0.34`, verified in `node_modules`) defines `UserContent = string | Array<TextPart | FilePart>`; `FilePart` replaces the deprecated `ImagePart` and covers images and files uniformly.
- **Tauri IPC JSON round-trips only bare-string `DataContent`.** `Uint8Array` and tagged `{type: 'url'}` data forms degrade after `JSON.parse`; only plain strings survive reliably in both directions.
- **Vision support is a per-model fact we can know.** The models.dev catalog already integrated by the app stores the raw JSON on disk; its `modalities.input` field was verified against the local cache (~400 models: 154 text-only, 243 image-capable). Vision check = `input.includes("image")`.

## Decision

### 1. Storage: `message_attachments` BLOB sidecar table (world migration 013)

Images and text files are stored as BLOB rows in a new `message_attachments` table in `world.db`, modeled on the `scene_images` precedent:

```sql
CREATE TABLE message_attachments (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('image','text')),
    mime        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    data_blob   BLOB NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_message_attachments_message ON message_attachments(message_id, position);
```

Cascade chain: conversation delete → messages (existing FK) → attachments. No standalone delete command, and no `UNIQUE(message_id, position)` (scene_images precedent; positions are fixed at send time anyway).

**Rejected:** inline bytes inside `messages.body` (body rows balloon to multi-MiB JSON; every blob ships on every conversation open) and per-World attachment directories (breaks ADR-0032).

### 2. Client-minted ids; attachments ride `append_messages` in one transaction

Attachment ids are client-minted UUIDs stored verbatim — the exact precedent of `messages.id` documented in WORLD_MIGRATION_004's comment. This is what makes single-transaction atomic dehydrate (§3) possible.

`MessageInput` gains an optional `attachments` array (`#[serde(default)]`, so old payloads are unaffected). `append_messages` inserts each message row, then its attachment rows, inside the same transaction: a rejected attachment rolls back the whole batch (no message row either), and a partial persist is impossible. Two read commands are added: `get_message_attachment` (raw binary via `tauri::ipc::Response`) and `list_message_attachments` (metadata-only). There is deliberately no `add_message_attachment` write command in v1.

**Rejected:** a separate `add_message_attachment` called before `append_messages` (FK violation or non-atomic two-phase write, plus N extra IPC round-trips per send); Rust-side rewriting of body JSON to swap in refs (fragile surgery; the TS layer already holds the parts).

### 3. Persisted vs runtime form: `attachment://{id}` refs, hydrated at the `TauriSessionStore` boundary

| Layer | Form of a user-message file part |
|---|---|
| Persisted body (DB) | `FilePart { mediaType, filename, data: "attachment://{id}" }` (bare string) |
| Runtime thread (`Agent.messages`, `view.messages`) | `FilePart { …, data: "data:{mime};base64,…" }` (provider-ready) |
| Derived Model Input (per run) | images unchanged; text converted (§4); non-vision models get markers (§7) |

`TauriSessionStore` is the single hydrate/dehydrate boundary, which keeps the lib pure (ADR-0019):

- **Dehydrate** (`appendMessages`): for each user FilePart holding a `data:` URL, mint an id (`crypto.randomUUID()`), decode the base64 into the inline `AttachmentInput` payload, and swap the body copy's `data` to `attachment://{id}`. One IPC call, one transaction.
- **Hydrate** (`loadMessages`): swap `attachment://` refs back to data URLs via `get_message_attachment`, fetched concurrently. Hydration never throws (the `loadMessages` contract); a missing row degrades to a `[Attachment unavailable: {filename}]` text part plus a warning log.

**Rejected:** persisting data URLs verbatim in the body (33% size inflation, multi-MiB JSON rows, double transport on every load); `Uint8Array` in `FilePart.data` (does not survive IPC JSON round-trips).

### 4. Text attachments share the uniform path; Derived Model Input writes sentinels

Text files are stored, referenced, and hydrated exactly like images (§3). The divergence happens at model-input build time: a pure pipeline transform (`inlineTextFileParts`, sitting at the same stage as `compactToolCalls`) converts text FileParts into sentinel-wrapped TextParts:

```
<attachment filename="notes.md" mime="text/markdown">
…file content verbatim…
</attachment>
```

A plain TextPart works on every model; provider support for text FileParts varies. The sentinel is write-only: the persisted truth remains the FilePart ref, so nothing ever parses it back (no round-trip fragility). This is precisely what ADR-0028's Persisted Thread / Derived Model Input split anticipates: layers may reshape. The transform is pure (no React/IPC/logger imports, ADR-0019) and message-count preserving.

**Rejected:** inlining file content into the persisted body at send time (pollutes the user bubble, forces the UI to re-parse sentinels, duplicates content, breaks the uniform dehydrate path).

### 5. Caps, allowlists, and stable error codes

- **Images**: ≤ 5 MiB, MIME ∈ {webp, jpeg, png}. A separate constant from the 1 MiB avatar limit, which is untouched.
- **Text**: ≤ 1 MiB, MIME ∈ {text/plain, text/markdown, text/csv}, valid UTF-8 **as persisted**. 1 MiB ≈ 300K+ tokens is already far beyond any sane single-file context injection; larger material belongs in Notes, where the agent has `grep_notes`.
- **Count**: ≤ 8 attachments per message, enforced frontend-side in v1 (context-bloat control; typical provider image limits are ~20).
- **No client-side re-encoding of images.** Image files pass through as picked; the avatar crop/resize flow stays where it is. Text files, however, go through a **deterministic pick-time decode-normalization cascade** (added post-review, closing a silent-turn-loss hole): strict UTF-8 (fast path, pass-through) → UTF-16 by byte-order mark (LE/BE — the BOM decides, no heuristics) → GB18030 (superset of GB2312/GBK, the realistic zh-CN legacy case), re-encoded to UTF-8 before staging. The size cap is re-validated **post-conversion** (UTF-8 CJK is ~1.5× GBK, so a raw-≤1 MiB legacy file can exceed the cap after conversion and would otherwise be rejected by Rust at persist time, rolling back the whole turn); `sizeBytes` reports the converted length. Converted files are disclosed via a toast (`convertedFrom` on the draft); UTF-8 BOMs are stripped by the same decode→re-encode pass. Heuristic encoding guessing (Big5/Shift-JIS/Latin-1 detection) is deliberately out — GB18030 accepts nearly any byte sequence, so anything beyond BOM-driven certainty would silently produce mojibake. Rust's authoritative validator is unchanged: it only ever sees UTF-8 bytes.

Validation failures are business errors with stable codes for i18n: `ATTACHMENT_TOO_LARGE` (args: kind, max), `ATTACHMENT_INVALID_MIME` (args: mime), `ATTACHMENT_INVALID_TEXT` (no args).

### 6. UI: drafts in the conversation runtime; render from `view.messages`

Draft attachments (picked but not sent) live in the conversation-runtime store (ADR-0024) as `draftAttachments`, surviving conversation switches like `draft` text. The optimistic echo widens from `pendingUserText: string | null` to `pendingTurn: {text, attachments} | null`; the existing count-based echo-clearing effect is content-agnostic and survives unchanged.

Rendering needs no second fetch layer: the runtime thread must hold data URLs anyway (model input is rebuilt from it every turn), so `view.messages` already carries renderable bytes. Image thumbs render `<img src={dataUrl}>` directly; text chips decode the data URL client-side for preview. A react-query per-attachment fetch would be a second representation of the same bytes with cache-invalidation complexity and zero memory savings; `get_message_attachment` stays for hydration, tests, and future out-of-band uses.

### 7. Catalog-driven vision downgrade: filename-bearing markers (no hard gating, no silent drop)

The models.dev catalog's `modalities.input` (verified against the local cache) resolves whether the bound model accepts image input. The existing disk cache already stores the raw JSON, so plumbing the field through is a re-parse, not a refetch or migration.

- **Capability resolution is app-side per run** (`store.send` already resolves the live model per ADR-0023) and passes an `imageInputSupported` flag into the agent. Lib purity holds (ADR-0019).
- **Vision models** receive image FileParts unchanged.
- **Catalog-confirmed non-vision models** receive a TextPart marker instead of each image: `[image attachment: "sunset.png" — image content NOT delivered: the bound model does not accept image input]`. The marker is model-facing English, never parsed, never rendered in UI. It carries the **filename, not the attachment id**: ids are minted at dehydrate time, and the runtime thread's FileParts hold data URLs with no spare field for an id (extending the SDK part type with custom fields risks provider-side zod validation). A future `look_at` tool resolves by filename within the conversation via `list_message_attachments`, disambiguated by position; it is explicitly out of scope for v1.
- **Unknown / custom model ids with no catalog entry** pass through unchanged: custom OpenAI-compatible endpoints are usually deliberate vision setups, and a provider error is more informative than silent degradation.
- The transform runs per-turn on the whole input, so switching models mid-conversation (ADR-0023 live resolution) just works: text-only models see markers for old images, vision models see the images.
- The UI badges image chips with a subtle "not delivered to model" hint when the currently-bound model lacks vision (computed live from capability × message-has-image, never persisted).

**Rejected:** hard block in the composer (capability unknown at draft time, brittle under live model switching); sentinel-only without catalog data (silent-drop servers would mislead the model into "seeing" nothing); a manual AgentConfig flag (models.dev already maintains the fact; manual flags go stale).

## Consequences

As built (world migration 013; `commands/attachment.rs`; `inlineTextFileParts` + `downgradeImageParts` pipeline transforms; hydrate/dehydrate in `TauriSessionStore`; `draftAttachments` in the conversation runtime; composer button/paste/drag-drop with chip strip; `attachment-strip` rendering with lightbox, text preview, and a live "not delivered" badge):

- Runtime memory holds data URLs for the attached history, bounded by the caps (≤ 8 per message, ≤ 5 MiB images, ≤ 1 MiB text); LRU eviction of cached conversation runtimes is future work.
- Opening a conversation adds one binary IPC call per attachment during hydration (batchable later). A missing row degrades to an `[Attachment unavailable: …]` text part plus a `attachment.hydrate.missing` warning log — hydration never throws.
- World export/import needs zero changes: blobs ride inside the `.db` (ADR-0032 intact).
- Auto-titling (`extractTitleTexts`) and compaction (ADR-0031) are unaffected; both are text-part-only readers.
- Sending a 5 MiB image means one ~6.7 MB JSON payload on the single per-turn write path (reads are binary); the existing 1 MiB avatar pipeline already proves the order of magnitude. A binary-body command is the noted escape hatch, not v1.
- Vision downgrade is per-turn and catalog-driven: `inputModalities` comes from the already-cached raw models.dev JSON (no refetch), resolved app-side and passed into the agent as `imageInputSupported`. Custom model ids without a catalog entry pass through unchanged; provider image-support variance for them surfaces as run errors (deliberate, §7).
- The future `look_at` tool has its full substrate: attachment bytes addressable per conversation via `list_message_attachments` + `get_message_attachment`, resolvable by filename from the markers non-vision models receive.
- Logs carry `attachment_id` / `message_id` / `kind` / `size_bytes` only; filenames and content are never logged (redaction policy).

## References

- ADR-0032 (world export = the `.db` file, which forces SQLite storage), ADR-0019 (runtime purity; the lib never knows `attachment://`), ADR-0028 (three-layer message model; the split that justifies sentinels and downgrade transforms), ADR-0022 (World-scoped conversations, where the table lives), ADR-0023 (live model resolution, why downgrade must be per-turn), ADR-0024 (conversation runtime cache, home of `draftAttachments`), ADR-0031 (compaction, unaffected), ADR-0040 (namer precedent for a future `look_at` secondary model)
