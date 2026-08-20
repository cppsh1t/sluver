use super::*;
use crate::testutil::{make_space_with_world, uuid_shape, with_world, WorldFixture};

const NOW: &str = "2026-01-01T00:00:00.000Z";

/// Insert a character + one phase via raw SQL (NOT NULL columns only;
/// the rest carry defaults). Returns `(character_id, phase_id)`.
/// `trigger_event_id` optionally wires the phase to an event (ADR-0003).
fn seed_character(fx: &WorldFixture, n: u64, trigger_event_id: Option<&str>) -> (String, String) {
    let cid = uuid_shape(n);
    let pid = uuid_shape(n + 5000);
    with_world(fx, |conn| {
            conn.execute(
                "INSERT INTO characters (id, name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![cid, format!("Char {n}"), NOW],
            )?;
            conn.execute(
                "INSERT INTO character_phases (id, character_id, trigger_event_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![pid, cid, trigger_event_id, NOW],
            )?;
            Ok(())
        })
        .expect("seed character");
    (cid, pid)
}

fn r(character_id: &str, phase_id: &str) -> CharacterRef {
    CharacterRef {
        character_id: character_id.to_string(),
        phase_id: phase_id.to_string(),
    }
}

fn create_input(name: &str, refs: Vec<CharacterRef>) -> CreateEventInput {
    CreateEventInput {
        name: name.to_string(),
        description: String::new(),
        start_at: None,
        end_at: None,
        character_refs: refs,
        location_id: None,
        notes: String::new(),
        tags: Vec::new(),
    }
}

fn update_input(name: &str, refs: Vec<CharacterRef>) -> UpdateEventInput {
    UpdateEventInput {
        name: name.to_string(),
        description: String::new(),
        start_at: None,
        end_at: None,
        character_refs: refs,
        location_id: None,
        notes: String::new(),
        tags: Vec::new(),
    }
}

/// Assert a `DbError` is a raw SQLite constraint violation (the
/// codebase's deliberate stance: no DuplicateName-style business
/// variant for events).
fn assert_constraint_violation(err: DbError) {
    assert!(
        matches!(
            &err,
            DbError::Sqlite(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation
        ),
        "expected SQLite ConstraintViolation, got {err:?}"
    );
}

fn count(fx: &WorldFixture, sql: &str, id: &str) -> i64 {
    with_world(fx, |conn| {
        Ok(conn.query_row(sql, params![id], |row| row.get(0))?)
    })
    .expect("count query")
}

/// Event + junction rows land together in one transaction (task B1).
#[test]
fn create_event_inserts_event_and_refs_in_one_tx() {
    let fx = make_space_with_world();
    let (c1, p1) = seed_character(&fx, 1, None);
    let (c2, p2) = seed_character(&fx, 2, None);

    let ev = do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("Festival", vec![r(&c1, &p1), r(&c2, &p2)]),
        None,
    )
    .expect("create event");

    assert_eq!(ev.name, "Festival");
    assert_eq!(ev.character_refs.len(), 2);

    let rows: Vec<(String, String, String)> = with_world(&fx, |conn| {
        let mut stmt = conn.prepare(
            "SELECT event_id, character_id, phase_id FROM event_character_refs
                 WHERE event_id = ?1 ORDER BY character_id",
        )?;
        let rows = stmt
            .query_map(params![ev.id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("read refs");
    assert_eq!(rows.len(), 2, "both ref rows must exist");
    assert_eq!(rows[0], (ev.id.clone(), c1, p1));
    assert_eq!(rows[1], (ev.id.clone(), c2, p2));
}

/// update_event is a full replacement: old junction rows gone, new
/// ones present (task B2).
#[test]
fn update_event_fully_replaces_refs() {
    let fx = make_space_with_world();
    let (c1, p1) = seed_character(&fx, 1, None);
    let (c2, p2) = seed_character(&fx, 2, None);
    let ev = do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("War", vec![r(&c1, &p1)]),
        None,
    )
    .expect("create event");
    assert_eq!(
        count(
            &fx,
            "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1",
            &ev.id
        ),
        1
    );

    let updated = do_update_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ev.id,
        &update_input("War", vec![r(&c2, &p2)]),
        None,
    )
    .expect("update event");

    assert_eq!(updated.character_refs.len(), 1);
    assert_eq!(updated.character_refs[0].character_id, c2);
    assert_eq!(updated.character_refs[0].phase_id, p2);
    let old_gone: i64 = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1 AND character_id = ?2",
            params![ev.id, c1],
            |row| row.get(0),
        )?)
    })
    .expect("old ref count");
    assert_eq!(old_gone, 0, "old ref must be deleted");
    assert_eq!(
        count(
            &fx,
            "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1",
            &ev.id
        ),
        1,
        "exactly the new ref remains"
    );
}

/// A bad ref (nonexistent character_id → FK violation) rolls back the
/// WHOLE update transaction: the name UPDATE and the refs DELETE are
/// both undone (task B3).
#[test]
fn update_event_atomic_rollback_on_unknown_character() {
    let fx = make_space_with_world();
    let (c1, p1) = seed_character(&fx, 1, None);
    let ev = do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("Original", vec![r(&c1, &p1)]),
        None,
    )
    .expect("create event");

    let err = do_update_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &ev.id,
        &update_input("Changed", vec![r("no-such-character", "no-such-phase")]),
        None,
    )
    .expect_err("FK violation must reject the update");
    assert_constraint_violation(err);

    // The name UPDATE was rolled back too.
    let name: String = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT name FROM events WHERE id = ?1",
            params![ev.id],
            |row| row.get(0),
        )?)
    })
    .expect("read name");
    assert_eq!(name, "Original", "tx rollback must restore the name");

    // The old ref row survived the rolled-back DELETE + re-INSERT.
    assert_eq!(
        count(
            &fx,
            "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1",
            &ev.id
        ),
        1,
        "old refs must be intact after rollback"
    );
    let still_there: i64 = with_world(&fx, |conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1 AND character_id = ?2 AND phase_id = ?3",
                params![ev.id, c1, p1],
                |row| row.get(0),
            )?)
        })
        .expect("ref row check");
    assert_eq!(still_there, 1);
}

/// Composite PK (event_id, character_id, phase_id) = set semantics
/// (ADR-0002): a duplicate pair in one input rejects the whole create
/// transaction — no event row survives (task B4).
#[test]
fn create_event_duplicate_ref_pair_rejected_and_rolled_back() {
    let fx = make_space_with_world();
    let (c1, p1) = seed_character(&fx, 1, None);

    let err = do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("Dupe", vec![r(&c1, &p1), r(&c1, &p1)]),
        None,
    )
    .expect_err("duplicate (event, character, phase) pair must reject");
    assert_constraint_violation(err);

    let events: i64 = with_world(&fx, |conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?)
    })
    .expect("count events");
    assert_eq!(events, 0, "the whole create tx must roll back");
    let refs: i64 = with_world(&fx, |conn| {
        Ok(
            conn.query_row("SELECT COUNT(*) FROM event_character_refs", [], |row| {
                row.get(0)
            })?,
        )
    })
    .expect("count refs");
    assert_eq!(refs, 0);
}

/// Deleting an event cascades the junction rows away and SETs NULL the
/// `character_phases.trigger_event_id` that pointed at it (ADR-0003 —
/// the trigger link is independent of the refs junction).
#[test]
fn delete_event_cascades_refs_and_nulls_trigger_event_id() {
    let fx = make_space_with_world();
    let ev = do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("Catalyst", vec![]),
        None,
    )
    .expect("create event");
    let (c1, p1) = seed_character(&fx, 1, Some(&ev.id));
    with_world(&fx, |conn| {
        conn.execute(
            "INSERT INTO event_character_refs (event_id, character_id, phase_id)
                 VALUES (?1, ?2, ?3)",
            params![ev.id, c1, p1],
        )?;
        Ok(())
    })
    .expect("link ref");

    do_delete_event(&fx.mgr, &fx.space_id, &fx.world_id, &ev.id, None).expect("delete event");

    // Event row + junction rows gone.
    assert_eq!(
        count(&fx, "SELECT COUNT(*) FROM events WHERE id = ?1", &ev.id),
        0
    );
    assert_eq!(
        count(
            &fx,
            "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1",
            &ev.id
        ),
        0
    );

    // The phase survives with trigger_event_id NULLed (ON DELETE SET NULL).
    let trigger: Option<String> = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT trigger_event_id FROM character_phases WHERE id = ?1",
            params![p1],
            |row| row.get(0),
        )?)
    })
    .expect("read trigger_event_id");
    assert_eq!(trigger, None, "trigger_event_id must be SET NULL");
}

/// `normalize_iso` drops garbage timestamps to NULL and canonicalizes
/// valid RFC 3339 input to UTC-ms-`Z` (task B6 — assert the actual
/// stored values).
#[test]
fn create_event_normalizes_timestamps() {
    let fx = make_space_with_world();
    let mut input = create_input("Timeline", vec![]);
    input.start_at = Some("long ago".to_string()); // garbage → NULL
    input.end_at = Some("2024-05-01T10:00:00+08:00".to_string()); // valid → UTC

    let ev =
        do_create_event(&fx.mgr, &fx.space_id, &fx.world_id, &input, None).expect("create event");
    assert_eq!(ev.start_at, None);
    assert_eq!(ev.end_at.as_deref(), Some("2024-05-01T02:00:00.000Z"));

    let stored: (Option<String>, Option<String>) = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT start_at, end_at FROM events WHERE id = ?1",
            params![ev.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })
    .expect("read timestamps");
    assert_eq!(stored.0, None, "garbage start_at must be stored as NULL");
    assert_eq!(
        stored.1.as_deref(),
        Some("2024-05-01T02:00:00.000Z"),
        "valid end_at must be canonicalized to UTC ms"
    );

    // A valid start passes through canonicalized as well.
    let mut ok_input = create_input("Timeline 2", vec![]);
    ok_input.start_at = Some("2025-03-05T00:30:00Z".to_string());
    let ev2 = do_create_event(&fx.mgr, &fx.space_id, &fx.world_id, &ok_input, None)
        .expect("create second event");
    assert_eq!(ev2.start_at.as_deref(), Some("2025-03-05T00:30:00.000Z"));
}

/// Duplicate event names surface as a raw SQLite constraint violation
/// on `idx_events_name` — deliberately NOT a business variant.
#[test]
fn create_event_duplicate_name_is_raw_sqlite_violation() {
    let fx = make_space_with_world();
    do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("Echo", vec![]),
        None,
    )
    .expect("first create");
    let err = do_create_event(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &create_input("Echo", vec![]),
        None,
    )
    .expect_err("duplicate name must violate idx_events_name");
    assert_constraint_violation(err);

    let events: i64 = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM events WHERE name = 'Echo'",
            [],
            |row| row.get(0),
        )?)
    })
    .expect("count events");
    assert_eq!(events, 1, "second insert must be rolled back");
}
