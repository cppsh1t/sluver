use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::{
    Character, CharacterPhase, CharacterRef, CreateCharacterInput, CreatePhaseInput,
    UpdateCharacterInput, UpdatePhaseInput,
};
use crate::util::{new_id, now_iso};

// ─── helpers ────────────────────────────────────────────────────────────────

/// Raw character row (no world_id — injected from context; no phases — loaded separately).
struct CharacterRaw {
    id: String,
    name: String,
    aliases: Vec<String>,
    description: String,
    notes: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
}

fn row_to_character_raw(row: &rusqlite::Row) -> rusqlite::Result<CharacterRaw> {
    let aliases_json: String = row.get("aliases")?;
    let tags_json: String = row.get("tags")?;
    Ok(CharacterRaw {
        id: row.get("id")?,
        name: row.get("name")?,
        aliases: serde_json::from_str(&aliases_json).unwrap_or_default(),
        description: row.get("description")?,
        notes: row.get("notes")?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn load_phases(conn: &rusqlite::Connection, character_id: &str) -> rusqlite::Result<Vec<CharacterPhase>> {
    let mut stmt = conn.prepare(
        "SELECT id, character_id, appearance, changes, trigger_event_id, created_at, updated_at
         FROM character_phases WHERE character_id = ?1 ORDER BY position",
    )?;
    let phases = stmt
        .query_map(params![character_id], |row| {
            Ok(CharacterPhase {
                id: row.get("id")?,
                character_id: row.get("character_id")?,
                appearance: row.get("appearance")?,
                changes: row.get("changes")?,
                trigger_event_id: row.get("trigger_event_id")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(phases)
}

fn load_character(
    conn: &rusqlite::Connection,
    id: &str,
    world_id: &str,
) -> Result<Character, DbError> {
    let raw = conn
        .query_row(
            "SELECT id, name, aliases, description, notes, tags, created_at, updated_at
             FROM characters WHERE id = ?1",
            params![id],
            row_to_character_raw,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Character", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    let phases = load_phases(conn, &raw.id)?;

    Ok(Character {
        id: raw.id,
        world_id: world_id.to_string(),
        name: raw.name,
        aliases: raw.aliases,
        description: raw.description,
        phases,
        notes: raw.notes,
        tags: raw.tags,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}

// ─── Character CRUD ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_character(
    world_id: String,
    input: CreateCharacterInput,
    state: State<'_, DbManager>,
) -> Result<Character, DbError> {
    let char_id = new_id();
    let phase_id = new_id();
    let now = now_iso();
    let aliases_json = serde_json::to_string(&input.aliases)?;
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO characters (id, name, aliases, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![char_id, input.name, aliases_json, input.description, input.notes, tags_json, now, now],
        )?;
        tx.execute(
            "INSERT INTO character_phases (id, character_id, appearance, changes, trigger_event_id, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
            params![
                phase_id,
                char_id,
                input.initial_phase.appearance,
                input.initial_phase.changes,
                input.initial_phase.trigger_event_id,
                now,
                now,
            ],
        )?;
        tx.commit()?;
        load_character(conn, &char_id, &world_id)
    })
}

#[tauri::command]
pub fn get_character(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Character, DbError> {
    state.with_world(&world_id, |conn| load_character(conn, &id, &world_id))
}

#[tauri::command]
pub fn list_characters(world_id: String, state: State<'_, DbManager>) -> Result<Vec<Character>, DbError> {
    state.with_world(&world_id, |conn| {
        let ids: Vec<String> = conn
            .prepare("SELECT id FROM characters ORDER BY created_at")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        ids.iter()
            .map(|id| load_character(conn, id, &world_id))
            .collect()
    })
}

#[tauri::command]
pub fn update_character(
    world_id: String,
    id: String,
    input: UpdateCharacterInput,
    state: State<'_, DbManager>,
) -> Result<Character, DbError> {
    let now = now_iso();
    let aliases_json = serde_json::to_string(&input.aliases)?;
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE characters
             SET name = ?1, aliases = ?2, description = ?3, notes = ?4, tags = ?5, updated_at = ?6
             WHERE id = ?7",
            params![input.name, aliases_json, input.description, input.notes, tags_json, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Character", id));
        }
        load_character(conn, &id, &world_id)
    })
}

#[tauri::command]
pub fn delete_character(world_id: String, id: String, state: State<'_, DbManager>) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM characters WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Character", id));
        }
        Ok(())
    })
}

// ─── Phase CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn add_phase(
    world_id: String,
    character_id: String,
    input: CreatePhaseInput,
    state: State<'_, DbManager>,
) -> Result<CharacterPhase, DbError> {
    let phase_id = new_id();
    let now = now_iso();

    state.with_world(&world_id, |conn| {
        let tx = conn.transaction()?;

        // position = max(existing position) + 1, or 0 if first
        let next_pos: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM character_phases WHERE character_id = ?1",
                params![&character_id],
                |row| row.get(0),
            )?;

        tx.execute(
            "INSERT INTO character_phases (id, character_id, appearance, changes, trigger_event_id, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                phase_id,
                character_id,
                input.appearance,
                input.changes,
                input.trigger_event_id,
                next_pos,
                now,
                now,
            ],
        )?;
        tx.commit()?;

        // Read back
        conn.query_row(
            "SELECT id, character_id, appearance, changes, trigger_event_id, created_at, updated_at
             FROM character_phases WHERE id = ?1",
            params![phase_id],
            |row| {
                Ok(CharacterPhase {
                    id: row.get("id")?,
                    character_id: row.get("character_id")?,
                    appearance: row.get("appearance")?,
                    changes: row.get("changes")?,
                    trigger_event_id: row.get("trigger_event_id")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            },
        )
        .map_err(DbError::Sqlite)
    })
}

#[tauri::command]
pub fn update_phase(
    world_id: String,
    phase_id: String,
    input: UpdatePhaseInput,
    state: State<'_, DbManager>,
) -> Result<CharacterPhase, DbError> {
    let now = now_iso();

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE character_phases
             SET appearance = ?1, changes = ?2, trigger_event_id = ?3, updated_at = ?4
             WHERE id = ?5",
            params![input.appearance, input.changes, input.trigger_event_id, now, phase_id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Phase", phase_id));
        }

        conn.query_row(
            "SELECT id, character_id, appearance, changes, trigger_event_id, created_at, updated_at
             FROM character_phases WHERE id = ?1",
            params![phase_id],
            |row| {
                Ok(CharacterPhase {
                    id: row.get("id")?,
                    character_id: row.get("character_id")?,
                    appearance: row.get("appearance")?,
                    changes: row.get("changes")?,
                    trigger_event_id: row.get("trigger_event_id")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            },
        )
        .map_err(DbError::Sqlite)
    })
}

#[tauri::command]
pub fn delete_phase(world_id: String, phase_id: String, state: State<'_, DbManager>) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM character_phases WHERE id = ?1", params![phase_id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Phase", phase_id));
        }
        Ok(())
    })
}

// Suppress unused import warning — CharacterRef will be used by other command modules.
#[allow(dead_code)]
fn _ensure_character_ref_used(_: CharacterRef) {}
