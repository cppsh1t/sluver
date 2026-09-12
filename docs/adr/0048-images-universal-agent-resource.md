# ADR-0048: Images as a universal agent resource — one compression bridge, full tool lifecycle

**Status**: accepted. Records decisions §1–§4; implemented end to end (Rust bridge, worldbook tool surface, `look_at` entity source, runtime lookup).

## Context

An audit of the agent's image capabilities found the surface fractured along every seam it crossed:

1. **The agent could see attachments and URLs, but not its own work product.** `look_at` (ADR-0045) resolves an in-conversation attachment by filename or a remote URL, but the portraits and covers the agent itself writes via `set_<entity>_image_from_url` were invisible to it: an entity's `image_blob` column had no read path into the vision one-shot. "Does this portrait actually match the character?" was unanswerable even though the agent picked the URL.
2. **The agent could store URL-sourced images but not attachment-sourced ones.** A user who attached commissioned cover art and asked "use this for the novel" got a refusal — no tool accepted a filename as the byte source, even though `attachmentLookup` (ADR-0045 §3) already resolves filenames to hydrated bytes with zero IPC.
3. **Images could be set but never cleared.** A wrong portrait was permanent as far as the agent was concerned; only the UI forms could remove an image.
4. **The scene gallery had zero tool coverage.** `scene_images` (the mood-board sidecar table) had no list, add, or delete tool — neither the examination path nor the write path existed for it.

Beneath the tooling gaps sat two fragmenting regimes:

- **Two size budgets.** Chat attachments are ingested up to 5 MiB (ADR-0044 §5, `MAX_ATTACHMENT_IMAGE_BYTES`); every entity `image_blob` column caps at 1 MiB (`MAX_IMAGE_BYTES`). An attachment-sourced tool cannot simply forward bytes across that gap.
- **Two fetch pipelines.** `fetch_and_prepare_image` (URL → center-crop → Lanczos3 → lossless WebP) existed only behind the from-URL tools; there was no transform path that started from thread-resident bytes.

The unifying decision: treat images as one resource with one canonical form, and compress at a single bridge rather than at each edge.

## Decision

### 1. `prepare_image`: one Rust compression bridge (dual source × dual mode)

A new command, `commands/image.rs::prepare_image`, is THE single funnel from any image source into the canonical entity form — lossless WebP, ≤ 1 MiB:

- **Dual source** (exactly one; violations are `INTERNAL_ERROR` arg errors): `dataBase64` (base64 payload, ≤ 5 MiB decoded — the ADR-0044 attachment cap, deliberately NOT the 1 MiB output ceiling; the command exists precisely to compress payloads that are legal on one side of the bridge and illegal on the other; an over-cap payload reuses `DbError::AttachmentTooLarge`, because the bytes source IS a hydrated chat attachment and gets ADR-0044's stable code + translation) or `url` (http(s) only, scheme-guarded).
- **Dual mode** (exactly one): CROP (`width` + `height`) runs center-crop-to-aspect + Lanczos3 `resize_exact` + lossless WebP — the exact pipeline of `fetch_and_prepare_image`, now shared via `pub(crate)` helpers (`parse_http_url`, `download_image_bytes`, `crop_resize_encode_webp`) so both commands ride one download + crop pipeline and cannot drift. FIT (`maxDimension`) scales proportionally (aspect preserved) so the longest side ≤ the ceiling, then progressively halves both dimensions + re-encodes until the output fits 1 MiB or the longest side drops below 512px (beyond which further shrinking destroys the image without meaningfully reducing bytes); failure surfaces as `INVALID_IMAGE`, the same code the direct upload path uses.

Output rides `tauri::ipc::Response` (the binary channel, same as `get_*_image` reads); the caller then performs the actual `update<Entity>Image` / `addSceneImage` write.

**This resolves the 5 MiB vs 1 MiB conflict by compressing AT THE BRIDGE:** attachments stay untouched passthrough at send time (ADR-0044 §5's "no client-side re-encoding" is unchanged), entity blobs stay the canonical ≤ 1 MiB WebP they always were, and the bridge is the only component that knows both regimes.

**Rejected:** transcoding attachments at dehydrate/send time (contradicts ADR-0044 §5 — the persisted attachment must be the bytes the user picked, and every conversation load would pay the re-encode again); lossy WebP for better compression (the `image` crate's built-in encoder is lossless-only; lossy needs the `webp` crate + libwebp-sys, a heavy native dep that dirties cross-platform builds — see the Cargo.toml image note); a client-side canvas pipeline (a third encoder, no Rust-side validation).

### 2. Attachment → entity storage: 8 `set_<entity>_image_from_attachment` tools

One tool per image-bearing entity (world, character, phase, location, item, lore, event, novel — the eight with `ENTITY_IMAGE_CROP_SPEC` entries), each built on shared infra (`tools/worldbook/image-from-attachment.ts`) mirroring the from-URL tools:

1. Resolve the filename via `ctx.attachmentLookup.findByFilename` — the existing zero-IPC reverse channel (ADR-0045 §3). **Attachment ids remain never model-facing** (ADR-0044 §7); the filename printed in the downgrade marker is the only address the model can quote.
2. Strip the data URL to its base64 payload and call `prepareImage({ dataBase64, width, height })` with the entity's `ENTITY_IMAGE_CROP_SPEC` entry — the same crop table the from-URL tools use (one table, both sources; user-uploaded and agent-stored images land in the same column at the same dimensions).
3. Hand the returned WebP bytes to a per-entity mutator closure that performs the `update<Entity>Image` IPC write.

A filename miss returns a structured `{error: "attachment_not_found", filename, message}` result, never a throw — the `look_at` convention: the model likely mis-copied the filename and should re-check the marker, not conclude its call shape was wrong. Consent `configurable`, matching `set_*_image_from_url` (a create-class overwrite).

The filename contract is closed on the OTHER side by the Derived Model Input pipeline. On the vision pass-through path (`imageInputSupported` `true`/unknown), the model received the pixels but NO filename anywhere: provider mappings drop `FilePart.filename` for image content (OpenAI `image_url`, Anthropic `source`), so the from-attachment tools were unaddressable even though their parameter was technically describable. The fix rides the existing `downgradeImageParts` transform (ADR-0044 D9): immediately after each filename-bearing image FilePart it injects a companion annotation — `[image attachment: "..." — image content delivered in this message]` — at the Derived Model Input layer only, never persisted (ADR-0028 keeps the Persisted Thread verbatim). Text next to the part is the only reliable filename channel, and the shared `[image attachment: "..."` prefix keeps tool teachings substring-compatible with the NOT-delivered downgrade marker, so one description serves both paths.

**Rejected:** widening `set_<entity>_image_from_url` to also accept `filename` (the name would lie about the source; the exactly-one-source schema discipline and the prescriptive per-parameter descriptions would blur into "sometimes a URL, sometimes a filename").

### 3. `look_at` entity source: `EntityImageLookup` on ToolContext

`look_at` gains a third input source: `entityKind` + `entityId` (schema-pair-enforced) alongside `filename` and `url`, still exactly-one-source overall. `entityKind` spans the 8 card entities plus `scene_image` (addressed by the gallery row's own id from `list_scene_images`, not the scene's id). One pair exception: `entityKind: "world"` carries NO id — no tool ever surfaces the world's UUID to the model (the other world tools deliberately omit it too), so execute substitutes the conversation's `worldId` and the no-cover remediation names the set-cover tools instead of the (nonexistent for world) `hasImage` surface. Resolution runs through a new REQUIRED `ToolContext.entityImageLookup.findByEntity(kind, id)`:

- **Async and IPC-backed**, unlike the sync zero-IPC `attachmentLookup` — entity columns are not mirrored into the thread, so each call is one `get<Entity>Image` / `getSceneImage` binary read. Unlike `planAccess` / `threadLookup` it needs no agentRef: it closes over the per-conversation `spaceId` / `worldId` only (World keyed by its own id, every other kind scoped to the conversation's world).
- Ids are branded at the boundary via zod `schema.parse` (the API layer's branded signatures stay satisfied without `as never` casts at the call sites); the media type is sniffed client-side from the bytes — O(1) defense-in-depth, since every write path emits WebP but nothing trusts stored metadata.
- An entity with no image set is a normal state, not an invocation error: `null` travels back as a structured `{error: "entity_image_not_found"}` result pointing the model at the `hasImage` flag.

The pure module (`lib/ai/look-at.ts`) gains an `"entity"` `ImageSource` variant and the `LookAtEntityKind` union it requires (ADR-0019 intact — the union lives in `lib/ai` because `lib/ai` must not import from the tools layer). The `<image_access>` prompt block teaches the entity route on the same registration-time gate as the tool itself (`visionConfig != null`), so the prompt never advertises a route that cannot run.

### 4. Clear + scene gallery tools; role gating via the `queryOnly` prefix filter

- **8 `clear_<entity>_image`** tools, consent `always` — matching the delete family: irreversible byte destruction goes through the blocking approval gate (ADR-0025) regardless of configuration.
- **Scene gallery**: `add_scene_image_from_url` / `add_scene_image_from_attachment` (consent `configurable`) run `prepare_image` in FIT mode with `SCENE_IMAGE_MAX_DIMENSION = 1600` — aspect preserved, NO cropping, because scene images are mood-board material and never had a crop spec (unlike the 8 card slots). `addSceneImage` returns the appended `SceneImageMeta` (backend-assigned id + tail position) verbatim, so the model can `look_at` or `delete_scene_image` it later. `delete_scene_image` (consent `always`; the backend renumbers remaining positions). `list_scene_images` (consent `auto`, metadata only — id and position per entry, no pixels) deliberately survives `queryOnly` on both roles: reading the gallery is reference work for either role.

Role gating stays declarative: `set_*` / `clear_*` / `add_*` / `delete_*` carry mutation prefixes, so they ride only their primary domain's role — Explorer (full worldbook) gains 15 tools (the world, character, phase, location, item, lore, and event set/clear pairs — 14 — plus `list_scene_images`; 83 total), Writer (full novel/chapter/scene) gains 8 (the world and novel pairs plus the four gallery tools; 63 total). New tools appear on the next conversation (re)creation per the ADR-0024 toolset-snapshot lifecycle — no eager invalidation.

## Consequences

As built (`commands/image.rs` with the `pub(crate)` helpers extracted out of `fetch_and_prepare_image`; 20 new tools across `worldbook/*.ts` on the shared `image-from-attachment.ts` infra; `EntityImageLookup` wired in `conversation-runtime/store.ts`; `look_at` widened; `prepareImage` in `api/image.ts`):

- **The IPC seam is a runtime-only failure mode.** The Rust command takes a single `input: PrepareImageInput` struct parameter, so the frontend must send `{ input }` — a flat spread fails arg deserialization at RUNTIME, invisible to `tsc` (the TS wrapper type-checks either way) and to unit tests (which mock `@/api/image`). That exact bug was caught in review; the wrapper now carries the convention comment. Any future single-struct IPC command inherits the same seam-testing blind spot.
- **The audit's four gaps close symmetrically.** See (entity source on `look_at`), store (attachment + URL sources), clear (8 tools), gallery (4 tools) — and every image the agent stores becomes examinable by the agent, closing the write/read loop.
- **Two size regimes remain, but only the bridge knows.** Attachments stay untouched passthrough (ADR-0044 §5 unchanged); entity blobs stay canonical. A 5 MiB attachment becomes a ≤ 1 MiB WebP only at the moment it crosses into an entity slot; the original stays in the thread for rendering and re-use.
- **FIT mode's floor is a 512px longest side.** A lossless encode that still exceeds 1 MiB below that floor is pathological noise, not a photo; it surfaces as `INVALID_IMAGE` instead of an infinitely shrinking loop.
- **`look_at` entity reads cost one IPC call each** (the only image source that does — attachments are thread-resident, URLs are provider-fetched); the bytes are not cached, so repeated interrogation of the same portrait re-reads it.
- **Redaction holds**: `prepare_image` logs `skip_all` with length-only fields (`source`, `input_bytes` / `url_length`, `output_bytes`); base64 payloads and URLs are user creative content and are never logged at any level.
- **World export/import needs zero changes**: every new byte lands in existing BLOB columns (`image_blob`, `scene_images`), which ride inside the `.db` (ADR-0032 intact).

## References

- ADR-0044 (attachments: the 5 MiB regime, passthrough at send, ids never model-facing, `AttachmentTooLarge` code), ADR-0045 (`look_at`: filename contract, structured-error convention, registration-time vision gating), ADR-0025 (consent levels — `auto`/`configurable`/`always` classifications adopted here), ADR-0019 (purity — `EntityImageLookup` interface pure, implementation app-side; `LookAtEntityKind` lives in `lib/ai`), ADR-0032 (blobs ride the `.db`; no export surface changes), ADR-0024 (conversation runtime cache — new tools appear on next conversation (re)creation)
