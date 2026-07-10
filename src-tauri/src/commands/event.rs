use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::CharacterRef;
use crate::models::event::{CreateEventInput, Event, UpdateEventInput};
use crate::util::{new_id, now_iso};

fn load_event(
    conn: &mut rusqlite::Connection,
    id: &str,
    world_id: &str,
) -> Result<Event, DbError> {
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
    world_id: String,
    input: CreateEventInput,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    let event_id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
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
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    state.with_world(&world_id, |conn| load_event(conn, &id, &world_id))
}

#[tauri::command]
pub fn list_events(world_id: String, state: State<'_, DbManager>) -> Result<Vec<Event>, DbError> {
    state.with_world(&world_id, |conn| {
        let ids: Vec<String> = conn
            .prepare("SELECT id FROM events ORDER BY created_at")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        ids.iter()
            .map(|id| load_event(conn, id, &world_id))
            .collect()
    })
}

#[tauri::command]
pub fn update_event(
    world_id: String,
    id: String,
    input: UpdateEventInput,
    state: State<'_, DbManager>,
) -> Result<Event, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
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
pub fn delete_event(world_id: String, id: String, state: State<'_, DbManager>) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM events WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Event", id));
        }
        Ok(())
    })
}
