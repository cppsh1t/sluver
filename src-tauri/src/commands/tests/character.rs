use super::*;
use crate::testutil::{make_space_with_world, uuid_shape, with_world};

/// Timestamp for raw-SQL parent rows (only NOT NULL columns need values).
const T: &str = "2026-01-01T00:00:00.000Z";

fn char_input(name: &str) -> CreateCharacterInput {
    CreateCharacterInput {
        name: name.into(),
        aliases: vec![],
        description: String::new(),
        notes: String::new(),
        tags: vec![],
    }
}

fn phase_input(name: &str) -> CreatePhaseInput {
    CreatePhaseInput {
        name: name.into(),
        appearance: String::new(),
        description: String::new(),
        conversation_style: String::new(),
        trigger_event_id: None,
    }
}

fn count(c: &rusqlite::Connection, sql: &str, arg: &str) -> rusqlite::Result<i64> {
    c.query_row(sql, params![arg], |r| r.get(0))
}

fn phase_pos(c: &rusqlite::Connection, phase_id: &str) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT position FROM character_phases WHERE id = ?1",
        params![phase_id],
        |r| r.get(0),
    )
}

/// Insert a minimal events row (only NOT NULL-without-default columns).
fn seed_event(c: &rusqlite::Connection, event_id: &str, name: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO events (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![event_id, name, T],
    )?;
    Ok(())
}

/// Insert a minimal novel → chapter → scene chain (scenes need the full
/// parent chain because `chapter_id` is NOT NULL). The novel title is
/// derived from `novel_id` — `novels.title` carries a UNIQUE index, so
/// two chains in one test must not share a title.
fn seed_scene(
    c: &rusqlite::Connection,
    novel_id: &str,
    chapter_id: &str,
    scene_id: &str,
) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO novels (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![novel_id, novel_id, T],
    )?;
    c.execute(
        "INSERT INTO chapters (id, novel_id, title, position, created_at, updated_at)
             VALUES (?1, ?2, 'C', 0, ?3, ?3)",
        params![chapter_id, novel_id, T],
    )?;
    c.execute(
        "INSERT INTO scenes (id, chapter_id, title, position, created_at, updated_at)
             VALUES (?1, ?2, 'S', 0, ?3, ?3)",
        params![scene_id, chapter_id, T],
    )?;
    Ok(())
}

fn is_unique_violation(err: &DbError) -> bool {
    matches!(
        err,
        DbError::Sqlite(rusqlite::Error::SqliteFailure(ref e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

// 1. add_phase positions: MAX+1 per character (0-based), scoped per character.
#[test]
fn add_phase_positions_are_max_plus_one_per_character() {
    let fx = make_space_with_world();
    let a = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Aria"),
        None,
    )
    .expect("create A");
    let b = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Brin"),
        None,
    )
    .expect("create B");

    let a0 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &phase_input("childhood"),
        None,
    )
    .expect("A phase 0");
    let a1 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &phase_input("adult"),
        None,
    )
    .expect("A phase 1");
    let b0 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &b.id,
        &phase_input("only"),
        None,
    )
    .expect("B phase 0");

    let positions: (i64, i64, i64) = with_world(&fx, |c| {
        Ok((
            phase_pos(c, &a0.id)?,
            phase_pos(c, &a1.id)?,
            phase_pos(c, &b0.id)?,
        ))
    })
    .expect("read positions");
    assert_eq!(positions, (0, 1, 0));
}

// 2. reorder_phases: temp-shift reorder works; a phase id belonging to
//    another character → NotFound, and the failed transaction rolls back.
#[test]
fn reorder_phases_swaps_and_rejects_foreign_phase() {
    let fx = make_space_with_world();
    let a = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Aria"),
        None,
    )
    .expect("create A");
    let b = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Brin"),
        None,
    )
    .expect("create B");
    let pa = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &phase_input("first"),
        None,
    )
    .expect("A phase a");
    let pb = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &phase_input("second"),
        None,
    )
    .expect("A phase b");
    let qb = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &b.id,
        &phase_input("b-only"),
        None,
    )
    .expect("B phase");

    // [b, a] — reversal via the temp-shift (+1000000) dance.
    do_reorder_phases(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &[pb.id.clone(), pa.id.clone()],
        None,
    )
    .expect("reorder within one character");
    let swapped: (i64, i64) =
        with_world(&fx, |c| Ok((phase_pos(c, &pa.id)?, phase_pos(c, &pb.id)?)))
            .expect("positions after reorder");
    assert_eq!(swapped, (1, 0));

    // Phase id from ANOTHER character → Err NotFound("Phase", id).
    let err = do_reorder_phases(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &[pa.id.clone(), qb.id.clone()],
        None,
    )
    .expect_err("foreign phase id must be rejected");
    match err {
        DbError::NotFound("Phase", id) => assert_eq!(id, qb.id),
        other => panic!("expected NotFound(\"Phase\"), got {other:?}"),
    }

    // The failed reorder rolled back — positions keep the swapped state.
    let rolled_back: (i64, i64) =
        with_world(&fx, |c| Ok((phase_pos(c, &pa.id)?, phase_pos(c, &pb.id)?)))
            .expect("positions after failed reorder");
    assert_eq!(rolled_back, (1, 0));
}

// 3. delete_character cascades: phases + event_character_refs +
//    scene_character_refs rows for that character all vanish (FK CASCADE);
//    another character's rows survive.
#[test]
fn delete_character_cascades_phases_and_refs() {
    let fx = make_space_with_world();
    let a = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Aria"),
        None,
    )
    .expect("create A");
    let b = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Brin"),
        None,
    )
    .expect("create B");
    let pa = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        &phase_input("a"),
        None,
    )
    .expect("A phase");
    let pb = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &b.id,
        &phase_input("b"),
        None,
    )
    .expect("B phase");

    let (event_id, novel_id, chapter_id, scene_id) = (
        uuid_shape(2000),
        uuid_shape(2001),
        uuid_shape(2002),
        uuid_shape(2003),
    );
    with_world(&fx, |c| {
            seed_event(c, &event_id, "Catalyst")?;
            seed_scene(c, &novel_id, &chapter_id, &scene_id)?;
            c.execute(
                "INSERT INTO event_character_refs (event_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                params![event_id, a.id, pa.id],
            )?;
            c.execute(
                "INSERT INTO scene_character_refs (scene_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                params![scene_id, a.id, pa.id],
            )?;
            c.execute(
                "INSERT INTO event_character_refs (event_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                params![event_id, b.id, pb.id],
            )?;
            c.execute(
                "INSERT INTO scene_character_refs (scene_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                params![scene_id, b.id, pb.id],
            )?;
            Ok(())
        })
        .expect("seed refs");

    do_delete_character(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, None).expect("delete A");

    let counts: (i64, i64, i64, i64, i64, i64, i64) = with_world(&fx, |c| {
        Ok((
            count(c, "SELECT COUNT(*) FROM characters WHERE id = ?1", &a.id)?,
            count(
                c,
                "SELECT COUNT(*) FROM character_phases WHERE character_id = ?1",
                &a.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM event_character_refs WHERE character_id = ?1",
                &a.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM scene_character_refs WHERE character_id = ?1",
                &a.id,
            )?,
            count(c, "SELECT COUNT(*) FROM characters WHERE id = ?1", &b.id)?,
            count(
                c,
                "SELECT COUNT(*) FROM event_character_refs WHERE character_id = ?1",
                &b.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM scene_character_refs WHERE character_id = ?1",
                &b.id,
            )?,
        ))
    })
    .expect("counts after delete");
    assert_eq!(
        counts,
        (0, 0, 0, 0, 1, 1, 1),
        "A's row/phases/refs gone; B untouched"
    );
}

// 4. delete_phase cascades its refs in both junction tables but keeps the
//    character and the sibling phase.
#[test]
fn delete_phase_cascades_refs_but_keeps_character() {
    let fx = make_space_with_world();
    let ch = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Aria"),
        None,
    )
    .expect("create");
    let p1 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ch.id,
        &phase_input("early"),
        None,
    )
    .expect("phase 1");
    let p2 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ch.id,
        &phase_input("late"),
        None,
    )
    .expect("phase 2");

    let (event_id, novel_id, chapter_id, scene_id) = (
        uuid_shape(2010),
        uuid_shape(2011),
        uuid_shape(2012),
        uuid_shape(2013),
    );
    with_world(&fx, |c| {
            seed_event(c, &event_id, "Turning point")?;
            seed_scene(c, &novel_id, &chapter_id, &scene_id)?;
            for phase in [&p1, &p2] {
                c.execute(
                    "INSERT INTO event_character_refs (event_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                    params![event_id, ch.id, phase.id],
                )?;
                c.execute(
                    "INSERT INTO scene_character_refs (scene_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                    params![scene_id, ch.id, phase.id],
                )?;
            }
            Ok(())
        })
        .expect("seed refs");

    do_delete_phase(&fx.mgr, &fx.space_id, &fx.world_id, &p1.id, None).expect("delete phase 1");

    let counts: (i64, i64, i64, i64, i64) = with_world(&fx, |c| {
        Ok((
            count(c, "SELECT COUNT(*) FROM characters WHERE id = ?1", &ch.id)?,
            count(
                c,
                "SELECT COUNT(*) FROM character_phases WHERE id = ?1",
                &p1.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM character_phases WHERE id = ?1",
                &p2.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM event_character_refs WHERE phase_id = ?1",
                &p1.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM scene_character_refs WHERE phase_id = ?1",
                &p1.id,
            )?,
        ))
    })
    .expect("counts after phase delete");
    assert_eq!(
        counts,
        (1, 0, 1, 0, 0),
        "character + sibling phase survive; p1 rows + refs gone"
    );
    let survivors: i64 = with_world(&fx, |c| {
        Ok(count(
            c,
            "SELECT COUNT(*) FROM event_character_refs WHERE phase_id = ?1",
            &p2.id,
        )? + count(
            c,
            "SELECT COUNT(*) FROM scene_character_refs WHERE phase_id = ?1",
            &p2.id,
        )?)
    })
    .expect("survivor refs");
    assert_eq!(survivors, 2, "p2 refs untouched in both tables");
}

// 5. CharacterRef composite PK (ADR-0002): the SAME (event, character,
//    phase) triple twice → ConstraintViolation; the SAME character under
//    a DIFFERENT phase is a distinct set entry and is allowed.
#[test]
fn character_ref_composite_pk_set_semantics() {
    let fx = make_space_with_world();
    let ch = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Aria"),
        None,
    )
    .expect("create");
    let p1 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ch.id,
        &phase_input("early"),
        None,
    )
    .expect("phase 1");
    let p2 = do_add_phase(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ch.id,
        &phase_input("late"),
        None,
    )
    .expect("phase 2");
    let event_id = uuid_shape(2020);

    with_world(&fx, |c| {
            seed_event(c, &event_id, "Catalyst")?;
            let insert_ref = |phase: &str| -> rusqlite::Result<usize> {
                c.execute(
                    "INSERT INTO event_character_refs (event_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
                    params![event_id, ch.id, phase],
                )
            };
            insert_ref(&p1.id).expect("first (event, char, phase) row");
            match insert_ref(&p1.id) {
                Err(rusqlite::Error::SqliteFailure(ref e, _))
                    if e.code == rusqlite::ErrorCode::ConstraintViolation => {}
                Err(other) => panic!("expected constraint violation, got {other:?}"),
                Ok(_) => panic!("duplicate triple must violate the composite PK"),
            }
            insert_ref(&p2.id).expect("same character, different phase is a distinct entry");
            let n: i64 = c.query_row("SELECT COUNT(*) FROM event_character_refs", [], |r| r.get(0))?;
            assert_eq!(n, 2);
            Ok(())
        })
        .expect("composite PK semantics");
}

// 6. Name uniqueness rides the UNIQUE index (idx_characters_name) — no
//    business error variant exists, so duplicates surface as
//    DbError::Sqlite with ErrorCode::ConstraintViolation.
#[test]
fn duplicate_character_name_is_constraint_violation() {
    let fx = make_space_with_world();
    do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Rivka"),
        None,
    )
    .expect("first Rivka");
    let err = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &char_input("Rivka"),
        None,
    )
    .expect_err("second Rivka must violate idx_characters_name");
    assert!(is_unique_violation(&err), "got {err:?}");
}

// 7. update_character is a full replacement: the update SQL sets every
//    content column, so empty optional values in the input RESET the
//    stored columns (verified both via the read-back struct and the raw
//    JSON TEXT). Nonexistent id → NotFound("Character", id).
#[test]
fn update_character_full_replacement_and_missing_id_not_found() {
    let fx = make_space_with_world();
    let created = do_create_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateCharacterInput {
            name: "Sable".into(),
            aliases: vec!["Shadow".into()],
            description: "origin".into(),
            notes: "secret".into(),
            tags: vec!["t1".into()],
        },
        None,
    )
    .expect("create");

    // Vec<String> columns are stored as JSON TEXT — raw round-trip check.
    let raw: (String, String) = with_world(&fx, |c| {
        Ok(c.query_row(
            "SELECT aliases, tags FROM characters WHERE id = ?1",
            params![created.id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?)
    })
    .expect("raw JSON columns");
    assert_eq!(raw, (r#"["Shadow"]"#.to_string(), r#"["t1"]"#.to_string()));

    let updated = do_update_character(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &created.id,
        &UpdateCharacterInput {
            name: "Sable II".into(),
            aliases: vec![],
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("update");
    assert_eq!(updated.name, "Sable II");
    assert!(
        updated.aliases.is_empty(),
        "full replacement resets aliases"
    );
    assert!(updated.tags.is_empty(), "full replacement resets tags");
    assert_eq!(updated.description, "");
    assert_eq!(updated.notes, "");
    let raw_after: String = with_world(&fx, |c| {
        Ok(c.query_row(
            "SELECT aliases FROM characters WHERE id = ?1",
            params![created.id],
            |r| r.get(0),
        )?)
    })
    .expect("raw aliases after update");
    assert_eq!(raw_after, "[]");

    // Nonexistent id → NotFound("Character", <id>) for update AND delete.
    let ghost = uuid_shape(2030);
    let update = UpdateCharacterInput {
        name: "Ghost".into(),
        aliases: vec![],
        description: String::new(),
        notes: String::new(),
        tags: vec![],
    };
    match do_update_character(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, &update, None)
        .expect_err("ghost update")
    {
        DbError::NotFound(entity, id) => {
            assert_eq!(entity, "Character");
            assert_eq!(id, ghost);
        }
        other => panic!("expected NotFound, got {other:?}"),
    }
    match do_delete_character(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, None)
        .expect_err("ghost delete")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Character"),
        other => panic!("expected NotFound, got {other:?}"),
    }
}
