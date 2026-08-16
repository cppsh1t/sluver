use rusqlite_migration::{Migrations, M};

// ─── meta.db schema ─────────────────────────────────────────────────────────
// Tier 1 of the three-database design (ADR-0007). Always open. Holds the
// `spaces` registry (id, name, optional argon2id password_hash) + global
// app `settings` KV. Per ADR-0008 the password is an auth-gate, not
// encryption: NULL = unprotected, PHC string = protected.

const META_SQL: &str = r#"
    -- Space registry: each row is one Space. The Space owns a directory
    -- `spaces/{id}/` (path is computed, NOT stored) containing its
    -- `space.db` and its `worlds/{worldId}.db` content files.
    CREATE TABLE IF NOT EXISTS spaces (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        password_hash TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_name ON spaces(name);

    -- Application-level key-value settings (AppSetting).
    -- The table name stays "settings"; only the Rust struct renames.
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"#;

// ─── space.db schema ────────────────────────────────────────────────────────
// Tier 2 of the three-database design (ADR-0007). One file per Space at
// `spaces/{spaceId}/space.db`, opened once the Space is unlocked. Holds
// that Space's `worlds` registry + the reserved `space_config` KV. No
// `space_id` column — identity is implicit in which file is connected,
// exactly as ADR-0001 did for worlds.

const SPACE_SQL: &str = r#"
    -- World registry for THIS Space. The `worlds` row here is the World
    -- entity's source of truth (name, description). `db_path` is relative
    -- to `spaces/{spaceId}/`, e.g. "worlds/{id}.db". World name uniqueness
    -- is per-Space (ADR-0007) — enforced via the unique index below.
    CREATE TABLE IF NOT EXISTS worlds (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        db_path     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worlds_name ON worlds(name);

    -- Reserved per-Space key-value config module (CONTEXT.md).
    -- Intentionally empty for now; future Space-level settings land here.
    CREATE TABLE IF NOT EXISTS space_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"#;

/// Migration 2 for `space.db`: AI provider credentials + agent configs table
/// (ADR-0012: Space-scoped AI config). Added as a separate migration so
/// existing `space.db` files (created before this feature) get these tables
/// via `rusqlite_migration`'s incremental migration tracking — modifying the
/// original `SPACE_SQL` would NOT re-run for already-migrated databases.
const SPACE_MIGRATION_002: &str = r#"
    -- AI provider credentials (ADR-0012). One row per configured provider.
    -- `provider_id` aligns with models.dev's id. API keys are plaintext per
    -- ADR-0013 (threat model + upgrade path documented there).
    CREATE TABLE IF NOT EXISTS provider_credentials (
        id          TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL UNIQUE,
        api_key     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- AI agent configs (ADR-0012). Seeded with 'explorer' + 'writer' on Space
    -- creation. `model_id` is a composite '{provider_id}/{model_id}' or NULL.
    -- Deleting a provider credential cascades a NULL-out of dependent agent
    -- configs (app-layer cascade, see commands::ai::do_delete_provider_credential).
    CREATE TABLE IF NOT EXISTS agent_configs (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        model_id    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
"#;

/// Migration 3 for `space.db`: add `auto_execute_dangerous_tools` column to
/// `agent_configs`. Stored as INTEGER (0/1) per SQLite's boolean convention.
/// Existing rows pick up DEFAULT 0 (auto-execute off — safest default). Added
/// as a separate migration so existing `space.db` files get the new column via
/// `rusqlite_migration`'s incremental tracking — modifying `SPACE_SQL` or
/// `SPACE_MIGRATION_002` would NOT re-run for already-migrated databases.
const SPACE_MIGRATION_003: &str = r#"
    ALTER TABLE agent_configs ADD COLUMN auto_execute_dangerous_tools INTEGER NOT NULL DEFAULT 0;
"#;

/// Migration 4 for `space.db`: per-World cover image columns on the `worlds`
/// registry table. Both columns are nullable (NULL = no image set), and the
/// image flows exclusively through the dedicated `update_world_image` /
/// `clear_world_image` / `get_world_image` commands — the regular World
/// struct + `list_worlds` / `get_world` queries do NOT touch these columns
/// (avoids a serde Vec<u8> → JSON-number-array encoding trap and keeps the
/// world-list query light). `image_blob` holds the raw bytes (webp/jpeg/png
/// only, ≤ 1 MiB); `image_mime` is the matching MIME type. Added as a
/// separate migration so existing `space.db` files get the columns via
/// `rusqlite_migration`'s incremental tracking — modifying the original
/// `SPACE_SQL` would NOT re-run for already-migrated databases.
const SPACE_MIGRATION_004: &str = r#"
    ALTER TABLE worlds ADD COLUMN image_blob BLOB;
    ALTER TABLE worlds ADD COLUMN image_mime TEXT;
"#;

/// Migration 5 for `space.db`: per-role context-compaction columns on
/// `agent_configs` (ADR-0031 Phase 1 §1). Two scalar columns back the new
/// `ContextCompaction { enabled, turn_age }` field on `AgentConfig`:
/// `context_compaction_enabled` is a boolean (INTEGER 0/1, defaults to 0 =
/// off — compaction is opt-in per ADR-0031 §1), `context_compaction_turn_age`
/// is the user-turn age threshold (INTEGER, defaults to 3 per ADR-0031 §2).
/// Existing rows pick up both DEFAULTs. Added as a separate migration so
/// existing `space.db` files get the columns via `rusqlite_migration`'s
/// incremental tracking — modifying `SPACE_SQL`, `SPACE_MIGRATION_002`, or
/// `SPACE_MIGRATION_003` would NOT re-run for already-migrated databases.
const SPACE_MIGRATION_005: &str = r#"
    ALTER TABLE agent_configs ADD COLUMN context_compaction_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_configs ADD COLUMN context_compaction_turn_age INTEGER NOT NULL DEFAULT 3;
"#;

/// Migration 6 for `space.db`: per-role system prompt override on
/// `agent_configs`. Empty string (the DEFAULT) means "use the code-defined
/// default prompt" (see `src/lib/ai-roles/index.ts`); a non-empty value
/// overrides it. Existing rows pick up DEFAULT ''. Added as a separate
/// migration so existing `space.db` files get the new column via
/// `rusqlite_migration`'s incremental tracking.
const SPACE_MIGRATION_006: &str = r#"
    ALTER TABLE agent_configs ADD COLUMN system_prompt TEXT NOT NULL DEFAULT '';
"#;

// ─── world DB schema ────────────────────────────────────────────────────────
// Tier 3 of the three-database design (ADR-0007). One file per World at
// `spaces/{spaceId}/worlds/{worldId}.db`. Schema is byte-for-byte identical
// to the former two-tier WORLD_SQL — only the file location changed.

const WORLD_SQL: &str = r#"
    -- Characters (no world_id column — implicit to this DB file)
    CREATE TABLE IF NOT EXISTS characters (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        aliases     TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Locations
    CREATE TABLE IF NOT EXISTS locations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Items
    CREATE TABLE IF NOT EXISTS items (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Lore
    CREATE TABLE IF NOT EXISTS lores (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Events (before character_phases — phases FK to events)
    CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        start_at    TEXT,
        end_at      TEXT,
        location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Character phases (1:N to character, position column for ordering)
    CREATE TABLE IF NOT EXISTS character_phases (
        id               TEXT PRIMARY KEY,
        character_id     TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        appearance       TEXT NOT NULL DEFAULT '',
        changes          TEXT NOT NULL DEFAULT '',
        trigger_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        position         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phases_character ON character_phases(character_id);

    -- Event ↔ Character refs (junction, composite PK = set semantics)
    CREATE TABLE IF NOT EXISTS event_character_refs (
        event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        phase_id     TEXT NOT NULL REFERENCES character_phases(id) ON DELETE CASCADE,
        PRIMARY KEY (event_id, character_id, phase_id)
    );

    -- Novels
    CREATE TABLE IF NOT EXISTS novels (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- Chapters (position column maintains reading order within novel)
    CREATE TABLE IF NOT EXISTS chapters (
        id         TEXT PRIMARY KEY,
        novel_id   TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        summary    TEXT NOT NULL DEFAULT '',
        position   INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id);

    -- Scenes (position column maintains narrative order within chapter)
    CREATE TABLE IF NOT EXISTS scenes (
        id          TEXT PRIMARY KEY,
        chapter_id  TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        content     TEXT NOT NULL DEFAULT '',
        start_at    TEXT,
        end_at      TEXT,
        location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
        position    INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scenes_chapter ON scenes(chapter_id);

    -- Scene ↔ Character refs (junction, composite PK = set semantics)
    CREATE TABLE IF NOT EXISTS scene_character_refs (
        scene_id     TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        phase_id     TEXT NOT NULL REFERENCES character_phases(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, character_id, phase_id)
    );

    -- Scene ↔ Item refs (junction)
    CREATE TABLE IF NOT EXISTS scene_item_refs (
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, item_id)
    );

    -- Scene ↔ Event refs (junction)
    CREATE TABLE IF NOT EXISTS scene_event_refs (
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, event_id)
    );
"#;

/// Migrations for `meta.db` (spaces registry + app settings).
/// The old `META_MIGRATION_002` (`idx_worlds_name` on meta's `worlds`
/// table) is gone — that table moved out of meta in ADR-0007, and the
/// new `idx_spaces_name` is built inline in `META_SQL`.
const META_SLICE: &[M] = &[M::up(META_SQL)];
pub const META_MIGRATIONS: Migrations = Migrations::from_slice(META_SLICE);

/// Migrations for each `space.db` (that Space's world registry + config).
const SPACE_SLICE: &[M] = &[
    M::up(SPACE_SQL),
    M::up(SPACE_MIGRATION_002),
    M::up(SPACE_MIGRATION_003),
    M::up(SPACE_MIGRATION_004),
    M::up(SPACE_MIGRATION_005),
    M::up(SPACE_MIGRATION_006),
];
pub const SPACE_MIGRATIONS: Migrations = Migrations::from_slice(SPACE_SLICE);

/// Migrations for each world DB file (all world-scoped tables).
const WORLD_MIGRATION_002: &str = r#"
    -- Name/title uniqueness
    CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_name ON locations(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_name ON items(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lores_name ON lores(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_name ON events(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novels_title ON novels(title);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_novel_title ON chapters(novel_id, title);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_chapter_title ON scenes(chapter_id, title);

    -- Position uniqueness per parent scope
    CREATE UNIQUE INDEX IF NOT EXISTS idx_character_phases_char_pos ON character_phases(character_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_novel_pos ON chapters(novel_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_chapter_pos ON scenes(chapter_id, position);

    -- Novel description column
    ALTER TABLE novels ADD COLUMN description TEXT NOT NULL DEFAULT '';
"#;

const WORLD_MIGRATION_003: &str = r#"
    -- Character phase name column.
    -- Uniqueness within a character is a domain rule (CONTEXT.md) enforced at the
    -- application layer, not via a DB index — a unique index here would fail on
    -- existing multi-phase characters whose rows all default to name = ''.
    ALTER TABLE character_phases ADD COLUMN name TEXT NOT NULL DEFAULT '';
"#;

const WORLD_MIGRATION_004: &str = r#"
    -- AI conversations + messages (ADR-0022: World-scoped chat history).
    -- Mirrors the pure library's SessionStore interface (ADR-0020):
    --   conversations  -> SessionRecord  (create/list/delete)
    --   messages       -> SessionMessage  (load/append)
    --
    -- id strategy split is DELIBERATE (documented in the plan):
    --   conversations.id = UUID v7 (Rust new_id()); time-sortable for listSessions.
    --   messages.id = UUID v4 (crypto.randomUUID() from the pure lib's toSessionMessage);
    --     stored verbatim — messages sort by created_at, never by id, and forcing
    --     v7 would require changing SessionStore.appendMessages' signature.
    CREATE TABLE IF NOT EXISTS conversations (
        id                 TEXT PRIMARY KEY,
        agent_config_name  TEXT NOT NULL,
        title              TEXT,
        meta               TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL
                         REFERENCES conversations(id) ON DELETE CASCADE,
        body             TEXT NOT NULL,
        created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
"#;

/// Migration 5 for each world DB: per-World key-value config table
/// (ADR-0026: TimeMapper). Mirrors `space_config` in `space.db` — identity
/// is implicit in which DB file is connected, so there is NO `world_id`
/// column (per ADR-0007). Currently holds only the TimeMapper config under
/// key `"time_mapper"` (`{ "code": string }` — the user-authored JS). Added
/// as a separate migration so existing world DB files get the table via
/// `rusqlite_migration`'s incremental tracking.
const WORLD_MIGRATION_005: &str = r#"
    -- Per-World key-value config (mirrors space_config in space.db).
    -- Currently holds only the TimeMapper (key = "time_mapper").
    CREATE TABLE IF NOT EXISTS world_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"#;

/// Migration 6 for each world DB: per-entity image columns on the 7
/// "imageable" world-scoped tables. Both columns are nullable (NULL = no
/// image set), and images flow exclusively through the dedicated
/// `update_*_image` / `clear_*_image` / `get_*_image` commands — the
/// regular entity structs + `list_*` / `get_*` queries do NOT touch these
/// columns (avoids a serde Vec<u8> → JSON-number-array encoding trap and
/// keeps list queries light). `image_blob` holds the raw bytes (webp/jpeg/
/// png only, ≤ 1 MiB); `image_mime` is the matching MIME type.
///
/// Note that chapters and scenes are intentionally NOT in this list: only
/// entities that surface as "cards" with a cover image get the columns
/// (World registry + the 7 world-scoped entities listed below). Added as a
/// separate migration so existing world DB files get the columns via
/// `rusqlite_migration`'s incremental tracking — modifying the original
/// `WORLD_SQL` would NOT re-run for already-migrated databases.
const WORLD_MIGRATION_006: &str = r#"
    ALTER TABLE characters      ADD COLUMN image_blob BLOB;
    ALTER TABLE characters      ADD COLUMN image_mime TEXT;
    ALTER TABLE character_phases ADD COLUMN image_blob BLOB;
    ALTER TABLE character_phases ADD COLUMN image_mime TEXT;
    ALTER TABLE locations       ADD COLUMN image_blob BLOB;
    ALTER TABLE locations       ADD COLUMN image_mime TEXT;
    ALTER TABLE items           ADD COLUMN image_blob BLOB;
    ALTER TABLE items           ADD COLUMN image_mime TEXT;
    ALTER TABLE lores           ADD COLUMN image_blob BLOB;
    ALTER TABLE lores           ADD COLUMN image_mime TEXT;
    ALTER TABLE events          ADD COLUMN image_blob BLOB;
    ALTER TABLE events          ADD COLUMN image_mime TEXT;
    ALTER TABLE novels          ADD COLUMN image_blob BLOB;
    ALTER TABLE novels          ADD COLUMN image_mime TEXT;
"#;

/// Migration 7 for each world DB: rename `character_phases.changes` →
/// `description` and add `conversation_style`. The `changes` column is
/// renamed in place (SQLite ≥ 3.25 `RENAME COLUMN`); `conversation_style`
/// is a new free-form text column. Added as a separate migration so existing
/// world DB files get the change via `rusqlite_migration`'s incremental
/// tracking — modifying the original `WORLD_SQL` would NOT re-run for
/// already-migrated databases.
const WORLD_MIGRATION_007: &str = r#"
    ALTER TABLE character_phases RENAME COLUMN changes TO description;
    ALTER TABLE character_phases ADD COLUMN conversation_style TEXT NOT NULL DEFAULT '';
"#;

/// Migration 8 for each world DB: per-Scene gallery image sidecar table
/// (`scene_images`, 1:N). This is the N-image analog of the single-image
/// `image_blob` / `image_mime` columns added by `WORLD_MIGRATION_006`: a
/// scene can now hold an ordered gallery of images instead of just one.
/// Image bytes flow ONLY through the dedicated `add_scene_image` /
/// `get_scene_image` commands — the `Scene` struct and `load_scene` /
/// `list_scenes` queries never touch this table (avoids a serde Vec<u8> →
/// JSON-number-array encoding trap and keeps scene payloads light). Each
/// row holds one image's raw bytes (`image_blob`, webp/jpeg/png only,
/// ≤ 1 MiB) plus its MIME type and a `position` for ordering within the
/// scene. There is intentionally NO `UNIQUE(scene_id, position)` constraint
/// — it would complicate reordering (the per-row update path would need the
/// temporary-shift dance `reorder_scenes` uses), and a plain index is
/// sufficient for the gallery's ordered-list semantics. The
/// `ON DELETE CASCADE` on `scene_id` means deleting a scene automatically
/// removes its gallery. Added as a separate migration so existing world DB
/// files get the table via `rusqlite_migration`'s incremental tracking —
/// modifying the original `WORLD_SQL` would NOT re-run for already-migrated
/// databases.
const WORLD_MIGRATION_008: &str = r#"
    CREATE TABLE IF NOT EXISTS scene_images (
        id          TEXT PRIMARY KEY,
        scene_id    TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        image_blob  BLOB NOT NULL,
        image_mime  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scene_images_scene ON scene_images(scene_id, position);
"#;

/// Migration 9 for each world DB: permanent `author` column on `novels`.
/// Mirrors the `description` column precedent (WORLD_MIGRATION_002): a non-null
/// text field on an existing table, backfilled to `''` for pre-existing rows
/// via `NOT NULL DEFAULT ''`. This is the project's established convention for
/// non-null text fields added to existing tables. Added as a separate
/// migration so existing world DB files get the column via
/// `rusqlite_migration`'s incremental tracking — modifying the original
/// `WORLD_SQL` would NOT re-run for already-migrated databases.
const WORLD_MIGRATION_009: &str = r#"
    ALTER TABLE novels ADD COLUMN author TEXT NOT NULL DEFAULT '';
"#;

/// Migration 10 for each world DB: per-turn token-usage columns on the
/// `messages` table (ADR-0030). Two nullable `INTEGER` columns hold the
/// turn's `inputTokens` / `outputTokens` (cross-step summed by `AgentLoop`'s
/// `totalUsage`); both default to NULL — pre-migration rows and any turn
/// where the provider did not report a value stay NULL, preserving the
/// "unknown" vs "real zero" distinction end to end (ADR-0030 §4). Usage
/// attaches to the turn's LAST `role = "assistant"` message row only
/// (ADR-0030 §2); user / tool messages never carry it. Only `inputTokens` +
/// `outputTokens` are persisted — `totalTokens` is redundant and cache/
/// reasoning breakdowns are real-time signals not worth a column
/// (ADR-0030 §5). Added as a separate migration so existing world DB files
/// get the columns via `rusqlite_migration`'s incremental tracking —
/// modifying the original `WORLD_SQL` would NOT re-run for already-migrated
/// databases.
const WORLD_MIGRATION_010: &str = r#"
    ALTER TABLE messages ADD COLUMN usage_input_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN usage_output_tokens INTEGER;
"#;

/// Migration 11 for each world DB: the `notes` tree table (ADR-0038).
///
/// One table holds both structural folders and content notes behind a
/// `kind` discriminator — sibling title uniqueness must span folders and
/// notes alike (a folder "大纲" and a note "大纲" under the same parent
/// must collide), which SQLite cannot enforce across two tables. The
/// unique index is NULL-safe via `IFNULL(parent_id,'')` so the ROOT scope
/// is covered too (`UNIQUE(parent_id, title)` would not dedupe root-level
/// siblings — NULL ≠ NULL).
///
/// There is intentionally NO `UNIQUE(parent_id, position)` — the
/// `scene_images` precedent (WORLD_MIGRATION_008): the note tree drags on
/// two axes (same-parent reorder + cross-parent reparent), and under a
/// UNIQUE constraint each axis becomes a sequenced temporary-shift dance;
/// position truth is maintained at the application layer (the
/// `reorder_notes` full-list contract, ADR-0038 §3). Cycle prevention is
/// likewise application-layer (an ancestor walk inside `move_note`'s
/// transaction — SQLite cannot express it; ADR-0038 §4). Added as a
/// separate migration so existing world DB files get the table via
/// `rusqlite_migration`'s incremental migration tracking — modifying the
/// original `WORLD_SQL` would NOT re-run for already-migrated databases.
const WORLD_MIGRATION_011: &str = r#"
    CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        parent_id  TEXT REFERENCES notes(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('folder','note')),
        title      TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        position   INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_sibling_title ON notes(IFNULL(parent_id,''), title);
    CREATE INDEX IF NOT EXISTS idx_notes_parent_pos ON notes(parent_id, position);
"#;

const WORLD_SLICE: &[M] = &[
    M::up(WORLD_SQL),
    M::up(WORLD_MIGRATION_002),
    M::up(WORLD_MIGRATION_003),
    M::up(WORLD_MIGRATION_004),
    M::up(WORLD_MIGRATION_005),
    M::up(WORLD_MIGRATION_006),
    M::up(WORLD_MIGRATION_007),
    M::up(WORLD_MIGRATION_008),
    M::up(WORLD_MIGRATION_009),
    M::up(WORLD_MIGRATION_010),
    M::up(WORLD_MIGRATION_011),
];
pub const WORLD_MIGRATIONS: Migrations = Migrations::from_slice(WORLD_SLICE);
