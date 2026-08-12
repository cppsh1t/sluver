# ADR-0032: World Export/Import as `.sluver-world` Archive

**Status**: accepted.

## Context

Users want to move a World between machines (desktop to laptop, or hand-off to a collaborator) without depending on any cloud service. A World today is split across two physical locations, so "copy the database file" is not a complete answer. The registry row in `space.db` holds the World's display identity (`name`, `description`, cover `image`, timestamps), while the content lives in a separate file at `worlds/{worldId}.db` holding the full set of World-scoped content tables (seventeen at the time of this ADR: Characters, Locations, Items, Lore, Events, Novels, Chapters, Scenes, Conversations, Messages, `world_config`, `scene_images`, and the rest). Copying only the `.db` drops the registry metadata; copying only the registry row leaves the World empty. A portable World has to carry both.

Two scope boundaries discipline what the archive may contain. AgentConfig is Space-scoped by ADR-0012: provider credentials and model bindings belong to a Space, not to any one World, so they must not travel inside a World export. The only string that reaches from a World's content back across that boundary is `conversations.agent_config_name`, a soft `TEXT` reference (not a foreign key) naming which AgentConfig the conversation was authored against. It is resolved live at runtime per ADR-0023, so a dangling value degrades gracefully instead of breaking import.

The mechanical shape of the feature follows a precedent already in the app. `export_logs` (ADR-0015) and `export_novel` (ADR-0027) both have the frontend pick a path through the `save()` dialog from `tauri-plugin-dialog`, Rust write the file with `std::fs` inside the command handler, and return `Result<(), DbError>`. World export/import reuses that contract verbatim, including the `zip` crate already in `Cargo.toml` for those features. No new IPC mechanism, capability, or dependency is introduced.

## Decision

Export produces a single `.sluver-world` file, which is a standard zip archive with two entries:

- `manifest.json`: the metadata envelope carrying `formatVersion` (currently `1`), `appVersion`, `exportedAt`, and the World's registry fields (`id`, `name`, `description`, `createdAt`, `updatedAt`, and `image` as base64 or `null`).
- `world.db`: the SQLite content file, WAL-checkpointed before packaging so it is self-contained.

Before the file is read for packaging, the export command runs `PRAGMA wal_checkpoint(TRUNCATE)` against the World's connection. This folds every committed transaction into the main `.db` and resets the `-wal` sidecar to zero length, so the archive needs no `-wal`/`-shm` companions and the imported database is byte-complete the moment it is written.

Import is a one-way snapshot transfer, not bidirectional sync. Each import recreates the World exactly as it was at export time; later edits in the source Space have no path back to the imported copy. This matches the existing mental model (a World is a closed, isolated universe per ADR-0004) and avoids the entity-level versioning and merge semantics the schema does not currently carry.

Two collision policies govern how an import lands in a target Space. For World identity, if the imported World's `id` already exists in the destination registry, the command with `overwrite=false` returns a `WorldImportAlreadyExists` business error; the frontend shows a confirmation dialog naming the existing World, then retries with `overwrite=true`, which replaces the `.db` file and updates the registry row (name, description, image, and timestamps taken from the export). For World name uniqueness (the global name-uniqueness convention), an auto-rename suffix is applied: "My World" becomes "My World (2)", then "My World (3)", and so on. Auto-rename runs in both the new-import and the overwrite paths; in the overwrite path, the World being replaced is excluded from the collision check so its own name is not counted against itself.

Schema forward-compatibility is handled by the existing migration machinery. On import, `WORLD_MIGRATIONS.to_latest()` runs against the unpacked `.db`, so an archive produced by an older app version migrates forward cleanly into whatever schema the destination app runs. The `formatVersion` field in the manifest guards the other direction: a future, incompatible archive format bumps the version, and an importer that does not recognise it refuses with a clear error rather than guessing. SQLite's tolerance for unknown columns means a newer-than-expected archive imported into an older app degrades gracefully (extra columns are ignored), but `to_latest()` will not downgrade, which is exactly the case `formatVersion` exists to catch.

AgentConfig and provider credentials are explicitly excluded from the archive. An imported World runs against whatever AI configuration the destination Space provides; `conversations.agent_config_name` resolves at runtime per ADR-0023, and the default `explorer` and `writer` configs seeded into every Space on creation (CONTEXT.md) make the common case line up without intervention.

## Consequences

**Positive:**

- A World is fully portable as a single file, with no network or cloud dependency and no need to ship sidecar files. The format is open: standard zip, SQLite, and JSON, inspectable with ordinary tools.
- Schema migration on import handles version skew gracefully. An export from an older build opens in a newer build with no special-case path.
- The IPC contract is the one already proven by `export_logs` and `export_novel`. No new capability, dependency, or frontend file-write mechanism.

**Negative:**

- Each export is a full snapshot. There is no incremental or delta transport, so a large World produces a large file, and repeated exports re-ship the whole content every time.
- `conversations.agent_config_name` may dangle in the destination Space if the referenced config has been renamed or deleted there. Resolution degrades gracefully (the conversation still loads; the model binding falls back to the Space default), and the seeded `explorer`/`writer` configs make this rare in practice, but it is not impossible.
- Importing an archive from a newer app version into an older app is a known soft spot. SQLite ignores unknown columns, so the World opens, but `to_latest()` cannot downgrade and any content in newer tables is invisible to the older app. The `formatVersion` check is the mitigation: a genuinely incompatible future format is refused outright rather than imported lossily.
- Bidirectional sync is explicitly out of scope. If it is ever needed, this archive format can serve as the transport, but merge semantics would require per-entity versioning or timestamps that the current schema does not carry.

## References

- [ADR-0004: World isolation](./0004-world-isolation.md). The closed-universe rule that makes one-way snapshot transfer sufficient.
- [ADR-0007: Three-database design](./0007-three-database-design.md). Why a World spans a `space.db` registry row and a separate `worlds/{id}.db`.
- [ADR-0012: Space-scoped AI config](./0012-space-scoped-ai-config.md). Why AgentConfig and credentials do not travel with the World.
- [ADR-0015: Unified log file with export-time Space filtering](./0015-unified-log-file-with-export-filter.md). The `save()`-dialog plus `std::fs` IPC contract this feature reuses.
- [ADR-0022: Chat conversations World-scoped](./0022-chat-conversations-world-scoped.md). Why conversations live inside the exported `.db`.
- [ADR-0023: Conversation role-bound, model resolved live](./0023-conversation-role-bound-live-model.md). Why `agent_config_name` is a soft, runtime-resolved reference.
- [ADR-0027: Novel export as EPUB and TXT](./0027-novel-export-epub-and-txt.md). The closest analog; the `zip` crate and dialog contract are shared.
