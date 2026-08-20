use super::*;
use crate::testutil::{make_space_with_world, uuid_shape, with_world, WorldFixture};

const NOW: &str = "2026-01-01T00:00:00.000Z";

/// Sum of one scene's rows across all four junction tables.
const SCENE_JUNCTION_SUM: &str = "SELECT
        (SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1) +
        (SELECT COUNT(*) FROM scene_item_refs    WHERE scene_id = ?1) +
        (SELECT COUNT(*) FROM scene_event_refs   WHERE scene_id = ?1) +
        (SELECT COUNT(*) FROM scene_lore_refs    WHERE scene_id = ?1)";

/// Sum of the junction rows of every scene under one chapter.
const CHAPTER_JUNCTION_SUM: &str = "SELECT
        (SELECT COUNT(*) FROM scene_character_refs r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1) +
        (SELECT COUNT(*) FROM scene_item_refs    r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1) +
        (SELECT COUNT(*) FROM scene_event_refs   r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1) +
        (SELECT COUNT(*) FROM scene_lore_refs    r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1)";

/// Sum of ALL junction rows in the world db (the fixture world is
/// isolated, so global counts are exact for single-novel setups).
const ALL_JUNCTION_SUM: &str = "SELECT
        (SELECT COUNT(*) FROM scene_character_refs) +
        (SELECT COUNT(*) FROM scene_item_refs) +
        (SELECT COUNT(*) FROM scene_event_refs) +
        (SELECT COUNT(*) FROM scene_lore_refs)";

// ─── input builders ─────────────────────────────────────────────────────

fn novel_input(title: &str) -> CreateNovelInput {
    CreateNovelInput {
        title: title.into(),
        description: String::new(),
        author: String::new(),
        tags: Vec::new(),
    }
}

fn chapter_input(title: &str) -> CreateChapterInput {
    CreateChapterInput {
        title: title.into(),
        summary: String::new(),
    }
}

fn char_ref(character_id: String, phase_id: String) -> CharacterRef {
    CharacterRef {
        character_id,
        phase_id,
    }
}

fn scene_input(
    title: &str,
    character_refs: Vec<CharacterRef>,
    item_ids: Vec<String>,
    event_ids: Vec<String>,
    lore_ids: Vec<String>,
) -> CreateSceneInput {
    CreateSceneInput {
        title: title.into(),
        summary: String::new(),
        content: String::new(),
        start_at: None,
        end_at: None,
        character_refs,
        location_id: None,
        item_ids,
        event_ids,
        lore_ids,
    }
}

/// Same shape as `scene_input` but for the full-replacement update path
/// (`UpdateSceneInput` has no serde defaults — every field is required).
fn scene_update(
    title: &str,
    character_refs: Vec<CharacterRef>,
    item_ids: Vec<String>,
    event_ids: Vec<String>,
    lore_ids: Vec<String>,
) -> UpdateSceneInput {
    UpdateSceneInput {
        title: title.into(),
        summary: String::new(),
        content: String::new(),
        start_at: None,
        end_at: None,
        character_refs,
        location_id: None,
        item_ids,
        event_ids,
        lore_ids,
    }
}

// ─── raw-SQL fixtures ───────────────────────────────────────────────────

/// Insert a character + one phase via raw SQL; returns (character_id,
/// phase_id). Column lists mirror the WORLD_SQL DDL (aliases/tags are JSON
/// '[]'; NOT NULL columns are all satisfied).
fn insert_character_with_phase(fx: &WorldFixture, n: u64) -> (String, String) {
    let cid = uuid_shape(n);
    let pid = uuid_shape(n + 5000);
    with_world(fx, |conn| {
            conn.execute(
                "INSERT INTO characters (id, name, aliases, description, notes, tags, created_at, updated_at)
                 VALUES (?1, ?2, '[]', '', '', '[]', ?3, ?3)",
                params![&cid, format!("char-{n}"), NOW],
            )?;
            conn.execute(
                "INSERT INTO character_phases (id, character_id, name, appearance, description, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', '', 0, ?4, ?4)",
                params![&pid, &cid, format!("phase-{n}"), NOW],
            )?;
            Ok(())
        })
        .expect("insert character + phase");
    (cid, pid)
}

/// Insert an item row; returns its id.
fn insert_item(fx: &WorldFixture, n: u64) -> String {
    insert_named(fx, "items", n)
}

/// Insert an event row; returns its id.
fn insert_event(fx: &WorldFixture, n: u64) -> String {
    insert_named(fx, "events", n)
}

/// Insert a lore row; returns its id.
fn insert_lore(fx: &WorldFixture, n: u64) -> String {
    insert_named(fx, "lores", n)
}

/// Shared INSERT for the identically-shaped items/events/lores tables
/// (events' extra start_at/end_at/location_id columns are nullable).
fn insert_named(fx: &WorldFixture, table: &str, n: u64) -> String {
    let id = uuid_shape(n + 10000);
    let sql = format!(
        "INSERT INTO {table} (id, name, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, '', '', '[]', ?3, ?3)"
    );
    with_world(fx, |conn| {
        conn.execute(&sql, params![&id, format!("{table}-{n}"), NOW])?;
        Ok(())
    })
    .expect("insert world entity row");
    id
}

/// Bootstrap novel → chapter → scene-with-all-four-ref-kinds via the
/// `do_*` helpers themselves. Returns (novel, chapter, scene).
fn novel_chapter_scene(fx: &WorldFixture) -> (Novel, Chapter, Scene) {
    let novel = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("N"), None)
        .expect("create novel");
    let chapter = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel.id,
        &chapter_input("C"),
        None,
    )
    .expect("create chapter");
    let (cid, pid) = insert_character_with_phase(fx, 10);
    let item_id = insert_item(fx, 11);
    let event_id = insert_event(fx, 12);
    let lore_id = insert_lore(fx, 13);
    let scene = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &chapter.id,
        &scene_input(
            "S",
            vec![char_ref(cid, pid)],
            vec![item_id],
            vec![event_id],
            vec![lore_id],
        ),
        None,
    )
    .expect("create scene");
    (novel, chapter, scene)
}

// ─── assertion helpers ──────────────────────────────────────────────────

/// Run a scalar COUNT/SELECT-int query and expect success.
fn count(fx: &WorldFixture, sql: &str, args: &[&dyn rusqlite::ToSql]) -> i64 {
    with_world(fx, |conn| {
        Ok(conn.query_row(sql, args, |row| row.get::<_, i64>(0))?)
    })
    .expect("count query")
}

/// Read the `position` column of one row in `chapters` / `scenes`.
fn position_of(fx: &WorldFixture, table: &str, id: &str) -> i64 {
    let sql = format!("SELECT position FROM {table} WHERE id = ?1");
    with_world(fx, |conn| {
        Ok(conn.query_row(&sql, params![id], |row| row.get::<_, i64>(0))?)
    })
    .expect("read position")
}

/// Assert `err` is a SQLite constraint violation (UNIQUE / FK / PK) —
/// the raw `DbError::Sqlite` shape, since novels have no DuplicateName
/// business variant.
fn assert_constraint_violation(err: &DbError) {
    match err {
        DbError::Sqlite(rusqlite::Error::SqliteFailure(e, _)) => {
            assert_eq!(
                e.code,
                rusqlite::ErrorCode::ConstraintViolation,
                "expected ConstraintViolation, got {:?}",
                e.code
            );
        }
        other => panic!("expected DbError::Sqlite, got {other:?}"),
    }
}

// ─── create_scene: junction writes + position assignment ────────────────

/// `do_create_scene` writes the scene row plus all four junction tables
/// in one shot, and assigns position = MAX+1 within the chapter (the
/// first scene gets 0, the second gets 1).
#[test]
fn create_scene_writes_row_and_all_junction_tables() {
    let fx = make_space_with_world();
    let (_novel, chapter, scene) = novel_chapter_scene(&fx);

    with_world(&fx, |conn| {
        let (title, position): (String, i64) = conn
            .query_row(
                "SELECT title, position FROM scenes WHERE id = ?1",
                params![scene.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("scene row must exist");
        assert_eq!(title, "S");
        assert_eq!(position, 0, "first scene in chapter gets position 0");
        Ok(())
    })
    .expect("assert scene row");

    let r = &scene.character_refs[0];
    let n_chars = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1 AND character_id = ?2 AND phase_id = ?3",
            &[&scene.id, &r.character_id, &r.phase_id],
        );
    assert_eq!(n_chars, 1, "character ref row written");
    let n_items = count(
        &fx,
        "SELECT COUNT(*) FROM scene_item_refs WHERE scene_id = ?1",
        &[&scene.id],
    );
    assert_eq!(n_items, 1, "item ref row written");
    let n_events = count(
        &fx,
        "SELECT COUNT(*) FROM scene_event_refs WHERE scene_id = ?1",
        &[&scene.id],
    );
    assert_eq!(n_events, 1, "event ref row written");
    let n_lores = count(
        &fx,
        "SELECT COUNT(*) FROM scene_lore_refs WHERE scene_id = ?1",
        &[&scene.id],
    );
    assert_eq!(n_lores, 1, "lore ref row written");

    // Second scene in the SAME chapter → position = MAX(position)+1.
    let scene2 = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &chapter.id,
        &scene_input("S2", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect("create second scene");
    let pos2 = position_of(&fx, "scenes", &scene2.id);
    assert_eq!(pos2, 1, "second scene gets MAX(position)+1");
}

// ─── update_scene: full-replacement junction rewrite ────────────────────

/// `do_update_scene` is full-replacement on the junction tables: the old
/// ref rows are deleted and the new set inserted (old gone, new present).
#[test]
fn update_scene_replaces_junction_refs() {
    let fx = make_space_with_world();
    let novel = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("N"), None)
        .expect("create novel");
    let chapter = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel.id,
        &chapter_input("C"),
        None,
    )
    .expect("create chapter");
    let (cid_a, pid_a) = insert_character_with_phase(&fx, 20);
    let (cid_b, pid_b) = insert_character_with_phase(&fx, 21);
    let item_a = insert_item(&fx, 22);
    let item_b = insert_item(&fx, 23);
    let event_b = insert_event(&fx, 24);
    let lore_b = insert_lore(&fx, 25);

    let scene = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &chapter.id,
        &scene_input(
            "Old",
            vec![char_ref(cid_a.clone(), pid_a.clone())],
            vec![item_a.clone()],
            vec![],
            vec![],
        ),
        None,
    )
    .expect("create scene");

    do_update_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &scene.id,
        &scene_update(
            "New",
            vec![char_ref(cid_b.clone(), pid_b.clone())],
            vec![item_b.clone()],
            vec![event_b.clone()],
            vec![lore_b.clone()],
        ),
        None,
    )
    .expect("update scene refs");

    let old_char = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1 AND character_id = ?2 AND phase_id = ?3",
            &[&scene.id, &cid_a, &pid_a],
        );
    assert_eq!(old_char, 0, "old character ref must be gone");
    let new_char = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1 AND character_id = ?2 AND phase_id = ?3",
            &[&scene.id, &cid_b, &pid_b],
        );
    assert_eq!(new_char, 1, "new character ref must be present");
    let old_item = count(
        &fx,
        "SELECT COUNT(*) FROM scene_item_refs WHERE scene_id = ?1 AND item_id = ?2",
        &[&scene.id, &item_a],
    );
    assert_eq!(old_item, 0, "old item ref must be gone");
    let new_item = count(
        &fx,
        "SELECT COUNT(*) FROM scene_item_refs WHERE scene_id = ?1 AND item_id = ?2",
        &[&scene.id, &item_b],
    );
    assert_eq!(new_item, 1, "new item ref must be present");
    let new_event = count(
        &fx,
        "SELECT COUNT(*) FROM scene_event_refs WHERE scene_id = ?1 AND event_id = ?2",
        &[&scene.id, &event_b],
    );
    assert_eq!(new_event, 1, "new event ref must be present");
    let new_lore = count(
        &fx,
        "SELECT COUNT(*) FROM scene_lore_refs WHERE scene_id = ?1 AND lore_id = ?2",
        &[&scene.id, &lore_b],
    );
    assert_eq!(new_lore, 1, "new lore ref must be present");

    let title: String = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT title FROM scenes WHERE id = ?1",
            params![scene.id],
            |row| row.get(0),
        )?)
    })
    .expect("read scene title");
    assert_eq!(title, "New");
}

/// Transaction atomicity: an update_scene input containing a nonexistent
/// character_id fails on the FK constraint during the junction INSERT
/// loop (after the DELETEs already ran), and the whole transaction rolls
/// back — the old refs AND the old field values must be fully intact.
#[test]
fn update_scene_fk_violation_rolls_back() {
    let fx = make_space_with_world();
    let (_novel, _chapter, scene) = novel_chapter_scene(&fx);

    let ghost_character = uuid_shape(9999);
    let original_phase = scene.character_refs[0].phase_id.clone();
    let err = do_update_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &scene.id,
        &scene_update(
            "New",
            vec![char_ref(ghost_character, original_phase)],
            vec![],
            vec![],
            vec![],
        ),
        None,
    )
    .expect_err("nonexistent character_id must reject");
    assert_constraint_violation(&err);

    // Old refs fully intact (one row in each of the four junction tables).
    let junctions = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
    assert_eq!(junctions, 4, "old refs must survive the rollback");

    // The field UPDATE rolled back together with the junction writes.
    let title: String = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT title FROM scenes WHERE id = ?1",
            params![scene.id],
            |row| row.get(0),
        )?)
    })
    .expect("read scene title");
    assert_eq!(title, "S", "field UPDATE must roll back with the junctions");
}

/// Composite-PK set semantics: the same (character_id, phase_id) pair
/// twice in one update_scene input trips PRIMARY KEY(scene_id,
/// character_id, phase_id) on the second INSERT; the transaction rolls
/// back and the pre-update refs stay intact.
#[test]
fn update_scene_duplicate_ref_pair_rejects() {
    let fx = make_space_with_world();
    let (_novel, _chapter, scene) = novel_chapter_scene(&fx);

    let original = &scene.character_refs[0];
    let err = do_update_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &scene.id,
        &scene_update(
            "New",
            vec![
                char_ref(original.character_id.clone(), original.phase_id.clone()),
                char_ref(original.character_id.clone(), original.phase_id.clone()),
            ],
            vec![],
            vec![],
            vec![],
        ),
        None,
    )
    .expect_err("duplicate ref pair must reject");
    assert_constraint_violation(&err);

    let n_chars = count(
        &fx,
        "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1",
        &[&scene.id],
    );
    assert_eq!(
        n_chars, 1,
        "old character ref must be intact after rollback"
    );
    let junctions = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
    assert_eq!(junctions, 4, "old refs must be intact after rollback");
}

// ─── reorder: temp-shift semantics ──────────────────────────────────────

/// Reorder temp-shift semantics: swapping two chapters [B, A] must not
/// trip UNIQUE(novel_id, position) — the +1000000 shift dance exists for
/// exactly this. A chapter id belonging to a DIFFERENT novel matches zero
/// rows in the novel-scoped UPDATE → NotFound, and the failed transaction
/// (including its temp-shift) rolls back.
#[test]
fn reorder_chapters_swaps_and_rejects_foreign_chapter() {
    let fx = make_space_with_world();
    let novel_a = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("A"), None)
        .expect("create novel A");
    let novel_b = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("B"), None)
        .expect("create novel B");
    let a1 = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_a.id,
        &chapter_input("A1"),
        None,
    )
    .expect("create chapter A1");
    let a2 = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_a.id,
        &chapter_input("A2"),
        None,
    )
    .expect("create chapter A2");
    let b1 = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_b.id,
        &chapter_input("B1"),
        None,
    )
    .expect("create chapter B1");

    assert_eq!(position_of(&fx, "chapters", &a1.id), 0);
    assert_eq!(position_of(&fx, "chapters", &a2.id), 1);

    // Swap: [A2, A1] — without the temp-shift this would violate
    // UNIQUE(novel_id, position) on the first per-row update.
    do_reorder_chapters(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_a.id,
        &[a2.id.clone(), a1.id.clone()],
        None,
    )
    .expect("swap chapters");
    assert_eq!(position_of(&fx, "chapters", &a2.id), 0);
    assert_eq!(position_of(&fx, "chapters", &a1.id), 1);

    // A chapter of another novel: the scoped UPDATE matches 0 rows.
    let err = do_reorder_chapters(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_a.id,
        std::slice::from_ref(&b1.id),
        None,
    )
    .expect_err("foreign chapter must be rejected");
    assert!(matches!(err, DbError::NotFound("Chapter", _)));

    // The rejected reorder (and its temp-shift) rolled back.
    assert_eq!(
        position_of(&fx, "chapters", &a1.id),
        1,
        "failed reorder must not corrupt positions"
    );
    assert_eq!(
        position_of(&fx, "chapters", &a2.id),
        0,
        "failed reorder must not corrupt positions"
    );
    assert_eq!(position_of(&fx, "chapters", &b1.id), 0);
}

/// Same reorder semantics scoped to a chapter: swapping scenes must not
/// trip UNIQUE(chapter_id, position); a scene of a DIFFERENT chapter is
/// NotFound and the failed attempt leaves positions untouched.
#[test]
fn reorder_scenes_swaps_and_rejects_foreign_scene() {
    let fx = make_space_with_world();
    let novel = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("N"), None)
        .expect("create novel");
    let c1 = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel.id,
        &chapter_input("C1"),
        None,
    )
    .expect("create chapter C1");
    let c2 = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel.id,
        &chapter_input("C2"),
        None,
    )
    .expect("create chapter C2");
    let s1 = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &c1.id,
        &scene_input("S1", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect("create scene S1");
    let s2 = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &c1.id,
        &scene_input("S2", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect("create scene S2");
    let s_other = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &c2.id,
        &scene_input("OTHER", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect("create scene in other chapter");

    do_reorder_scenes(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &c1.id,
        &[s2.id.clone(), s1.id.clone()],
        None,
    )
    .expect("swap scenes");
    assert_eq!(position_of(&fx, "scenes", &s2.id), 0);
    assert_eq!(position_of(&fx, "scenes", &s1.id), 1);

    let err = do_reorder_scenes(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &c1.id,
        std::slice::from_ref(&s_other.id),
        None,
    )
    .expect_err("scene of another chapter must be rejected");
    assert!(matches!(err, DbError::NotFound("Scene", _)));

    assert_eq!(
        position_of(&fx, "scenes", &s1.id),
        1,
        "failed reorder must not corrupt positions"
    );
    assert_eq!(
        position_of(&fx, "scenes", &s2.id),
        0,
        "failed reorder must not corrupt positions"
    );
}

// ─── cascades ───────────────────────────────────────────────────────────

/// ON DELETE CASCADE on the junction tables: deleting a scene removes its
/// rows in all four junction tables (never orphaned).
#[test]
fn delete_scene_cascades_junction_rows() {
    let fx = make_space_with_world();
    let (_novel, _chapter, scene) = novel_chapter_scene(&fx);

    let before = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
    assert_eq!(before, 4, "one row per junction table before delete");

    do_delete_scene(&fx.mgr, &fx.space_id, &fx.world_id, &scene.id, None).expect("delete scene");

    let scenes = count(
        &fx,
        "SELECT COUNT(*) FROM scenes WHERE id = ?1",
        &[&scene.id],
    );
    assert_eq!(scenes, 0, "scene row must be gone");
    let after = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
    assert_eq!(after, 0, "all four junction sets must cascade");
}

/// Deleting a chapter cascades to its scenes AND their junction rows.
#[test]
fn delete_chapter_cascades_scenes_and_junctions() {
    let fx = make_space_with_world();
    let (novel, chapter, scene) = novel_chapter_scene(&fx);
    let scene2 = do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &chapter.id,
        &scene_input("S2", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect("create second scene");

    let scenes_before = count(
        &fx,
        "SELECT COUNT(*) FROM scenes WHERE chapter_id = ?1",
        &[&chapter.id],
    );
    assert_eq!(scenes_before, 2);
    let junctions_before = count(&fx, CHAPTER_JUNCTION_SUM, &[&chapter.id]);
    assert_eq!(junctions_before, 4, "junction rows of both scenes counted");

    do_delete_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &chapter.id, None)
        .expect("delete chapter");

    let chapters = count(
        &fx,
        "SELECT COUNT(*) FROM chapters WHERE id = ?1",
        &[&chapter.id],
    );
    assert_eq!(chapters, 0, "chapter row must be gone");
    let scenes_after = count(
        &fx,
        "SELECT COUNT(*) FROM scenes WHERE chapter_id = ?1",
        &[&chapter.id],
    );
    assert_eq!(scenes_after, 0, "both scenes must cascade");
    let junctions_after = count(&fx, CHAPTER_JUNCTION_SUM, &[&chapter.id]);
    assert_eq!(junctions_after, 0, "scene junction rows must cascade");
    let junctions_by_scene = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id])
        + count(&fx, SCENE_JUNCTION_SUM, &[&scene2.id]);
    assert_eq!(
        junctions_by_scene, 0,
        "junction rows must be gone per scene too"
    );
    // The novel itself survives.
    let novels = count(
        &fx,
        "SELECT COUNT(*) FROM novels WHERE id = ?1",
        &[&novel.id],
    );
    assert_eq!(novels, 1, "novel must survive chapter deletion");
}

/// Deleting a novel cascades chapters → scenes → junction rows (the full
/// tree), via the FK ON DELETE CASCADE chain.
#[test]
fn delete_novel_cascades_chapters_scenes_junctions() {
    let fx = make_space_with_world();
    let (novel, chapter, _scene) = novel_chapter_scene(&fx);
    // Add a second chapter with its own scene for a wider tree.
    let chapter2 = do_create_chapter(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel.id,
        &chapter_input("C2"),
        None,
    )
    .expect("create chapter 2");
    do_create_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &chapter2.id,
        &scene_input("S2", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect("create scene in chapter 2");

    let chapters_before = count(
        &fx,
        "SELECT COUNT(*) FROM chapters WHERE novel_id = ?1",
        &[&novel.id],
    );
    assert_eq!(chapters_before, 2);
    let junctions_before = count(&fx, ALL_JUNCTION_SUM, &[]);
    assert_eq!(
        junctions_before, 4,
        "fixture world holds only this novel's junctions"
    );

    do_delete_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel.id, None).expect("delete novel");

    let novels = count(
        &fx,
        "SELECT COUNT(*) FROM novels WHERE id = ?1",
        &[&novel.id],
    );
    assert_eq!(novels, 0, "novel row must be gone");
    let chapters_after = count(
        &fx,
        "SELECT COUNT(*) FROM chapters WHERE novel_id = ?1",
        &[&novel.id],
    );
    assert_eq!(chapters_after, 0, "chapters must cascade");
    let scenes_of_chapter = count(
        &fx,
        "SELECT COUNT(*) FROM scenes WHERE chapter_id = ?1",
        &[&chapter.id],
    );
    assert_eq!(scenes_of_chapter, 0, "scenes must cascade");
    let junctions_after = count(&fx, ALL_JUNCTION_SUM, &[]);
    assert_eq!(
        junctions_after, 0,
        "junction rows must cascade all the way down"
    );
}

// ─── uniqueness + NotFound mapping ──────────────────────────────────────

/// Novel titles are unique per world (`idx_novels_title`); there is no
/// DuplicateName business variant for novels — the raw UNIQUE violation
/// surfaces as `DbError::Sqlite` with `ErrorCode::ConstraintViolation`.
#[test]
fn create_novel_duplicate_title_rejects() {
    let fx = make_space_with_world();
    do_create_novel(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_input("Same"),
        None,
    )
    .expect("first novel with title");
    let err = do_create_novel(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &novel_input("Same"),
        None,
    )
    .expect_err("duplicate title must reject");
    assert_constraint_violation(&err);

    let n = count(&fx, "SELECT COUNT(*) FROM novels", &[]);
    assert_eq!(n, 1, "only the first novel row exists");
}

/// `update_scene` on a nonexistent id: the UPDATE affects 0 rows → the
/// `rows_affected == 0` → `NotFound("Scene", id)` mapping.
#[test]
fn update_scene_not_found() {
    let fx = make_space_with_world();
    let ghost = uuid_shape(8888);
    let err = do_update_scene(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ghost,
        &scene_update("Ghost", vec![], vec![], vec![], vec![]),
        None,
    )
    .expect_err("update on nonexistent scene must reject");
    match err {
        DbError::NotFound(entity, id) => {
            assert_eq!(entity, "Scene");
            assert_eq!(id, ghost);
        }
        other => panic!("expected NotFound, got {other:?}"),
    }
}
