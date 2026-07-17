use rusqlite::params;
use std::collections::HashMap;
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

fn load_phases(
    conn: &rusqlite::Connection,
    character_id: &str,
) -> rusqlite::Result<Vec<CharacterPhase>> {
    let mut stmt = conn.prepare(
        "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.changes, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name
         FROM character_phases cp
         LEFT JOIN events e ON cp.trigger_event_id = e.id
         WHERE cp.character_id = ?1 ORDER BY cp.position",
    )?;
    let phases = stmt
        .query_map(params![character_id], |row| {
            Ok(CharacterPhase {
                id: row.get("id")?,
                character_id: row.get("character_id")?,
                name: row.get("name")?,
                appearance: row.get("appearance")?,
                changes: row.get("changes")?,
                trigger_event_id: row.get("trigger_event_id")?,
                trigger_event_name: row.get("trigger_event_name")?,
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
    space_id: String,
    world_id: String,
    input: CreateCharacterInput,
    state: State<'_, DbManager>,
) -> Result<Character, DbError> {
    let char_id = new_id();
    let now = now_iso();
    let aliases_json = serde_json::to_string(&input.aliases)?;
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&space_id, &world_id, |conn| {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO characters (id, name, aliases, description, notes, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![char_id, input.name, aliases_json, input.description, input.notes, tags_json, now, now],
    )?;
    tx.commit()?;
    load_character(conn, &char_id, &world_id)
})
}

#[tauri::command]
pub fn get_character(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Character, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_character(conn, &id, &world_id)
    })
}

#[tauri::command]
pub fn list_characters(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Character>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
    // (a) Batch-load all characters
    let mut stmt = conn.prepare(
        "SELECT id, name, aliases, description, notes, tags, created_at, updated_at
         FROM characters ORDER BY created_at",
    )?;
    let raws: Vec<CharacterRaw> = stmt
        .query_map([], row_to_character_raw)?
        .collect::<Result<Vec<_>, _>>()?;

    // (b) Batch-load ALL phases
    let mut phase_stmt = conn.prepare(
        "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.changes, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name
         FROM character_phases cp
         LEFT JOIN events e ON cp.trigger_event_id = e.id
         ORDER BY cp.character_id, cp.position",
    )?;
    let all_phases: Vec<(String, CharacterPhase)> = phase_stmt
        .query_map([], |row| {
            let cid: String = row.get("character_id")?;
            Ok((
                cid.clone(),
                CharacterPhase {
                    id: row.get("id")?,
                    character_id: cid,
                    name: row.get("name")?,
                    appearance: row.get("appearance")?,
                    changes: row.get("changes")?,
                    trigger_event_id: row.get("trigger_event_id")?,
                    trigger_event_name: row.get("trigger_event_name")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (c) Group phases by character_id
    let mut phase_map: HashMap<String, Vec<CharacterPhase>> = HashMap::new();
    for (cid, phase) in all_phases {
        phase_map.entry(cid).or_default().push(phase);
    }

    // (d) Assemble results
    let result: Vec<Character> = raws
        .into_iter()
        .map(|raw| {
            let phases = phase_map.remove(&raw.id).unwrap_or_default();
            Character {
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
            }
        })
        .collect();

    Ok(result)
})
}

#[tauri::command]
pub fn update_character(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateCharacterInput,
    state: State<'_, DbManager>,
) -> Result<Character, DbError> {
    let now = now_iso();
    let aliases_json = serde_json::to_string(&input.aliases)?;
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE characters
         SET name = ?1, aliases = ?2, description = ?3, notes = ?4, tags = ?5, updated_at = ?6
         WHERE id = ?7",
            params![
                input.name,
                aliases_json,
                input.description,
                input.notes,
                tags_json,
                now,
                id
            ],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Character", id));
        }
        load_character(conn, &id, &world_id)
    })
}

#[tauri::command]
pub fn delete_character(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&space_id, &world_id, |conn| {
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
    space_id: String,
    world_id: String,
    character_id: String,
    input: CreatePhaseInput,
    state: State<'_, DbManager>,
) -> Result<CharacterPhase, DbError> {
    let phase_id = new_id();
    let now = now_iso();

    state.with_world(&space_id, &world_id, |conn| {
    let tx = conn.transaction()?;

    // position = max(existing position) + 1, or 0 if first
    let next_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM character_phases WHERE character_id = ?1",
            params![&character_id],
            |row| row.get(0),
        )?;

    tx.execute(
        "INSERT INTO character_phases (id, character_id, name, appearance, changes, trigger_event_id, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            phase_id,
            character_id,
            input.name,
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
        "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.changes, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name
         FROM character_phases cp
         LEFT JOIN events e ON cp.trigger_event_id = e.id
         WHERE cp.id = ?1",
        params![phase_id],
        |row| {
            Ok(CharacterPhase {
                id: row.get("id")?,
                character_id: row.get("character_id")?,
                name: row.get("name")?,
                appearance: row.get("appearance")?,
                changes: row.get("changes")?,
                trigger_event_id: row.get("trigger_event_id")?,
                trigger_event_name: row.get("trigger_event_name")?,
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
    space_id: String,
    world_id: String,
    phase_id: String,
    input: UpdatePhaseInput,
    state: State<'_, DbManager>,
) -> Result<CharacterPhase, DbError> {
    let now = now_iso();

    state.with_world(&space_id, &world_id, |conn| {
    let updated = conn.execute(
        "UPDATE character_phases
         SET name = ?1, appearance = ?2, changes = ?3, trigger_event_id = ?4, updated_at = ?5
         WHERE id = ?6",
        params![input.name, input.appearance, input.changes, input.trigger_event_id, now, phase_id],
    )?;
    if updated == 0 {
        return Err(DbError::NotFound("Phase", phase_id));
    }

    conn.query_row(
        "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.changes, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name
         FROM character_phases cp
         LEFT JOIN events e ON cp.trigger_event_id = e.id
         WHERE cp.id = ?1",
        params![phase_id],
        |row| {
            Ok(CharacterPhase {
                id: row.get("id")?,
                character_id: row.get("character_id")?,
                name: row.get("name")?,
                appearance: row.get("appearance")?,
                changes: row.get("changes")?,
                trigger_event_id: row.get("trigger_event_id")?,
                trigger_event_name: row.get("trigger_event_name")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        },
    )
    .map_err(DbError::Sqlite)
})
}

#[tauri::command]
pub fn delete_phase(
    space_id: String,
    world_id: String,
    phase_id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute(
            "DELETE FROM character_phases WHERE id = ?1",
            params![phase_id],
        )?;
        if deleted == 0 {
            return Err(DbError::NotFound("Phase", phase_id));
        }
        Ok(())
    })
}

// Suppress unused import warning — CharacterRef will be used by other command modules.
#[allow(dead_code)]
fn _ensure_character_ref_used(_: CharacterRef) {}

// ─── Phase reorder ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn reorder_phases(
    space_id: String,
    world_id: String,
    character_id: String,
    phase_ids: Vec<String>,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let tx = conn.transaction()?;

        // Shift to a temporary range to avoid UNIQUE(character_id, position) violations
        // during per-row updates.
        tx.execute(
            "UPDATE character_phases SET position = position + 1000000 WHERE character_id = ?1",
            params![character_id],
        )?;

        for (i, ph_id) in phase_ids.iter().enumerate() {
            let pos = i as i64;
            let affected = tx.execute(
                "UPDATE character_phases SET position = ?1 WHERE id = ?2 AND character_id = ?3",
                params![pos, ph_id, character_id],
            )?;
            if affected == 0 {
                return Err(DbError::NotFound("Phase", ph_id.clone()));
            }
        }

        tx.commit()?;
        Ok(())
    })
}
