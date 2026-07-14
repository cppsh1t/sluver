use rusqlite_migration::{M, Migrations};

// ─── meta.db schema ─────────────────────────────────────────────────────────

const META_SQL: &str = r#"
    -- World registry: tracks all worlds and their DB file paths.
    -- The `worlds` row here IS the World entity's source of truth
    -- (name, description). Each world DB does NOT have its own `worlds` table.
    CREATE TABLE worlds (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        db_path     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Application-level key-value settings (AppConfig).
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
"#;

// ─── world DB schema ────────────────────────────────────────────────────────

const WORLD_SQL: &str = r#"
    -- Characters (no world_id column — implicit to this DB file)
    CREATE TABLE characters (
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
    CREATE TABLE locations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Items
    CREATE TABLE items (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Lore
    CREATE TABLE lores (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    -- Events (before character_phases — phases FK to events)
    CREATE TABLE events (
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
    CREATE TABLE character_phases (
        id               TEXT PRIMARY KEY,
        character_id     TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        appearance       TEXT NOT NULL DEFAULT '',
        changes          TEXT NOT NULL DEFAULT '',
        trigger_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        position         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_phases_character ON character_phases(character_id);

    -- Event ↔ Character refs (junction, composite PK = set semantics)
    CREATE TABLE event_character_refs (
        event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        phase_id     TEXT NOT NULL REFERENCES character_phases(id) ON DELETE CASCADE,
        PRIMARY KEY (event_id, character_id, phase_id)
    );

    -- Novels
    CREATE TABLE novels (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- Chapters (position column maintains reading order within novel)
    CREATE TABLE chapters (
        id         TEXT PRIMARY KEY,
        novel_id   TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        summary    TEXT NOT NULL DEFAULT '',
        position   INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_chapters_novel ON chapters(novel_id);

    -- Scenes (position column maintains narrative order within chapter)
    CREATE TABLE scenes (
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
    CREATE INDEX idx_scenes_chapter ON scenes(chapter_id);

    -- Scene ↔ Character refs (junction, composite PK = set semantics)
    CREATE TABLE scene_character_refs (
        scene_id     TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        phase_id     TEXT NOT NULL REFERENCES character_phases(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, character_id, phase_id)
    );

    -- Scene ↔ Item refs (junction)
    CREATE TABLE scene_item_refs (
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, item_id)
    );

    -- Scene ↔ Event refs (junction)
    CREATE TABLE scene_event_refs (
        scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, event_id)
    );
"#;

/// Migrations for `meta.db` (world registry + app settings).
const META_MIGRATION_002: &str = r#"
    CREATE UNIQUE INDEX idx_worlds_name ON worlds(name);
"#;

const META_SLICE: &[M] = &[M::up(META_SQL), M::up(META_MIGRATION_002)];
pub const META_MIGRATIONS: Migrations = Migrations::from_slice(META_SLICE);

/// Migrations for each world DB file (all world-scoped tables).
const WORLD_MIGRATION_002: &str = r#"
    -- Name/title uniqueness
    CREATE UNIQUE INDEX idx_characters_name ON characters(name);
    CREATE UNIQUE INDEX idx_locations_name ON locations(name);
    CREATE UNIQUE INDEX idx_items_name ON items(name);
    CREATE UNIQUE INDEX idx_lores_name ON lores(name);
    CREATE UNIQUE INDEX idx_events_name ON events(name);
    CREATE UNIQUE INDEX idx_novels_title ON novels(title);
    CREATE UNIQUE INDEX idx_chapters_novel_title ON chapters(novel_id, title);
    CREATE UNIQUE INDEX idx_scenes_chapter_title ON scenes(chapter_id, title);

    -- Position uniqueness per parent scope
    CREATE UNIQUE INDEX idx_character_phases_char_pos ON character_phases(character_id, position);
    CREATE UNIQUE INDEX idx_chapters_novel_pos ON chapters(novel_id, position);
    CREATE UNIQUE INDEX idx_scenes_chapter_pos ON scenes(chapter_id, position);

    -- Novel description column
    ALTER TABLE novels ADD COLUMN description TEXT NOT NULL DEFAULT '';
"#;

const WORLD_SLICE: &[M] = &[M::up(WORLD_SQL), M::up(WORLD_MIGRATION_002)];
pub const WORLD_MIGRATIONS: Migrations = Migrations::from_slice(WORLD_SLICE);
