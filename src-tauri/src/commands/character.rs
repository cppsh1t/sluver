use rusqlite::params;
use std::collections::HashMap;
use tauri::{AppHandle, State};

use crate::commands::events::emit_entity_changed;
use crate::db::{DbError, DbManager};
use crate::models::character::{
    Character, CharacterPhase, CharacterRef, CreateCharacterInput, CreatePhaseInput,
    UpdateCharacterInput, UpdatePhaseInput,
};
use crate::util::{decode_and_validate_image, new_id, now_iso};

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
    has_image: bool,
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
        has_image: row.get("has_image")?,
    })
}

fn load_phases(
    conn: &rusqlite::Connection,
    character_id: &str,
) -> rusqlite::Result<Vec<CharacterPhase>> {
    let mut stmt = conn.prepare(
        "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.description, cp.conversation_style, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name, cp.image_blob IS NOT NULL AS has_image
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
                description: row.get("description")?,
                conversation_style: row.get("conversation_style")?,
                trigger_event_id: row.get("trigger_event_id")?,
                trigger_event_name: row.get("trigger_event_name")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                has_image: row.get("has_image")?,
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
            "SELECT id, name, aliases, description, notes, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image
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
        has_image: raw.has_image,
    })
}

// ─── Character CRUD ─────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, app, input), fields(entity_id))]
#[tauri::command]
pub fn create_character(
    space_id: String,
    world_id: String,
    input: CreateCharacterInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Character, DbError> {
    let entity = do_create_character(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", entity.id.as_str());
    Ok(entity)
}

pub(crate) fn do_create_character(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateCharacterInput,
    app: Option<&AppHandle>,
) -> Result<Character, DbError> {
    let char_id = new_id();
    let now = now_iso();
    let aliases_json = serde_json::to_string(&input.aliases)?;
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO characters (id, name, aliases, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![char_id, input.name, aliases_json, input.description, input.notes, tags_json, now, now],
        )?;
        tx.commit()?;
        load_character(conn, &char_id, world_id)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(app, "character", Some(entity.id.clone()), space_id, Some(world_id));
        }
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
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

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_characters(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Character>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
    // (a) Batch-load all characters
    let mut stmt = conn.prepare(
        "SELECT id, name, aliases, description, notes, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image
         FROM characters ORDER BY created_at",
    )?;
    let raws: Vec<CharacterRaw> = stmt
        .query_map([], row_to_character_raw)?
        .collect::<Result<Vec<_>, _>>()?;

    // (b) Batch-load ALL phases
    let mut phase_stmt = conn.prepare(
        "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.description, cp.conversation_style, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name, cp.image_blob IS NOT NULL AS has_image
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
                    description: row.get("description")?,
                    conversation_style: row.get("conversation_style")?,
                    trigger_event_id: row.get("trigger_event_id")?,
                    trigger_event_name: row.get("trigger_event_name")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    has_image: row.get("has_image")?,
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
                has_image: raw.has_image,
            }
        })
        .collect();

    Ok(result)
})
}

#[tracing::instrument(skip(state, app, input, id), fields(entity_id = %id))]
#[tauri::command]
pub fn update_character(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateCharacterInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Character, DbError> {
    do_update_character(&state, &space_id, &world_id, &id, &input, Some(&app))
}

pub(crate) fn do_update_character(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateCharacterInput,
    app: Option<&AppHandle>,
) -> Result<Character, DbError> {
    let now = now_iso();
    let aliases_json = serde_json::to_string(&input.aliases)?;
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
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
            return Err(DbError::NotFound("Character", id.to_string()));
        }
        load_character(conn, id, world_id)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(app, "character", Some(entity.id.clone()), space_id, Some(world_id));
        }
    }
    result
}

#[tracing::instrument(skip(state, app, id), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_character(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_character(&state, &space_id, &world_id, &id, Some(&app))
}

pub(crate) fn do_delete_character(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM characters WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Character", id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(app, "character", Some(id.to_string()), space_id, Some(world_id));
        }
    }
    result
}

// ─── Phase CRUD ─────────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, app, input), fields(entity_id))]
#[tauri::command]
pub fn add_phase(
    space_id: String,
    world_id: String,
    character_id: String,
    input: CreatePhaseInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<CharacterPhase, DbError> {
    let entity = do_add_phase(&state, &space_id, &world_id, &character_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", entity.id.as_str());
    Ok(entity)
}

pub(crate) fn do_add_phase(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    character_id: &str,
    input: &CreatePhaseInput,
    app: Option<&AppHandle>,
) -> Result<CharacterPhase, DbError> {
    let phase_id = new_id();
    let now = now_iso();

    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        // position = max(existing position) + 1, or 0 if first
        let next_pos: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM character_phases WHERE character_id = ?1",
                params![character_id],
                |row| row.get(0),
            )?;

        tx.execute(
            "INSERT INTO character_phases (id, character_id, name, appearance, description, conversation_style, trigger_event_id, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                phase_id,
                character_id,
                input.name,
                input.appearance,
                input.description,
                input.conversation_style,
                input.trigger_event_id,
                next_pos,
                now,
                now,
            ],
        )?;
        tx.commit()?;

        // Read back
        conn.query_row(
            "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.description, cp.conversation_style, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name, cp.image_blob IS NOT NULL AS has_image
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
                    description: row.get("description")?,
                    conversation_style: row.get("conversation_style")?,
                    trigger_event_id: row.get("trigger_event_id")?,
                    trigger_event_name: row.get("trigger_event_name")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    has_image: row.get("has_image")?,
                })
            },
        )
        .map_err(DbError::Sqlite)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(app, "phase", Some(entity.id.clone()), space_id, Some(world_id));
        }
    }
    result
}

#[tracing::instrument(skip(state, app, input, phase_id), fields(entity_id = %phase_id))]
#[tauri::command]
pub fn update_phase(
    space_id: String,
    world_id: String,
    phase_id: String,
    input: UpdatePhaseInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<CharacterPhase, DbError> {
    do_update_phase(&state, &space_id, &world_id, &phase_id, &input, Some(&app))
}

pub(crate) fn do_update_phase(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    phase_id: &str,
    input: &UpdatePhaseInput,
    app: Option<&AppHandle>,
) -> Result<CharacterPhase, DbError> {
    let now = now_iso();

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn.execute(
            "UPDATE character_phases
             SET name = ?1, appearance = ?2, description = ?3, conversation_style = ?4, trigger_event_id = ?5, updated_at = ?6
             WHERE id = ?7",
            params![input.name, input.appearance, input.description, input.conversation_style, input.trigger_event_id, now, phase_id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Phase", phase_id.to_string()));
        }

        conn.query_row(
            "SELECT cp.id, cp.character_id, cp.name, cp.appearance, cp.description, cp.conversation_style, cp.trigger_event_id, cp.created_at, cp.updated_at, e.name AS trigger_event_name, cp.image_blob IS NOT NULL AS has_image
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
                    description: row.get("description")?,
                    conversation_style: row.get("conversation_style")?,
                    trigger_event_id: row.get("trigger_event_id")?,
                    trigger_event_name: row.get("trigger_event_name")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    has_image: row.get("has_image")?,
                })
            },
        )
        .map_err(DbError::Sqlite)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(app, "phase", Some(entity.id.clone()), space_id, Some(world_id));
        }
    }
    result
}

#[tracing::instrument(skip(state, app, phase_id), fields(entity_id = %phase_id))]
#[tauri::command]
pub fn delete_phase(
    space_id: String,
    world_id: String,
    phase_id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_phase(&state, &space_id, &world_id, &phase_id, Some(&app))
}

pub(crate) fn do_delete_phase(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    phase_id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute(
            "DELETE FROM character_phases WHERE id = ?1",
            params![phase_id],
        )?;
        if deleted == 0 {
            return Err(DbError::NotFound("Phase", phase_id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(app, "phase", Some(phase_id.to_string()), space_id, Some(world_id));
        }
    }
    result
}

// Suppress unused import warning — CharacterRef will be used by other command modules.
#[allow(dead_code)]
fn _ensure_character_ref_used(_: CharacterRef) {}

// ─── Phase reorder ───────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, app, phase_ids))]
#[tauri::command]
pub fn reorder_phases(
    space_id: String,
    world_id: String,
    character_id: String,
    phase_ids: Vec<String>,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_reorder_phases(&state, &space_id, &world_id, &character_id, &phase_ids, Some(&app))
}

pub(crate) fn do_reorder_phases(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    character_id: &str,
    phase_ids: &[String],
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
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
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(app, "phase", None, space_id, Some(world_id));
        }
    }
    result
}

// ─── Per-entity image commands (Character + CharacterPhase) ─────────────────
//
// Two separate triples — Character and CharacterPhase use different tables
// (`characters` vs `character_phases`) and surface under different NotFound
// labels, but the body is otherwise identical, so we share one macro. Phase
// commands use the "phase" naming (matching `add_phase` / `update_phase`
// above) — the `id` is the phase row's id, not the parent character's.
//
// Logging follows ADR-0014 / ADR-0016: only metadata (entity_id, byte length,
// mime) is ever logged — the bytes themselves are creative content. update +
// clear are INFO; get is DEBUG because it fires on every avatar render.

macro_rules! impl_character_image_commands {
    ($table:literal, $label:literal, $kind:literal, $id_param:ident, $update_fn:ident, $clear_fn:ident, $get_fn:ident) => {
        #[tracing::instrument(
            skip(state, app, image_base64),
            fields(entity_id = %$id_param)
        )]
        #[tauri::command]
        pub fn $update_fn(
            space_id: String,
            world_id: String,
            $id_param: String,
            image_base64: String,
            image_mime: String,
            state: State<'_, DbManager>,
            app: AppHandle,
        ) -> Result<(), DbError> {
            let bytes = decode_and_validate_image(&image_base64, &image_mime)?;
            let now = now_iso();
            tracing::info!(
                entity_id = %$id_param,
                image_bytes_len = bytes.len(),
                image_mime = %image_mime,
                "image updated"
            );
            let result = state.with_world(&space_id, &world_id, |conn| {
                let updated = conn.execute(
                    &format!(
                        "UPDATE {} SET image_blob = ?1, image_mime = ?2, updated_at = ?3 WHERE id = ?4",
                        $table
                    ),
                    params![&bytes, &image_mime, now, &$id_param],
                )?;
                if updated == 0 {
                    return Err(DbError::NotFound($label, $id_param.clone()));
                }
                Ok(())
            });
            if result.is_ok() {
                emit_entity_changed(&app, $kind, Some($id_param.clone()), &space_id, Some(&world_id));
            }
            result
        }

        #[tracing::instrument(skip(state, app, $id_param), fields(entity_id = %$id_param))]
        #[tauri::command]
        pub fn $clear_fn(
            space_id: String,
            world_id: String,
            $id_param: String,
            state: State<'_, DbManager>,
            app: AppHandle,
        ) -> Result<(), DbError> {
            let now = now_iso();
            tracing::info!(entity_id = %$id_param, "image cleared");
            let result = state.with_world(&space_id, &world_id, |conn| {
                let updated = conn.execute(
                    &format!(
                        "UPDATE {} SET image_blob = NULL, image_mime = NULL, updated_at = ?1 WHERE id = ?2",
                        $table
                    ),
                    params![now, &$id_param],
                )?;
                if updated == 0 {
                    return Err(DbError::NotFound($label, $id_param.clone()));
                }
                Ok(())
            });
            if result.is_ok() {
                emit_entity_changed(&app, $kind, Some($id_param.clone()), &space_id, Some(&world_id));
            }
            result
        }

        #[tracing::instrument(skip(state, $id_param), fields(entity_id = %$id_param))]
        #[tauri::command]
        pub fn $get_fn(
            space_id: String,
            world_id: String,
            $id_param: String,
            state: State<'_, DbManager>,
        ) -> Result<tauri::ipc::Response, DbError> {
            tracing::debug!(entity_id = %$id_param, "image fetched");
            let bytes: Option<Vec<u8>> = state.with_world(&space_id, &world_id, |conn| {
                conn.query_row(
                    &format!("SELECT image_blob FROM {} WHERE id = ?1", $table),
                    params![&$id_param],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => {
                        DbError::NotFound("Image", $id_param.clone())
                    }
                    other => DbError::Sqlite(other),
                })
            })?;
            let bytes = bytes.ok_or_else(|| DbError::NotFound("Image", $id_param))?;
            Ok(tauri::ipc::Response::new(bytes))
        }
    };
}

impl_character_image_commands!(
    "characters",
    "Character",
    "character",
    id,
    update_character_image,
    clear_character_image,
    get_character_image
);
impl_character_image_commands!(
    "character_phases",
    "Phase",
    "phase",
    phase_id,
    update_phase_image,
    clear_phase_image,
    get_phase_image
);

// ─── Tests ───────────────────────────────────────────────────────────────────
//
// Command-level integration tests against a real migrated world DB
// (`testutil::make_space_with_world`) — this crate has no Tauri mock
// runtime, so tests drive the `do_*` helpers with `app: None` (no event
// emission) and assert storage invariants via raw SQL.

#[cfg(test)]
mod tests {
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
        let a = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Aria"), None)
            .expect("create A");
        let b = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Brin"), None)
            .expect("create B");

        let a0 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, &phase_input("childhood"), None)
            .expect("A phase 0");
        let a1 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, &phase_input("adult"), None)
            .expect("A phase 1");
        let b0 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &b.id, &phase_input("only"), None)
            .expect("B phase 0");

        let positions: (i64, i64, i64) = with_world(&fx, |c| {
            Ok((phase_pos(c, &a0.id)?, phase_pos(c, &a1.id)?, phase_pos(c, &b0.id)?))
        })
        .expect("read positions");
        assert_eq!(positions, (0, 1, 0));
    }

    // 2. reorder_phases: temp-shift reorder works; a phase id belonging to
    //    another character → NotFound, and the failed transaction rolls back.
    #[test]
    fn reorder_phases_swaps_and_rejects_foreign_phase() {
        let fx = make_space_with_world();
        let a = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Aria"), None)
            .expect("create A");
        let b = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Brin"), None)
            .expect("create B");
        let pa = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, &phase_input("first"), None)
            .expect("A phase a");
        let pb = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, &phase_input("second"), None)
            .expect("A phase b");
        let qb = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &b.id, &phase_input("b-only"), None)
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
        let a = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Aria"), None)
            .expect("create A");
        let b = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Brin"), None)
            .expect("create B");
        let pa = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, &phase_input("a"), None)
            .expect("A phase");
        let pb = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &b.id, &phase_input("b"), None)
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
                count(c, "SELECT COUNT(*) FROM character_phases WHERE character_id = ?1", &a.id)?,
                count(c, "SELECT COUNT(*) FROM event_character_refs WHERE character_id = ?1", &a.id)?,
                count(c, "SELECT COUNT(*) FROM scene_character_refs WHERE character_id = ?1", &a.id)?,
                count(c, "SELECT COUNT(*) FROM characters WHERE id = ?1", &b.id)?,
                count(c, "SELECT COUNT(*) FROM event_character_refs WHERE character_id = ?1", &b.id)?,
                count(c, "SELECT COUNT(*) FROM scene_character_refs WHERE character_id = ?1", &b.id)?,
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
        let ch = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Aria"), None)
            .expect("create");
        let p1 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &ch.id, &phase_input("early"), None)
            .expect("phase 1");
        let p2 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &ch.id, &phase_input("late"), None)
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
                count(c, "SELECT COUNT(*) FROM character_phases WHERE id = ?1", &p1.id)?,
                count(c, "SELECT COUNT(*) FROM character_phases WHERE id = ?1", &p2.id)?,
                count(c, "SELECT COUNT(*) FROM event_character_refs WHERE phase_id = ?1", &p1.id)?,
                count(c, "SELECT COUNT(*) FROM scene_character_refs WHERE phase_id = ?1", &p1.id)?,
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
        let ch = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Aria"), None)
            .expect("create");
        let p1 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &ch.id, &phase_input("early"), None)
            .expect("phase 1");
        let p2 = do_add_phase(&fx.mgr, &fx.space_id, &fx.world_id, &ch.id, &phase_input("late"), None)
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
        do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Rivka"), None)
            .expect("first Rivka");
        let err = do_create_character(&fx.mgr, &fx.space_id, &fx.world_id, &char_input("Rivka"), None)
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
        assert!(updated.aliases.is_empty(), "full replacement resets aliases");
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
}
