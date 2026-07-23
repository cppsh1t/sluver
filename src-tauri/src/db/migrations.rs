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

/// Migration 2 for `space.db`: AI provider credentials + agents tables
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

    -- AI agents (ADR-0012). Seeded with 'explorer' + 'writer' on Space
    -- creation. `model_id` is a composite '{provider_id}/{model_id}' or NULL.
    -- Deleting a provider credential cascades a NULL-out of dependent agents
    -- (app-layer cascade, see commands::ai::do_delete_provider_credential).
    CREATE TABLE IF NOT EXISTS agents (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        model_id    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
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
const SPACE_SLICE: &[M] = &[M::up(SPACE_SQL), M::up(SPACE_MIGRATION_002)];
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

const WORLD_SLICE: &[M] = &[
    M::up(WORLD_SQL),
    M::up(WORLD_MIGRATION_002),
    M::up(WORLD_MIGRATION_003),
];
pub const WORLD_MIGRATIONS: Migrations = Migrations::from_slice(WORLD_SLICE);
