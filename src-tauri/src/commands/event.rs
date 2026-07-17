use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::CharacterRef;
use crate::models::event::{CreateEventInput, Event, UpdateEventInput};
use crate::models::ref_counts::RefCounts;
use crate::util::{new_id, now_iso};

fn load_event(conn: &mut rusqlite::Connection, id: &str, world_id: &str) -> Result<Event, DbError> {
    let (name, description, start_at, end_at, location_id, notes, tags_json, created_at, updated_at) =
        conn.query_row(
            "SELECT name, description, start_at, end_at, location_id, notes, tags, created_at, updated_at
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
    })
}

#[tauri::command]
pub fn create_event(
    space_id: String,
    world_id: String,
    input: CreateEventInput,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    let event_id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&space_id, &world_id, |conn| {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO events (id, name, description, start_at, end_at, location_id, notes, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            event_id,
            input.name,
            input.description,
            input.start_at,
            input.end_at,
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
    load_event(conn, &event_id, &world_id)
})
}

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
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, description, start_at, end_at, location_id, notes, tags, created_at, updated_at
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
            }
        })
        .collect();

    Ok(result)
})
}

#[tauri::command]
pub fn update_event(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateEventInput,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&space_id, &world_id, |conn| {
    let tx = conn.transaction()?;
    let updated = tx.execute(
        "UPDATE events
         SET name = ?1, description = ?2, start_at = ?3, end_at = ?4, location_id = ?5, notes = ?6, tags = ?7, updated_at = ?8
         WHERE id = ?9",
        params![
            input.name,
            input.description,
            input.start_at,
            input.end_at,
            input.location_id,
            input.notes,
            tags_json,
            now,
            id,
        ],
    )?;
    if updated == 0 {
        return Err(DbError::NotFound("Event", id));
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
    load_event(conn, &id, &world_id)
})
}

#[tauri::command]
pub fn delete_event(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM events WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Event", id));
        }
        Ok(())
    })
}

// ─── Reference counting ─────────────────────────────────────────────────────
//
// These power the pre-delete impact disclosure (ADR-0006): before deleting a
// phase or character we surface how many Events / Scenes reference it, so the
// user understands the cascade before confirming. Scene counts are 0 until
// Slice 4 ships Scene UI — the `scene_character_refs` table already exists.

/// Count how many Events and Scenes reference a single phase.
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
