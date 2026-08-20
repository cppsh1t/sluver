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
    rows.collect::<Result<Vec<_>, _>>()
        .expect("read table_names rows")
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
    rows.collect::<Result<Vec<_>, _>>()
        .expect("read named_indexes rows")
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
    META_MIGRATIONS
        .to_latest(&mut conn)
        .expect("meta to_latest");

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
    SPACE_MIGRATIONS
        .to_latest(&mut conn)
        .expect("space to_latest");

    assert_eq!(
        user_version(&conn),
        10,
        "space user_version after to_latest"
    );
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
    WORLD_MIGRATIONS
        .to_latest(&mut conn)
        .expect("world to_latest");

    assert_eq!(
        user_version(&conn),
        13,
        "world user_version after to_latest"
    );
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
                assert!(
                    tables.contains(&"conversations".to_string()),
                    "v4 conversations"
                );
                assert!(tables.contains(&"messages".to_string()), "v4 messages");
                assert!(
                    named_indexes(&conn).contains(&"idx_messages_conversation_id".to_string()),
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
                    named_indexes(&conn).contains(&"idx_message_attachments_message".to_string()),
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
                assert!(
                    has_column(&conn, "worlds", "image_blob"),
                    "v4 worlds.image_blob"
                );
                assert!(
                    has_column(&conn, "worlds", "image_mime"),
                    "v4 worlds.image_mime"
                );
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
    assert_eq!(
        description, "old look",
        "data preserved across RENAME COLUMN"
    );
}

/// SPACE v7 data migration: the `namer` agent config row is seeded with
/// the exact fixed literals from SPACE_MIGRATION_007, and re-running
/// to_latest never duplicates it (INSERT OR IGNORE on UNIQUE name).
#[test]
fn space_v7_seeds_namer_row_and_stays_unique() {
    let mut conn = Connection::open_in_memory().expect("open in-memory space db");
    SPACE_MIGRATIONS
        .to_latest(&mut conn)
        .expect("space to_latest");

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
    assert_eq!(
        created_at, "9999-12-31T23:59:59.999Z",
        "fixed far-future literal"
    );
    assert_eq!(
        updated_at, "9999-12-31T23:59:59.999Z",
        "fixed far-future literal"
    );
    assert_eq!(
        system_prompt, "",
        "namer system_prompt is the empty default"
    );

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
    assert_eq!(
        count, 1,
        "re-running to_latest must not duplicate the namer row"
    );
}

/// SPACE v10 data migration: the `vision` agent config row is seeded with
/// the exact fixed literals from SPACE_MIGRATION_010, and re-running
/// to_latest never duplicates it (INSERT OR IGNORE on UNIQUE name).
#[test]
fn space_v10_seeds_vision_row_and_stays_unique() {
    let mut conn = Connection::open_in_memory().expect("open in-memory space db");
    SPACE_MIGRATIONS
        .to_latest(&mut conn)
        .expect("space to_latest");

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
    assert_eq!(
        created_at, "9999-12-31T23:59:59.999Z",
        "fixed far-future literal"
    );
    assert_eq!(
        updated_at, "9999-12-31T23:59:59.999Z",
        "fixed far-future literal"
    );
    assert_eq!(
        system_prompt, "",
        "vision system_prompt is the empty default"
    );

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
    assert_eq!(
        count, 1,
        "re-running to_latest must not duplicate the vision row"
    );
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

        assert_eq!(
            after_first, latest,
            "{name} user_version after first to_latest"
        );
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
    META_MIGRATIONS
        .validate()
        .expect("meta migrations validate");
    SPACE_MIGRATIONS
        .validate()
        .expect("space migrations validate");
    WORLD_MIGRATIONS
        .validate()
        .expect("world migrations validate");
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
        assert!(
            indexes.contains(&idx.to_string()),
            "unique index {idx} present at v2"
        );
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
