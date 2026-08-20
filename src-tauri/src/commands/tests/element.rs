use super::*;
use crate::testutil::{make_space_with_world, uuid_shape, with_world};

/// Timestamp for raw-SQL parent rows (only NOT NULL columns need values).
const T: &str = "2026-01-01T00:00:00.000Z";

fn tags(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn count(c: &rusqlite::Connection, sql: &str, arg: &str) -> rusqlite::Result<i64> {
    c.query_row(sql, params![arg], |r| r.get(0))
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

fn raw_tags(c: &rusqlite::Connection, table: &str, id: &str) -> rusqlite::Result<String> {
    c.query_row(
        &format!("SELECT tags FROM {table} WHERE id = ?1"),
        params![id],
        |r| r.get(0),
    )
}

// 1. CRUD round-trip per entity kind — tags stored as JSON TEXT
//    round-trip exactly, and update is a full replacement.
#[test]
fn location_crud_round_trip() {
    let fx = make_space_with_world();
    let created = do_create_location(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLocationInput {
            name: "Tavern".into(),
            description: "d1".into(),
            notes: "n1".into(),
            tags: tags(&["a", "b"]),
        },
        None,
    )
    .expect("create");
    assert_eq!(created.name, "Tavern");
    assert_eq!(created.tags, tags(&["a", "b"]));
    let raw = with_world(&fx, |c| Ok(raw_tags(c, "locations", &created.id)?)).expect("raw tags");
    assert_eq!(raw, r#"["a","b"]"#);

    let updated = do_update_location(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &created.id,
        &UpdateLocationInput {
            name: "Inn".into(),
            description: "d2".into(),
            notes: String::new(),
            tags: tags(&["c"]),
        },
        None,
    )
    .expect("update");
    assert_eq!(updated.name, "Inn");
    assert_eq!(updated.description, "d2");
    assert_eq!(updated.notes, "");
    assert_eq!(updated.tags, tags(&["c"]));
    let raw_after = with_world(&fx, |c| Ok(raw_tags(c, "locations", &created.id)?))
        .expect("raw tags after update");
    assert_eq!(raw_after, r#"["c"]"#);
}

#[test]
fn item_crud_round_trip() {
    let fx = make_space_with_world();
    let created = do_create_item(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateItemInput {
            name: "Sword".into(),
            description: "d1".into(),
            notes: String::new(),
            tags: tags(&["a", "b"]),
        },
        None,
    )
    .expect("create");
    assert_eq!(created.tags, tags(&["a", "b"]));
    let raw = with_world(&fx, |c| Ok(raw_tags(c, "items", &created.id)?)).expect("raw tags");
    assert_eq!(raw, r#"["a","b"]"#);

    let updated = do_update_item(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &created.id,
        &UpdateItemInput {
            name: "Blade".into(),
            description: "d2".into(),
            notes: "n2".into(),
            tags: vec![],
        },
        None,
    )
    .expect("update");
    assert_eq!(updated.name, "Blade");
    assert!(updated.tags.is_empty(), "full replacement resets tags");
    let raw_after =
        with_world(&fx, |c| Ok(raw_tags(c, "items", &created.id)?)).expect("raw tags after update");
    assert_eq!(raw_after, "[]");
}

#[test]
fn lore_crud_round_trip() {
    let fx = make_space_with_world();
    let created = do_create_lore(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLoreInput {
            name: "The Pact".into(),
            description: "d1".into(),
            notes: String::new(),
            tags: tags(&["a", "b"]),
        },
        None,
    )
    .expect("create");
    assert_eq!(created.tags, tags(&["a", "b"]));
    let raw = with_world(&fx, |c| Ok(raw_tags(c, "lores", &created.id)?)).expect("raw tags");
    assert_eq!(raw, r#"["a","b"]"#);

    let updated = do_update_lore(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &created.id,
        &UpdateLoreInput {
            name: "The Oath".into(),
            description: "d2".into(),
            notes: String::new(),
            tags: tags(&["z"]),
        },
        None,
    )
    .expect("update");
    assert_eq!(updated.name, "The Oath");
    assert_eq!(updated.tags, tags(&["z"]));
    let raw_after =
        with_world(&fx, |c| Ok(raw_tags(c, "lores", &created.id)?)).expect("raw tags after update");
    assert_eq!(raw_after, r#"["z"]"#);
}

// 2a. delete_item cascades scene_item_refs (FK CASCADE); other items'
//     refs survive.
#[test]
fn delete_item_cascades_scene_item_refs() {
    let fx = make_space_with_world();
    let item = do_create_item(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateItemInput {
            name: "Sword".into(),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("create item");
    let other = do_create_item(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateItemInput {
            name: "Shield".into(),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("create other");

    let (s1, s2) = (uuid_shape(3000), uuid_shape(3001));
    with_world(&fx, |c| {
        seed_scene(c, &uuid_shape(3002), &uuid_shape(3003), &s1)?;
        seed_scene(c, &uuid_shape(3004), &uuid_shape(3005), &s2)?;
        c.execute(
            "INSERT INTO scene_item_refs (scene_id, item_id) VALUES (?1, ?2)",
            params![s1, item.id],
        )?;
        c.execute(
            "INSERT INTO scene_item_refs (scene_id, item_id) VALUES (?1, ?2)",
            params![s2, item.id],
        )?;
        c.execute(
            "INSERT INTO scene_item_refs (scene_id, item_id) VALUES (?1, ?2)",
            params![s1, other.id],
        )?;
        Ok(())
    })
    .expect("seed refs");

    let before: (i64, i64) = with_world(&fx, |c| {
        Ok((
            count(
                c,
                "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1",
                &item.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1",
                &other.id,
            )?,
        ))
    })
    .expect("counts before");
    assert_eq!(before, (2, 1));

    do_delete_item(&fx.mgr, &fx.space_id, &fx.world_id, &item.id, None).expect("delete item");

    let after: (i64, i64) = with_world(&fx, |c| {
        Ok((
            count(
                c,
                "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1",
                &item.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1",
                &other.id,
            )?,
        ))
    })
    .expect("counts after");
    assert_eq!(after, (0, 1));
}

// 2b. delete_lore cascades scene_lore_refs (WORLD_MIGRATION_012).
#[test]
fn delete_lore_cascades_scene_lore_refs() {
    let fx = make_space_with_world();
    let lore = do_create_lore(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLoreInput {
            name: "The Pact".into(),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("create lore");
    let other = do_create_lore(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLoreInput {
            name: "The Curse".into(),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("create other");

    let (s1, s2) = (uuid_shape(3010), uuid_shape(3011));
    with_world(&fx, |c| {
        seed_scene(c, &uuid_shape(3012), &uuid_shape(3013), &s1)?;
        seed_scene(c, &uuid_shape(3014), &uuid_shape(3015), &s2)?;
        c.execute(
            "INSERT INTO scene_lore_refs (scene_id, lore_id) VALUES (?1, ?2)",
            params![s1, lore.id],
        )?;
        c.execute(
            "INSERT INTO scene_lore_refs (scene_id, lore_id) VALUES (?1, ?2)",
            params![s2, lore.id],
        )?;
        c.execute(
            "INSERT INTO scene_lore_refs (scene_id, lore_id) VALUES (?1, ?2)",
            params![s1, other.id],
        )?;
        Ok(())
    })
    .expect("seed refs");

    do_delete_lore(&fx.mgr, &fx.space_id, &fx.world_id, &lore.id, None).expect("delete lore");

    let after: (i64, i64) = with_world(&fx, |c| {
        Ok((
            count(
                c,
                "SELECT COUNT(*) FROM scene_lore_refs WHERE lore_id = ?1",
                &lore.id,
            )?,
            count(
                c,
                "SELECT COUNT(*) FROM scene_lore_refs WHERE lore_id = ?1",
                &other.id,
            )?,
        ))
    })
    .expect("counts after");
    assert_eq!(after, (0, 1));
}

// 3. delete_location does NOT cascade — scenes.location_id and
//    events.location_id become NULL (ON DELETE SET NULL) and the rows
//    themselves survive.
#[test]
fn delete_location_nulls_scene_and_event_fk() {
    let fx = make_space_with_world();
    let loc = do_create_location(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLocationInput {
            name: "Citadel".into(),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("create location");

    let (event_id, scene_id) = (uuid_shape(3020), uuid_shape(3021));
    with_world(&fx, |c| {
        c.execute(
            "INSERT INTO events (id, name, location_id, created_at, updated_at)
                 VALUES (?1, 'Siege', ?2, ?3, ?3)",
            params![event_id, loc.id, T],
        )?;
        seed_scene(c, &uuid_shape(3022), &uuid_shape(3023), &scene_id)?;
        c.execute(
            "UPDATE scenes SET location_id = ?1 WHERE id = ?2",
            params![loc.id, scene_id],
        )?;
        Ok(())
    })
    .expect("seed event + scene");

    do_delete_location(&fx.mgr, &fx.space_id, &fx.world_id, &loc.id, None)
        .expect("delete location");

    let fks: (Option<String>, Option<String>) = with_world(&fx, |c| {
        Ok((
            c.query_row(
                "SELECT location_id FROM events WHERE id = ?1",
                params![event_id],
                |r| r.get(0),
            )?,
            c.query_row(
                "SELECT location_id FROM scenes WHERE id = ?1",
                params![scene_id],
                |r| r.get(0),
            )?,
        ))
    })
    .expect("fk read");
    assert_eq!(fks, (None, None), "ON DELETE SET NULL for both FKs");
}

// 4. Name uniqueness is enforced per entity kind via the UNIQUE indexes
//    (idx_locations_name / idx_items_name / idx_lores_name) — duplicates
//    surface as DbError::Sqlite ConstraintViolation (no business variant
//    exists). The same name across DIFFERENT kinds is allowed.
#[test]
fn duplicate_names_are_constraint_violations_per_kind() {
    let fx = make_space_with_world();
    let mk = |name: &str| name.into();

    do_create_location(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLocationInput {
            name: mk("Dup"),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("first location");
    let e = do_create_location(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLocationInput {
            name: mk("Dup"),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect_err("duplicate location name");
    assert!(is_unique_violation(&e), "got {e:?}");

    do_create_item(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateItemInput {
            name: mk("Dup"),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("first item (same name as a location is fine)");
    let e = do_create_item(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateItemInput {
            name: mk("Dup"),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect_err("duplicate item name");
    assert!(is_unique_violation(&e), "got {e:?}");

    do_create_lore(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLoreInput {
            name: mk("Dup"),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect("first lore (same name as other kinds is fine)");
    let e = do_create_lore(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &CreateLoreInput {
            name: mk("Dup"),
            description: String::new(),
            notes: String::new(),
            tags: vec![],
        },
        None,
    )
    .expect_err("duplicate lore name");
    assert!(is_unique_violation(&e), "got {e:?}");
}

// 5. Nonexistent id → NotFound with the right entity label, for both
//    update and delete, for each kind.
#[test]
fn missing_id_update_delete_not_found_per_kind() {
    let fx = make_space_with_world();
    let ghost = uuid_shape(3999);

    let u_loc = UpdateLocationInput {
        name: "X".into(),
        description: String::new(),
        notes: String::new(),
        tags: vec![],
    };
    match do_update_location(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, &u_loc, None)
        .expect_err("ghost location update")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Location"),
        other => panic!("expected NotFound, got {other:?}"),
    }
    match do_delete_location(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, None)
        .expect_err("ghost location delete")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Location"),
        other => panic!("expected NotFound, got {other:?}"),
    }

    let u_item = UpdateItemInput {
        name: "X".into(),
        description: String::new(),
        notes: String::new(),
        tags: vec![],
    };
    match do_update_item(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, &u_item, None)
        .expect_err("ghost item update")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Item"),
        other => panic!("expected NotFound, got {other:?}"),
    }
    match do_delete_item(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, None)
        .expect_err("ghost item delete")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Item"),
        other => panic!("expected NotFound, got {other:?}"),
    }

    let u_lore = UpdateLoreInput {
        name: "X".into(),
        description: String::new(),
        notes: String::new(),
        tags: vec![],
    };
    match do_update_lore(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, &u_lore, None)
        .expect_err("ghost lore update")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Lore"),
        other => panic!("expected NotFound, got {other:?}"),
    }
    match do_delete_lore(&fx.mgr, &fx.space_id, &fx.world_id, &ghost, None)
        .expect_err("ghost lore delete")
    {
        DbError::NotFound(entity, _) => assert_eq!(entity, "Lore"),
        other => panic!("expected NotFound, got {other:?}"),
    }
}
