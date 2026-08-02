use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::CharacterRef;
use crate::models::event::{CreateEventInput, Event, UpdateEventInput};
use crate::models::ref_counts::RefCounts;
use crate::util::{decode_and_validate_image, new_id, normalize_iso, now_iso};

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

#[tracing::instrument(skip(state, input), fields(entity_id))]
#[tauri::command]
pub fn create_event(
    space_id: String,
    world_id: String,
    input: CreateEventInput,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    let event_id = new_id();
    tracing::Span::current().record("entity_id", event_id.as_str());
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    state.with_world(&space_id, &world_id, |conn| {
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
    load_event(conn, &event_id, &world_id)
})
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

#[tracing::instrument(skip(state, input, id), fields(entity_id = %id))]
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
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    state.with_world(&space_id, &world_id, |conn| {
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

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
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
    skip(state, image_base64),
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
) -> Result<(), DbError> {
    let bytes = decode_and_validate_image(&image_base64, &image_mime)?;
    let now = now_iso();
    tracing::info!(
        entity_id = %id,
        image_bytes_len = bytes.len(),
        image_mime = %image_mime,
        "image updated"
    );
    state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE events SET image_blob = ?1, image_mime = ?2, updated_at = ?3 WHERE id = ?4",
            params![&bytes, &image_mime, now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Event", id));
        }
        Ok(())
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn clear_event_image(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    let now = now_iso();
    tracing::info!(entity_id = %id, "image cleared");
    state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE events SET image_blob = NULL, image_mime = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Event", id));
        }
        Ok(())
    })
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
