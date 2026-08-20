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
#[path = "tests/character.rs"]
mod tests;
