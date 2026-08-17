use rusqlite::params;
use std::collections::HashMap;
use tauri::{AppHandle, State};

use crate::commands::events::emit_entity_changed;
use crate::db::{DbError, DbManager};
use crate::models::character::CharacterRef;
use crate::models::event::{CreateEventInput, Event, UpdateEventInput};
use crate::models::ref_counts::RefCounts;
use crate::util::{decode_and_validate_image, new_id, normalize_iso, now_iso};

fn load_event(conn: &mut rusqlite::Connection, id: &str, world_id: &str) -> Result<Event, DbError> {
    let (name, description, start_at, end_at, location_id, notes, tags_json, created_at, updated_at, has_image) =
        conn.query_row(
            "SELECT name, description, start_at, end_at, location_id, notes, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image
             FROM events WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>("name")?,
                    row.get::<_, String>("description")?,
                    row.get::<_, Option<String>>("start_at")?,
                    row.get::<_, Option<String>>("end_at")?,
                    row.get::<_, Option<String>>("location_id")?,
                    row.get::<_, String>("notes")?,
                    row.get::<_, String>("tags")?,
                    row.get::<_, String>("created_at")?,
                    row.get::<_, String>("updated_at")?,
                    row.get::<_, bool>("has_image")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Event", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

    let refs = conn
        .prepare("SELECT character_id, phase_id FROM event_character_refs WHERE event_id = ?1")?
        .query_map(params![id], |row| {
            Ok(CharacterRef {
                character_id: row.get("character_id")?,
                phase_id: row.get("phase_id")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Event {
        id: id.to_string(),
        world_id: world_id.to_string(),
        name,
        description,
        start_at,
        end_at,
        character_refs: refs,
        location_id,
        notes,
        tags,
        created_at,
        updated_at,
        has_image,
    })
}

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_event(
    space_id: String,
    world_id: String,
    input: CreateEventInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Event, DbError> {
    let event = do_create_event(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", event.id.as_str());
    Ok(event)
}

/// Testable core of [`create_event`] (the `do_*` convention — see
/// `commands/space.rs::do_delete_space`): `app` is `None` only in unit
/// tests that bypass the Tauri runtime.
pub(crate) fn do_create_event(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateEventInput,
    app: Option<&AppHandle>,
) -> Result<Event, DbError> {
    let event_id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    let result = mgr.with_world(space_id, world_id, |conn| {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO events (id, name, description, start_at, end_at, location_id, notes, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            event_id,
            input.name,
            input.description,
            start_at,
            end_at,
            input.location_id,
            input.notes,
            tags_json,
            now,
            now,
        ],
    )?;
    for r in &input.character_refs {
        tx.execute(
            "INSERT INTO event_character_refs (event_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
            params![event_id, r.character_id, r.phase_id],
        )?;
    }
    tx.commit()?;
    load_event(conn, &event_id, world_id)
});
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "event",
                Some(entity.id.clone()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_event(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_event(conn, &id, &world_id)
    })
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_events(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Event>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
    // (a) Batch-load ALL event rows (raw fields, no refs yet).
    struct EventRaw {
        id: String,
        name: String,
        description: String,
        start_at: Option<String>,
        end_at: Option<String>,
        location_id: Option<String>,
        notes: String,
        tags_json: String,
        created_at: String,
        updated_at: String,
        has_image: bool,
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, description, start_at, end_at, location_id, notes, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image
         FROM events ORDER BY created_at",
    )?;
    let raws: Vec<EventRaw> = stmt
        .query_map([], |row| {
            Ok(EventRaw {
                id: row.get("id")?,
                name: row.get("name")?,
                description: row.get("description")?,
                start_at: row.get("start_at")?,
                end_at: row.get("end_at")?,
                location_id: row.get("location_id")?,
                notes: row.get("notes")?,
                tags_json: row.get("tags")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                has_image: row.get("has_image")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (b) Zero-events short-circuit: skip the refs query entirely so we
    // never emit an empty `IN ()` clause.
    if raws.is_empty() {
        return Ok(Vec::new());
    }

    // (c) Batch-load ALL character refs for these events in one query.
    let ids: Vec<String> = raws.iter().map(|r| r.id.clone()).collect();
    let placeholders = (1..=ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT event_id, character_id, phase_id FROM event_character_refs WHERE event_id IN ({placeholders})"
    );
    let mut ref_stmt = conn.prepare(&sql)?;
    let all_refs: Vec<(String, CharacterRef)> = ref_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            let event_id: String = row.get("event_id")?;
            let character_id: String = row.get("character_id")?;
            let phase_id: String = row.get("phase_id")?;
            Ok((event_id, CharacterRef { character_id, phase_id }))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (d) Group refs by event_id.
    let mut ref_map: HashMap<String, Vec<CharacterRef>> = HashMap::new();
    for (event_id, r) in all_refs {
        ref_map.entry(event_id).or_default().push(r);
    }

    // (e) Assemble results.
    let result: Vec<Event> = raws
        .into_iter()
        .map(|raw| {
            let character_refs = ref_map.remove(&raw.id).unwrap_or_default();
            let tags: Vec<String> = serde_json::from_str(&raw.tags_json).unwrap_or_default();
            Event {
                id: raw.id,
                world_id: world_id.to_string(),
                name: raw.name,
                description: raw.description,
                start_at: raw.start_at,
                end_at: raw.end_at,
                character_refs,
                location_id: raw.location_id,
                notes: raw.notes,
                tags,
                created_at: raw.created_at,
                updated_at: raw.updated_at,
                has_image: raw.has_image,
            }
        })
        .collect();

    Ok(result)
})
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_event(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateEventInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Event, DbError> {
    do_update_event(&state, &space_id, &world_id, &id, &input, Some(&app))
}

/// Testable core of [`update_event`] (the `do_*` convention). Full
/// replacement including the `event_character_refs` junction (delete-all +
/// re-insert in one transaction — ADR-0002 set semantics).
pub(crate) fn do_update_event(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateEventInput,
    app: Option<&AppHandle>,
) -> Result<Event, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    let result = mgr.with_world(space_id, world_id, |conn| {
    let tx = conn.transaction()?;
    let updated = tx.execute(
        "UPDATE events
         SET name = ?1, description = ?2, start_at = ?3, end_at = ?4, location_id = ?5, notes = ?6, tags = ?7, updated_at = ?8
         WHERE id = ?9",
        params![
            input.name,
            input.description,
            start_at,
            end_at,
            input.location_id,
            input.notes,
            tags_json,
            now,
            id,
        ],
    )?;
    if updated == 0 {
        return Err(DbError::NotFound("Event", id.to_string()));
    }
    tx.execute(
        "DELETE FROM event_character_refs WHERE event_id = ?1",
        params![id],
    )?;
    for r in &input.character_refs {
        tx.execute(
            "INSERT INTO event_character_refs (event_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
            params![id, r.character_id, r.phase_id],
        )?;
    }
    tx.commit()?;
    load_event(conn, id, world_id)
});
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "event",
                Some(entity.id.clone()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_event(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_event(&state, &space_id, &world_id, &id, Some(&app))
}

/// Testable core of [`delete_event`] (the `do_*` convention). The FK
/// cascades do the structural cleanup: `event_character_refs` rows vanish
/// (ON DELETE CASCADE) and `character_phases.trigger_event_id` is nulled
/// (ON DELETE SET NULL — ADR-0003).
pub(crate) fn do_delete_event(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM events WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Event", id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(app, "event", Some(id.to_string()), space_id, Some(world_id));
        }
    }
    result
}

// ─── Reference counting ─────────────────────────────────────────────────────
//
// These power the pre-delete impact disclosure (ADR-0006): before deleting a
// phase or character we surface how many Events / Scenes reference it, so the
// user understands the cascade before confirming. Scene counts are 0 until
// Slice 4 ships Scene UI — the `scene_character_refs` table already exists.

/// Count how many Events and Scenes reference a single phase.
#[tracing::instrument(skip(state, phase_id), fields(entity_id = %phase_id))]
#[tauri::command]
pub fn count_phase_refs(
    space_id: String,
    world_id: String,
    phase_id: String,
    state: State<'_, DbManager>,
) -> Result<RefCounts, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let (events, scenes): (i64, i64) = conn.query_row(
            "SELECT
            (SELECT COUNT(*) FROM event_character_refs WHERE phase_id = ?1),
            (SELECT COUNT(*) FROM scene_character_refs WHERE phase_id = ?1)",
            params![phase_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(RefCounts {
            events: events as u64,
            scenes: scenes as u64,
        })
    })
}

/// Count how many Events and Scenes reference ANY phase of the given character
/// (aggregates across all of the character's phases).
#[tracing::instrument(skip(state, character_id), fields(entity_id = %character_id))]
#[tauri::command]
pub fn count_character_refs(
    space_id: String,
    world_id: String,
    character_id: String,
    state: State<'_, DbManager>,
) -> Result<RefCounts, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        // COUNT(DISTINCT …) because a character may appear in the same event/scene
        // at multiple phases — we want the number of distinct entities, not rows.
        let (events, scenes): (i64, i64) = conn.query_row(
            "SELECT
            (SELECT COUNT(DISTINCT event_id) FROM event_character_refs
                WHERE phase_id IN (SELECT id FROM character_phases WHERE character_id = ?1)),
            (SELECT COUNT(DISTINCT scene_id) FROM scene_character_refs
                WHERE phase_id IN (SELECT id FROM character_phases WHERE character_id = ?1))",
            params![character_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(RefCounts {
            events: events as u64,
            scenes: scenes as u64,
        })
    })
}

// ─── Per-entity image commands (Event) ──────────────────────────────────────
//
// The `image_blob` / `image_mime` columns on the `events` table are added by
// `WORLD_MIGRATION_006`. Image bytes flow ONLY through these dedicated
// commands — the `Event` struct and `list_events` / `get_event` queries never
// touch the columns (avoids a serde Vec<u8> → JSON-number-array encoding trap
// and keeps list payloads light).
//
// Logging (ADR-0014 / ADR-0016): only metadata (entity_id, byte length, mime)
// is ever logged — the bytes themselves are creative content. update + clear
// are INFO; get is DEBUG because it fires on every event card render.

#[tracing::instrument(
    skip(state, image_base64, app),
    fields(entity_id = %id)
)]
#[tauri::command]
pub fn update_event_image(
    space_id: String,
    world_id: String,
    id: String,
    image_base64: String,
    image_mime: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    let bytes = decode_and_validate_image(&image_base64, &image_mime)?;
    let now = now_iso();
    tracing::info!(
        entity_id = %id,
        image_bytes_len = bytes.len(),
        image_mime = %image_mime,
        "image updated"
    );
    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE events SET image_blob = ?1, image_mime = ?2, updated_at = ?3 WHERE id = ?4",
            params![&bytes, &image_mime, now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Event", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "event",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn clear_event_image(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    let now = now_iso();
    tracing::info!(entity_id = %id, "image cleared");
    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE events SET image_blob = NULL, image_mime = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Event", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "event",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_event_image(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<tauri::ipc::Response, DbError> {
    tracing::debug!(entity_id = %id, "image fetched");
    let bytes: Option<Vec<u8>> = state.with_world(&space_id, &world_id, |conn| {
        conn.query_row(
            "SELECT image_blob FROM events WHERE id = ?1",
            params![&id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Image", id.clone()),
            other => DbError::Sqlite(other),
        })
    })?;
    let bytes = bytes.ok_or_else(|| DbError::NotFound("Image", id))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{make_space_with_world, uuid_shape, with_world, WorldFixture};

    const NOW: &str = "2026-01-01T00:00:00.000Z";

    /// Insert a character + one phase via raw SQL (NOT NULL columns only;
    /// the rest carry defaults). Returns `(character_id, phase_id)`.
    /// `trigger_event_id` optionally wires the phase to an event (ADR-0003).
    fn seed_character(
        fx: &WorldFixture,
        n: u64,
        trigger_event_id: Option<&str>,
    ) -> (String, String) {
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
            &create_input(
                "Festival",
                vec![r(&c1, &p1), r(&c2, &p2)],
            ),
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
        assert_eq!(count(&fx, "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1", &ev.id), 1);

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
            count(&fx, "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1", &ev.id),
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
            count(&fx, "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1", &ev.id),
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
            Ok(conn
                .query_row("SELECT COUNT(*) FROM event_character_refs", [], |row| row.get(0))?)
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

        do_delete_event(&fx.mgr, &fx.space_id, &fx.world_id, &ev.id, None)
            .expect("delete event");

        // Event row + junction rows gone.
        assert_eq!(
            count(&fx, "SELECT COUNT(*) FROM events WHERE id = ?1", &ev.id),
            0
        );
        assert_eq!(
            count(&fx, "SELECT COUNT(*) FROM event_character_refs WHERE event_id = ?1", &ev.id),
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

        let ev = do_create_event(&fx.mgr, &fx.space_id, &fx.world_id, &input, None)
            .expect("create event");
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
}
