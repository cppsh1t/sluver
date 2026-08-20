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

/// Migration 7 for `space.db`: seed the `namer` agent config (the
/// conversation auto-naming role). Spaces created before this role existed
/// already carry `explorer` + `writer` — this INSERT OR IGNORE adds `namer`
/// with the exact seed defaults `do_create_space` uses (model_id NULL,
/// auto-execute off, compaction disabled with turn_age 3, empty system
/// prompt). OR IGNORE is required because `name` is UNIQUE: brand-new Spaces
/// get the row from SPACE_MIGRATION_007 itself (migrations run at connection
/// open, BEFORE `do_create_space`'s seed loop — see commands/space.rs step 4),
/// and any Space where the row already exists must not fail. Fixed literal
/// id/timestamps keep the migration deterministic across every Space's
/// `space.db`; the id is a valid UUID v7 literal (time-sortable, matching
/// `new_id()`'s format) and the timestamps match `now_iso()`'s ISO 8601 ms
/// format. `created_at` is a deliberate FAR-FUTURE literal: `do_list_agent_configs`
/// sorts `ORDER BY created_at`, and the seed loop stamps explorer/writer with
/// the Space's real creation time — a realistic past literal would float `namer`
/// ABOVE the two primary roles for every Space created after this migration
/// ships. 9999 keeps the auxiliary role last regardless of when the Space is
/// created. Added as a separate migration so existing `space.db` files get
/// the row via `rusqlite_migration`'s incremental migration tracking —
/// modifying `SPACE_MIGRATION_002` would NOT re-run for already-migrated
/// databases.
const SPACE_MIGRATION_007: &str = r#"
    INSERT OR IGNORE INTO agent_configs
        (id, name, model_id, auto_execute_dangerous_tools,
         context_compaction_enabled, context_compaction_turn_age,
         system_prompt, created_at, updated_at)
    VALUES
        ('01a00a6e-36b8-7302-8810-856d81dacb0c', 'namer', NULL, 0, 0, 3, '',
         '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z');
"#;

/// Migration 8 for `space.db`: add `shell_tool_enabled` column to
/// `agent_configs` (ADR-0042: config-gated shell tool, ADR-0041 tool).
/// Stored as INTEGER (0/1) per SQLite's boolean convention. Existing rows
/// pick up DEFAULT 0 (shell tool off — safest default; when off the tool
/// is not registered at all). Added as a separate migration so existing
/// `space.db` files get the new column via `rusqlite_migration`'s
/// incremental tracking — modifying `SPACE_SQL` or `SPACE_MIGRATION_002`
/// would NOT re-run for already-migrated databases.
const SPACE_MIGRATION_008: &str = r#"
    ALTER TABLE agent_configs ADD COLUMN shell_tool_enabled INTEGER NOT NULL DEFAULT 0;
"#;

/// Migration 9 for `space.db`: Agent Skills tables (ADR-0043: storage-center
/// install model). `skills` holds the uploaded zip blobs (the immutable
/// original artifacts) with `name`/`description` parsed from SKILL.md
/// frontmatter at upload; `agent_config_skills` is the per-AgentConfig
/// enablement junction — a row EXISTS = enabled (no `enabled` column).
/// Disk materialization lives at `spaces/{id}/skills/{name}/` and is driven
/// entirely by the enable/disable commands (the DB is a storage source, not
/// a sync service). Added as a separate migration so existing `space.db`
/// files get the tables via `rusqlite_migration`'s incremental tracking —
/// modifying the original `SPACE_SQL` would NOT re-run for already-migrated
/// databases.
const SPACE_MIGRATION_009: &str = r#"
    -- Skill packages (ADR-0043). `name` is UNIQUE per Space (collisions
    -- rejected at upload). `package` is the raw zip blob; it is never
    -- selected through list/get commands (SkillSummary excludes it — a
    -- serde Vec<u8> → JSON-number-array encoding trap, same reasoning as
    -- the per-entity image columns).
    CREATE TABLE IF NOT EXISTS skills (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        package     BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- AgentConfig ↔ Skill enablement junction (composite PK = set
    -- semantics; row EXISTS = enabled). Both FKs cascade so deleting an
    -- agent config or a skill automatically drops its junction rows.
    CREATE TABLE IF NOT EXISTS agent_config_skills (
        agent_config_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (agent_config_id, skill_id)
    );
"#;

/// Migration 10 for `space.db`: seed the `vision` agent config (the
/// non-conversational role backing the `look_at` tool — a one-shot image
/// description for chat agents whose bound model lacks a vision modality;
/// configured = enabled, unconfigured = the tool is not registered at all).
/// Spaces created before this role existed already carry `explorer` +
/// `writer` + `namer` — this INSERT OR IGNORE adds `vision` with the exact
/// seed defaults `do_create_space` uses (model_id NULL, auto-execute off,
/// compaction disabled with turn_age 3, empty system prompt). OR IGNORE is
/// required because `name` is UNIQUE: brand-new Spaces get the row from
/// SPACE_MIGRATION_010 itself (migrations run at connection open, BEFORE
/// `do_create_space`'s seed loop — see commands/space.rs step 4), and any
/// Space where the row already exists must not fail. Fixed literal
/// id/timestamps keep the migration deterministic across every Space's
/// `space.db`; the id is a valid UUID v7 literal (time-sortable, matching
/// `new_id()`'s format, stamped just after `namer`'s) and the timestamps
/// match `now_iso()`'s ISO 8601 ms format. `created_at` is a deliberate
/// FAR-FUTURE literal: `do_list_agent_configs` sorts `ORDER BY created_at`,
/// and the seed loop stamps explorer/writer with the Space's real creation
/// time — a realistic past literal would float `vision` ABOVE the two
/// primary roles for every Space created after this migration ships. 9999
/// keeps the auxiliary role last regardless of when the Space is created.
/// Added as a separate migration so existing `space.db` files get the row
/// via `rusqlite_migration`'s incremental migration tracking — modifying
/// `SPACE_MIGRATION_002` would NOT re-run for already-migrated databases.
const SPACE_MIGRATION_010: &str = r#"
    INSERT OR IGNORE INTO agent_configs
        (id, name, model_id, auto_execute_dangerous_tools,
         context_compaction_enabled, context_compaction_turn_age,
         system_prompt, created_at, updated_at)
    VALUES
        ('01a00a6e-36c0-7521-9a3f-3e7c2d9b4f60', 'vision', NULL, 0, 0, 3, '',
         '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z');
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
    M::up(SPACE_MIGRATION_007),
    M::up(SPACE_MIGRATION_008),
    M::up(SPACE_MIGRATION_009),
    M::up(SPACE_MIGRATION_010),
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

/// Migration 12 for each world DB: the `scene_lore_refs` junction table —
/// Scene ↔ Lore refs, mirroring `scene_item_refs` / `scene_event_refs`
/// (composite PK = set semantics). The `ON DELETE CASCADE` on both FKs
/// means deleting a scene or a lore automatically removes the junction rows
/// (`delete_lore` stays a plain DELETE — the cascade is FK-driven). Added
/// as a separate migration so existing world DB files get the table via
/// `rusqlite_migration`'s incremental migration tracking — modifying the
/// original `WORLD_SQL` would NOT re-run for already-migrated databases.
const WORLD_MIGRATION_012: &str = r#"
    -- Scene ↔ Lore refs (junction)
    CREATE TABLE IF NOT EXISTS scene_lore_refs (
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        lore_id  TEXT NOT NULL REFERENCES lores(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, lore_id)
    );
"#;

/// Migration 13 for each world DB: the `message_attachments` sidecar
/// table (ADR-0044 / plan D1) — chat file attachments (images ≤ 5 MiB,
/// text ≤ 1 MiB) stored as BLOB rows, modeled on `scene_images`
/// (WORLD_MIGRATION_008).
///
/// The `ON DELETE CASCADE` on `message_id` chains with the existing
/// `messages.conversation_id` cascade: deleting a conversation removes
/// its messages, which removes their attachments — no standalone delete
/// command exists. There is intentionally NO `UNIQUE(message_id,
/// position)` — the `scene_images` precedent: positions are fixed at
/// send time (append-only), so a plain index is sufficient. Attachment
/// bytes flow ONLY through `append_messages` (inline `AttachmentInput`
/// rows) and the dedicated read commands — `Message` payloads never
/// touch this table (keeps `load_messages` light and avoids the serde
/// Vec<u8> → JSON-number-array trap). Added as a separate migration so
/// existing world DB files get the table via `rusqlite_migration`'s
/// incremental migration tracking — modifying the original `WORLD_SQL`
/// would NOT re-run for already-migrated databases.
const WORLD_MIGRATION_013: &str = r#"
    CREATE TABLE IF NOT EXISTS message_attachments (
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
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id, position);
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
    M::up(WORLD_MIGRATION_012),
    M::up(WORLD_MIGRATION_013),
];
pub const WORLD_MIGRATIONS: Migrations = Migrations::from_slice(WORLD_SLICE);

#[cfg(test)]
mod schema_tests {
    use super::*;
    use rusqlite::Connection;

    // ── helpers ────────────────────────────────────────────────────────────

    /// All user tables of `c`, sorted by name (SQLite-internal `sqlite_%`
    /// tables excluded).
    fn table_names(c: &Connection) -> Vec<String> {
        let mut stmt = c
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .expect("prepare table_names query");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query table_names");
        rows.collect::<Result<Vec<_>, _>>().expect("read table_names rows")
    }

    /// Only the explicitly named indexes (those with CREATE INDEX SQL).
    /// SQLite's implicit UNIQUE / composite-PK autoindexes live in
    /// sqlite_master with a NULL `sql` column and are deliberately excluded.
    fn named_indexes(c: &Connection) -> Vec<String> {
        let mut stmt = c
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'index' AND sql IS NOT NULL
                 ORDER BY name",
            )
            .expect("prepare named_indexes query");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query named_indexes");
        rows.collect::<Result<Vec<_>, _>>().expect("read named_indexes rows")
    }

    /// `PRAGMA user_version` — the bookkeeping field rusqlite_migration
    /// maintains (one unit per applied migration).
    fn user_version(c: &Connection) -> i64 {
        c.query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user_version")
    }

    /// Does `table` have a column named `col`? (via `PRAGMA table_info`)
    fn has_column(c: &Connection, table: &str, col: &str) -> bool {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = c
            .prepare(&sql)
            .unwrap_or_else(|e| panic!("prepare {sql}: {e}"));
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info columns");
        let columns = rows
            .collect::<Result<Vec<_>, _>>()
            .expect("read table_info rows");
        columns.contains(&col.to_string())
    }

    // ── family (a): fresh install ──────────────────────────────────────────

    /// meta.db fresh install: one migration → user_version 1, exactly the
    /// {spaces, settings} table set, and a single named index idx_spaces_name.
    #[test]
    fn meta_fresh_install_schema() {
        let mut conn = Connection::open_in_memory().expect("open in-memory meta db");
        META_MIGRATIONS.to_latest(&mut conn).expect("meta to_latest");

        assert_eq!(user_version(&conn), 1, "meta user_version after to_latest");
        assert_eq!(
            table_names(&conn),
            ["settings", "spaces"],
            "meta table set at v1"
        );
        assert_eq!(
            named_indexes(&conn),
            ["idx_spaces_name"],
            "meta named index set at v1"
        );
    }

    /// space.db fresh install: ten migrations → user_version 10, exactly the
    /// {worlds, space_config, provider_credentials, agent_configs, skills,
    /// agent_config_skills} table set, and a single named index idx_worlds_name
    /// (the UNIQUE constraints on agent_configs.name / provider_credentials.
    /// provider_id / skills.name and the agent_config_skills composite PK are
    /// column/table-level and produce only NULL-sql autoindexes).
    #[test]
    fn space_fresh_install_schema() {
        let mut conn = Connection::open_in_memory().expect("open in-memory space db");
        SPACE_MIGRATIONS.to_latest(&mut conn).expect("space to_latest");

        assert_eq!(user_version(&conn), 10, "space user_version after to_latest");
        assert_eq!(
            table_names(&conn),
            [
                "agent_config_skills",
                "agent_configs",
                "provider_credentials",
                "skills",
                "space_config",
                "worlds",
            ],
            "space table set at v10"
        );
        assert_eq!(
            named_indexes(&conn),
            ["idx_worlds_name"],
            "space named index set at v10"
        );
    }

    /// world.db fresh install: thirteen migrations → user_version 13, the
    /// exact 20-table set, and the exact 19 named indexes (3 FK lookups from
    /// v1 + 11 UNIQUE from v2 + messages/scene_images/notes/message_attachments
    /// indexes from v4/v8/v11/v13).
    #[test]
    fn world_fresh_install_schema() {
        let mut conn = Connection::open_in_memory().expect("open in-memory world db");
        WORLD_MIGRATIONS.to_latest(&mut conn).expect("world to_latest");

        assert_eq!(user_version(&conn), 13, "world user_version after to_latest");
        assert_eq!(
            table_names(&conn),
            [
                "chapters",
                "character_phases",
                "characters",
                "conversations",
                "event_character_refs",
                "events",
                "items",
                "locations",
                "lores",
                "message_attachments",
                "messages",
                "notes",
                "novels",
                "scene_character_refs",
                "scene_event_refs",
                "scene_images",
                "scene_item_refs",
                "scene_lore_refs",
                "scenes",
                "world_config",
            ],
            "world table set at v13 (20 tables)"
        );
        assert_eq!(
            named_indexes(&conn),
            [
                "idx_chapters_novel",
                "idx_chapters_novel_pos",
                "idx_chapters_novel_title",
                "idx_character_phases_char_pos",
                "idx_characters_name",
                "idx_events_name",
                "idx_items_name",
                "idx_locations_name",
                "idx_lores_name",
                "idx_message_attachments_message",
                "idx_messages_conversation_id",
                "idx_notes_parent_pos",
                "idx_notes_sibling_title",
                "idx_novels_title",
                "idx_phases_character",
                "idx_scene_images_scene",
                "idx_scenes_chapter",
                "idx_scenes_chapter_pos",
                "idx_scenes_chapter_title",
            ],
            "world named index set at v13 (19 indexes)"
        );
    }

    // ── family (b): historical upgrade path ────────────────────────────────

    /// world.db upgrade path: step 0→13 on ONE connection, asserting
    /// user_version and the per-step schema facts (tables added, columns
    /// added / renamed).
    #[test]
    fn world_upgrade_path_step_by_step() {
        let mut conn = Connection::open_in_memory().expect("open in-memory world db");
        for v in 0..=13 {
            WORLD_MIGRATIONS
                .to_version(&mut conn, v)
                .unwrap_or_else(|e| panic!("world to_version({v}): {e}"));
            assert_eq!(user_version(&conn), v as i64, "user_version after step {v}");

            match v {
                0 => {
                    assert!(
                        table_names(&conn).is_empty(),
                        "v0 must be a pristine empty database"
                    );
                }
                1 => {
                    assert_eq!(
                        table_names(&conn).len(),
                        13,
                        "v1 creates the 13 base world tables"
                    );
                    assert_eq!(
                        named_indexes(&conn),
                        [
                            "idx_chapters_novel",
                            "idx_phases_character",
                            "idx_scenes_chapter",
                        ],
                        "v1 ships only the 3 plain FK-lookup indexes"
                    );
                }
                2 => {
                    assert_eq!(
                        named_indexes(&conn).len(),
                        14,
                        "v2 adds exactly 11 UNIQUE indexes on top of the 3 plain ones"
                    );
                    assert!(
                        has_column(&conn, "novels", "description"),
                        "v2 adds novels.description"
                    );
                }
                3 => {
                    assert!(
                        has_column(&conn, "character_phases", "name"),
                        "v3 adds character_phases.name"
                    );
                }
                4 => {
                    let tables = table_names(&conn);
                    assert!(tables.contains(&"conversations".to_string()), "v4 conversations");
                    assert!(tables.contains(&"messages".to_string()), "v4 messages");
                    assert!(
                        named_indexes(&conn)
                            .contains(&"idx_messages_conversation_id".to_string()),
                        "v4 adds idx_messages_conversation_id"
                    );
                }
                5 => {
                    assert!(
                        table_names(&conn).contains(&"world_config".to_string()),
                        "v5 adds world_config"
                    );
                }
                6 => {
                    for t in [
                        "characters",
                        "character_phases",
                        "locations",
                        "items",
                        "lores",
                        "events",
                        "novels",
                    ] {
                        assert!(has_column(&conn, t, "image_blob"), "{t}.image_blob at v6");
                        assert!(has_column(&conn, t, "image_mime"), "{t}.image_mime at v6");
                    }
                }
                7 => {
                    assert!(
                        !has_column(&conn, "character_phases", "changes"),
                        "v7 renames `changes` away"
                    );
                    assert!(
                        has_column(&conn, "character_phases", "description"),
                        "v7 renames `changes` → `description`"
                    );
                    assert!(
                        has_column(&conn, "character_phases", "conversation_style"),
                        "v7 adds character_phases.conversation_style"
                    );
                }
                8 => {
                    assert!(
                        table_names(&conn).contains(&"scene_images".to_string()),
                        "v8 adds scene_images"
                    );
                    assert!(
                        named_indexes(&conn).contains(&"idx_scene_images_scene".to_string()),
                        "v8 adds idx_scene_images_scene"
                    );
                }
                9 => {
                    assert!(
                        has_column(&conn, "novels", "author"),
                        "v9 adds novels.author"
                    );
                }
                10 => {
                    assert!(
                        has_column(&conn, "messages", "usage_input_tokens"),
                        "v10 adds messages.usage_input_tokens"
                    );
                    assert!(
                        has_column(&conn, "messages", "usage_output_tokens"),
                        "v10 adds messages.usage_output_tokens"
                    );
                }
                11 => {
                    assert!(
                        table_names(&conn).contains(&"notes".to_string()),
                        "v11 adds notes"
                    );
                    let indexes = named_indexes(&conn);
                    assert!(
                        indexes.contains(&"idx_notes_sibling_title".to_string()),
                        "v11 adds idx_notes_sibling_title"
                    );
                    assert!(
                        indexes.contains(&"idx_notes_parent_pos".to_string()),
                        "v11 adds idx_notes_parent_pos"
                    );
                }
                12 => {
                    assert!(
                        table_names(&conn).contains(&"scene_lore_refs".to_string()),
                        "v12 adds scene_lore_refs"
                    );
                    assert_eq!(
                        table_names(&conn).len(),
                        19,
                        "world schema has 19 tables at v12"
                    );
                }
                13 => {
                    assert!(
                        table_names(&conn).contains(&"message_attachments".to_string()),
                        "v13 adds message_attachments"
                    );
                    assert!(
                        named_indexes(&conn)
                            .contains(&"idx_message_attachments_message".to_string()),
                        "v13 adds idx_message_attachments_message"
                    );
                    assert_eq!(
                        table_names(&conn).len(),
                        20,
                        "final world schema has 20 tables"
                    );
                }
                _ => unreachable!("loop is bounded to 0..=13"),
            }
        }
    }

    /// space.db upgrade path: step 0→10 on ONE connection, asserting
    /// user_version and the per-step schema facts (tables and columns added,
    /// namer row seeded at v7, vision row seeded at v10).
    #[test]
    fn space_upgrade_path_step_by_step() {
        let mut conn = Connection::open_in_memory().expect("open in-memory space db");
        for v in 0..=10 {
            SPACE_MIGRATIONS
                .to_version(&mut conn, v)
                .unwrap_or_else(|e| panic!("space to_version({v}): {e}"));
            assert_eq!(user_version(&conn), v as i64, "user_version after step {v}");

            match v {
                0 => {
                    assert!(
                        table_names(&conn).is_empty(),
                        "v0 must be a pristine empty database"
                    );
                }
                1 => {
                    assert_eq!(
                        table_names(&conn),
                        ["space_config", "worlds"],
                        "v1 creates worlds + space_config"
                    );
                    assert_eq!(
                        named_indexes(&conn),
                        ["idx_worlds_name"],
                        "v1 creates idx_worlds_name"
                    );
                }
                2 => {
                    assert_eq!(
                        table_names(&conn),
                        [
                            "agent_configs",
                            "provider_credentials",
                            "space_config",
                            "worlds",
                        ],
                        "v2 adds provider_credentials + agent_configs"
                    );
                }
                3 => {
                    assert!(
                        has_column(&conn, "agent_configs", "auto_execute_dangerous_tools"),
                        "v3 adds agent_configs.auto_execute_dangerous_tools"
                    );
                }
                4 => {
                    assert!(has_column(&conn, "worlds", "image_blob"), "v4 worlds.image_blob");
                    assert!(has_column(&conn, "worlds", "image_mime"), "v4 worlds.image_mime");
                }
                5 => {
                    assert!(
                        has_column(&conn, "agent_configs", "context_compaction_enabled"),
                        "v5 adds context_compaction_enabled"
                    );
                    assert!(
                        has_column(&conn, "agent_configs", "context_compaction_turn_age"),
                        "v5 adds context_compaction_turn_age"
                    );
                }
                6 => {
                    assert!(
                        has_column(&conn, "agent_configs", "system_prompt"),
                        "v6 adds agent_configs.system_prompt"
                    );
                }
                7 => {
                    // Data migration: the namer seed row lands exactly once.
                    let count: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM agent_configs WHERE name = 'namer'",
                            [],
                            |row| row.get(0),
                        )
                        .expect("count namer rows at v7");
                    assert_eq!(count, 1, "v7 seeds exactly one namer row");
                }
                8 => {
                    assert!(
                        has_column(&conn, "agent_configs", "shell_tool_enabled"),
                        "v8 adds agent_configs.shell_tool_enabled"
                    );
                }
                9 => {
                    let tables = table_names(&conn);
                    assert!(tables.contains(&"skills".to_string()), "v9 adds skills");
                    assert!(
                        tables.contains(&"agent_config_skills".to_string()),
                        "v9 adds agent_config_skills"
                    );
                    assert_eq!(
                        tables.len(),
                        6,
                        "space schema has 6 tables at v9 (v10 adds no tables)"
                    );
                }
                10 => {
                    // Data migration: the vision seed row lands exactly once.
                    let count: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM agent_configs WHERE name = 'vision'",
                            [],
                            |row| row.get(0),
                        )
                        .expect("count vision rows at v10");
                    assert_eq!(count, 1, "v10 seeds exactly one vision row");
                }
                _ => unreachable!("loop is bounded to 0..=10"),
            }
        }
    }

    // ── targeted risk-spot tests ───────────────────────────────────────────

    /// WORLD v7 RENAME COLUMN preserves data: seed a phase row at v6 with
    /// `changes = 'old look'`, step to v7, and assert the columns flipped
    /// exactly AND the value survived into the renamed `description` column.
    #[test]
    fn world_v7_rename_preserves_phase_changes_data() {
        let mut conn = Connection::open_in_memory().expect("open in-memory world db");
        WORLD_MIGRATIONS
            .to_version(&mut conn, 6)
            .expect("step world to v6");

        // Pre-rename shape: `changes` exists, `description` does not.
        assert!(
            has_column(&conn, "character_phases", "changes"),
            "character_phases.changes exists at v6"
        );
        assert!(
            !has_column(&conn, "character_phases", "description"),
            "character_phases.description must not exist at v6"
        );

        // Satisfy the FK chain: phase.character_id → characters.id. All other
        // NOT NULL columns carry DEFAULTs in the v1 DDL (appearance '',
        // position 0), so only id/character_id/changes/timestamps are needed.
        conn.execute(
            "INSERT INTO characters (id, name, created_at, updated_at)
             VALUES ('c1', 'Hero', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .expect("insert character at v6");
        conn.execute(
            "INSERT INTO character_phases (id, character_id, changes, created_at, updated_at)
             VALUES ('p1', 'c1', 'old look', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .expect("insert phase with changes at v6");

        WORLD_MIGRATIONS
            .to_version(&mut conn, 7)
            .expect("step world to v7");

        // Post-rename shape: columns flipped exactly.
        assert!(
            !has_column(&conn, "character_phases", "changes"),
            "character_phases.changes must be gone at v7"
        );
        assert!(
            has_column(&conn, "character_phases", "description"),
            "character_phases.description exists at v7"
        );

        // The pre-rename value survived into the renamed column.
        let description: String = conn
            .query_row(
                "SELECT description FROM character_phases WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .expect("read renamed description");
        assert_eq!(description, "old look", "data preserved across RENAME COLUMN");
    }

    /// SPACE v7 data migration: the `namer` agent config row is seeded with
    /// the exact fixed literals from SPACE_MIGRATION_007, and re-running
    /// to_latest never duplicates it (INSERT OR IGNORE on UNIQUE name).
    #[test]
    fn space_v7_seeds_namer_row_and_stays_unique() {
        let mut conn = Connection::open_in_memory().expect("open in-memory space db");
        SPACE_MIGRATIONS.to_latest(&mut conn).expect("space to_latest");

        let (name, model_id, created_at, updated_at, system_prompt): (
            String,
            Option<String>,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT name, model_id, created_at, updated_at, system_prompt
                 FROM agent_configs
                 WHERE id = '01a00a6e-36b8-7302-8810-856d81dacb0c'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("namer row exists with the fixed literal id");
        assert_eq!(name, "namer");
        assert!(model_id.is_none(), "namer model_id is NULL");
        assert_eq!(created_at, "9999-12-31T23:59:59.999Z", "fixed far-future literal");
        assert_eq!(updated_at, "9999-12-31T23:59:59.999Z", "fixed far-future literal");
        assert_eq!(system_prompt, "", "namer system_prompt is the empty default");

        // Idempotency: a second to_latest pass must not duplicate the seed row.
        SPACE_MIGRATIONS
            .to_latest(&mut conn)
            .expect("space to_latest re-run");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_configs WHERE name = 'namer'",
                [],
                |row| row.get(0),
            )
            .expect("count namer rows after re-run");
        assert_eq!(count, 1, "re-running to_latest must not duplicate the namer row");
    }

    /// SPACE v10 data migration: the `vision` agent config row is seeded with
    /// the exact fixed literals from SPACE_MIGRATION_010, and re-running
    /// to_latest never duplicates it (INSERT OR IGNORE on UNIQUE name).
    #[test]
    fn space_v10_seeds_vision_row_and_stays_unique() {
        let mut conn = Connection::open_in_memory().expect("open in-memory space db");
        SPACE_MIGRATIONS.to_latest(&mut conn).expect("space to_latest");

        let (name, model_id, created_at, updated_at, system_prompt): (
            String,
            Option<String>,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT name, model_id, created_at, updated_at, system_prompt
                 FROM agent_configs
                 WHERE id = '01a00a6e-36c0-7521-9a3f-3e7c2d9b4f60'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("vision row exists with the fixed literal id");
        assert_eq!(name, "vision");
        assert!(model_id.is_none(), "vision model_id is NULL");
        assert_eq!(created_at, "9999-12-31T23:59:59.999Z", "fixed far-future literal");
        assert_eq!(updated_at, "9999-12-31T23:59:59.999Z", "fixed far-future literal");
        assert_eq!(system_prompt, "", "vision system_prompt is the empty default");

        // Idempotency: a second to_latest pass must not duplicate the seed row.
        SPACE_MIGRATIONS
            .to_latest(&mut conn)
            .expect("space to_latest re-run");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_configs WHERE name = 'vision'",
                [],
                |row| row.get(0),
            )
            .expect("count vision rows after re-run");
        assert_eq!(count, 1, "re-running to_latest must not duplicate the vision row");
    }

    /// to_latest is idempotent for all three database kinds: a second run
    /// neither errors nor moves user_version.
    #[test]
    fn to_latest_twice_is_idempotent_for_all_kinds() {
        let cases: [(&str, &Migrations, i64); 3] = [
            ("meta", &META_MIGRATIONS, 1),
            ("space", &SPACE_MIGRATIONS, 10),
            ("world", &WORLD_MIGRATIONS, 13),
        ];
        for (name, migrations, latest) in cases {
            let mut conn = Connection::open_in_memory().expect("open in-memory db");
            migrations
                .to_latest(&mut conn)
                .unwrap_or_else(|e| panic!("{name} first to_latest: {e}"));
            let after_first = user_version(&conn);
            migrations
                .to_latest(&mut conn)
                .unwrap_or_else(|e| panic!("{name} second to_latest: {e}"));
            let after_second = user_version(&conn);

            assert_eq!(after_first, latest, "{name} user_version after first to_latest");
            assert_eq!(
                after_first, after_second,
                "{name} user_version unchanged after second to_latest"
            );
        }
    }

    /// The migration definitions themselves are valid (built-in convenience:
    /// each runs to_latest against a throwaway in-memory database).
    #[test]
    fn migration_definitions_validate() {
        META_MIGRATIONS.validate().expect("meta migrations validate");
        SPACE_MIGRATIONS.validate().expect("space migrations validate");
        WORLD_MIGRATIONS.validate().expect("world migrations validate");
    }

    /// WORLD v2 name-uniqueness: after stepping 1→2, all 11 UNIQUE indexes
    /// from WORLD_MIGRATION_002 exist, and idx_characters_name actually
    /// rejects a duplicate character name at the schema level.
    #[test]
    fn world_v2_unique_indexes_reject_duplicate_names() {
        let mut conn = Connection::open_in_memory().expect("open in-memory world db");
        WORLD_MIGRATIONS
            .to_version(&mut conn, 1)
            .expect("step world to v1");
        assert_eq!(
            named_indexes(&conn).len(),
            3,
            "v1 predates the unique indexes"
        );

        WORLD_MIGRATIONS
            .to_version(&mut conn, 2)
            .expect("step world to v2");
        let indexes = named_indexes(&conn);
        for idx in [
            "idx_characters_name",
            "idx_locations_name",
            "idx_items_name",
            "idx_lores_name",
            "idx_events_name",
            "idx_novels_title",
            "idx_chapters_novel_title",
            "idx_scenes_chapter_title",
            "idx_character_phases_char_pos",
            "idx_chapters_novel_pos",
            "idx_scenes_chapter_pos",
        ] {
            assert!(indexes.contains(&idx.to_string()), "unique index {idx} present at v2");
        }
        assert_eq!(indexes.len(), 14, "3 plain + 11 unique indexes at v2");

        conn.execute(
            "INSERT INTO characters (id, name, created_at, updated_at)
             VALUES ('c1', 'Dup', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .expect("first character insert succeeds");
        let err = conn
            .execute(
                "INSERT INTO characters (id, name, created_at, updated_at)
                 VALUES ('c2', 'Dup', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect_err("duplicate name must violate idx_characters_name");
        assert!(
            err.to_string().contains("UNIQUE"),
            "expected a UNIQUE constraint violation, got: {err}"
        );
    }
}
