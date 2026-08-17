use rusqlite::params;
use tauri::{AppHandle, State};

use crate::commands::events::emit_entity_changed;
use crate::db::{DbError, DbManager};
use crate::models::item::{CreateItemInput, Item, UpdateItemInput};
use crate::models::location::{CreateLocationInput, Location, UpdateLocationInput};
use crate::models::lore::{CreateLoreInput, Lore, UpdateLoreInput};
use crate::util::{decode_and_validate_image, new_id, now_iso};

// ─── shared helpers ───────────────────────────────────────────────────────────

struct ElementRaw {
    id: String,
    name: String,
    description: String,
    notes: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    has_image: bool,
}

fn row_to_element_raw(row: &rusqlite::Row) -> rusqlite::Result<ElementRaw> {
    let tags_json: String = row.get("tags")?;
    Ok(ElementRaw {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        notes: row.get("notes")?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        has_image: row.get("has_image")?,
    })
}

const SELECT_COLS: &str = "id, name, description, notes, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image";

macro_rules! load_element {
    ($conn:expr, $id:expr, $world_id:expr, $table:literal, $Entity:ident, $label:literal) => {{
        let raw = $conn
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM {} WHERE id = ?1", $table),
                params![$id],
                row_to_element_raw,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::NotFound($label, $id.to_string()),
                other => DbError::Sqlite(other),
            })?;

        Ok($Entity {
            id: raw.id,
            world_id: $world_id.to_string(),
            name: raw.name,
            description: raw.description,
            notes: raw.notes,
            tags: raw.tags,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            has_image: raw.has_image,
        })
    }};
}

macro_rules! list_element {
    ($conn:expr, $world_id:expr, $table:literal, $Entity:ident) => {{
        let mut stmt = $conn.prepare(&format!(
            "SELECT {SELECT_COLS} FROM {} ORDER BY created_at",
            $table
        ))?;
        let entities = stmt
            .query_map([], |row| {
                let raw = row_to_element_raw(row)?;
                Ok($Entity {
                    id: raw.id,
                    world_id: $world_id.clone(),
                    name: raw.name,
                    description: raw.description,
                    notes: raw.notes,
                    tags: raw.tags,
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                    has_image: raw.has_image,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entities)
    }};
}

// ─── Location CRUD ───────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_location(
    space_id: String,
    world_id: String,
    input: CreateLocationInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Location, DbError> {
    let entity = do_create_location(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", entity.id.as_str());
    Ok(entity)
}

pub(crate) fn do_create_location(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateLocationInput,
    app: Option<&AppHandle>,
) -> Result<Location, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        conn.execute(
            "INSERT INTO locations (id, name, description, notes, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                input.name,
                input.description,
                input.notes,
                tags_json,
                now,
                now
            ],
        )?;
        load_element!(conn, &id, world_id, "locations", Location, "Location")
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "location",
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
pub fn get_location(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Location, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_element!(conn, &id, &world_id, "locations", Location, "Location")
    })
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_locations(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Location>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        list_element!(conn, world_id, "locations", Location)
    })
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_location(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateLocationInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Location, DbError> {
    do_update_location(&state, &space_id, &world_id, &id, &input, Some(&app))
}

pub(crate) fn do_update_location(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateLocationInput,
    app: Option<&AppHandle>,
) -> Result<Location, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn.execute(
            "UPDATE locations
         SET name = ?1, description = ?2, notes = ?3, tags = ?4, updated_at = ?5
         WHERE id = ?6",
            params![
                input.name,
                input.description,
                input.notes,
                tags_json,
                now,
                id
            ],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Location", id.to_string()));
        }
        load_element!(conn, id, world_id, "locations", Location, "Location")
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "location",
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
pub fn delete_location(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_location(&state, &space_id, &world_id, &id, Some(&app))
}

pub(crate) fn do_delete_location(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM locations WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Location", id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "location",
                Some(id.to_string()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

// ─── Item CRUD ────────────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_item(
    space_id: String,
    world_id: String,
    input: CreateItemInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Item, DbError> {
    let entity = do_create_item(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", entity.id.as_str());
    Ok(entity)
}

pub(crate) fn do_create_item(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateItemInput,
    app: Option<&AppHandle>,
) -> Result<Item, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        conn.execute(
            "INSERT INTO items (id, name, description, notes, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                input.name,
                input.description,
                input.notes,
                tags_json,
                now,
                now
            ],
        )?;
        load_element!(conn, &id, world_id, "items", Item, "Item")
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "item",
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
pub fn get_item(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Item, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_element!(conn, &id, &world_id, "items", Item, "Item")
    })
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_items(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Item>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        list_element!(conn, world_id, "items", Item)
    })
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_item(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateItemInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Item, DbError> {
    do_update_item(&state, &space_id, &world_id, &id, &input, Some(&app))
}

pub(crate) fn do_update_item(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateItemInput,
    app: Option<&AppHandle>,
) -> Result<Item, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn.execute(
            "UPDATE items
         SET name = ?1, description = ?2, notes = ?3, tags = ?4, updated_at = ?5
         WHERE id = ?6",
            params![
                input.name,
                input.description,
                input.notes,
                tags_json,
                now,
                id
            ],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Item", id.to_string()));
        }
        load_element!(conn, id, world_id, "items", Item, "Item")
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "item",
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
pub fn delete_item(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_item(&state, &space_id, &world_id, &id, Some(&app))
}

pub(crate) fn do_delete_item(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Item", id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "item",
                Some(id.to_string()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

// ─── Lore CRUD ────────────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_lore(
    space_id: String,
    world_id: String,
    input: CreateLoreInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Lore, DbError> {
    let entity = do_create_lore(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", entity.id.as_str());
    Ok(entity)
}

pub(crate) fn do_create_lore(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateLoreInput,
    app: Option<&AppHandle>,
) -> Result<Lore, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        conn.execute(
            "INSERT INTO lores (id, name, description, notes, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                input.name,
                input.description,
                input.notes,
                tags_json,
                now,
                now
            ],
        )?;
        load_element!(conn, &id, world_id, "lores", Lore, "Lore")
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "lore",
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
pub fn get_lore(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Lore, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_element!(conn, &id, &world_id, "lores", Lore, "Lore")
    })
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_lores(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Lore>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        list_element!(conn, world_id, "lores", Lore)
    })
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_lore(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateLoreInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Lore, DbError> {
    do_update_lore(&state, &space_id, &world_id, &id, &input, Some(&app))
}

pub(crate) fn do_update_lore(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateLoreInput,
    app: Option<&AppHandle>,
) -> Result<Lore, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn.execute(
            "UPDATE lores
         SET name = ?1, description = ?2, notes = ?3, tags = ?4, updated_at = ?5
         WHERE id = ?6",
            params![
                input.name,
                input.description,
                input.notes,
                tags_json,
                now,
                id
            ],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Lore", id.to_string()));
        }
        load_element!(conn, id, world_id, "lores", Lore, "Lore")
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "lore",
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
pub fn delete_lore(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_lore(&state, &space_id, &world_id, &id, Some(&app))
}

pub(crate) fn do_delete_lore(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM lores WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Lore", id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "lore",
                Some(id.to_string()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

// ─── Per-entity image commands (Location / Item / Lore) ──────────────────────
//
// Mirrors the `load_element!` / `list_element!` macro pattern above: the three
// "element" tables share an identical image-column schema (`image_blob BLOB`,
// `image_mime TEXT`, both nullable), so we generate the 3 standard image IPC
// commands per table via one macro instantiated 3×. Image bytes flow ONLY
// through these dedicated commands — the entity structs and `list_*` / `get_*`
// queries never touch the columns (avoids a serde Vec<u8> → JSON-number-array
// encoding trap and keeps list payloads light).
//
// Logging follows ADR-0014 / ADR-0016: only metadata (entity_id, byte length,
// mime) is ever logged — the bytes themselves are creative content and must
// never reach the log file. update + clear are INFO; get is DEBUG because it
// fires on every cover-image render and would flood the log at INFO.

/// Generate `update_<entity>_image` / `clear_<entity>_image` / `get_<entity>_image`
/// commands bound to a specific `$table` and surfaced under `$label` in
/// `DbError::NotFound` messages. `$kind` is the `entity-changed` event kind
/// literal (e.g. `"location"`). The signature contract (frontend depends on
/// these exact names + param order):
///   - update: `(space_id, world_id, id, image_base64, image_mime, state, app)`
///   - clear:  `(space_id, world_id, id, state, app)`
///   - get:    `(space_id, world_id, id, state) -> tauri::ipc::Response`
macro_rules! impl_element_image_commands {
    ($table:literal, $label:literal, $kind:literal, $update_fn:ident, $clear_fn:ident, $get_fn:ident) => {
        #[tracing::instrument(
            skip(state, image_base64, app),
            fields(entity_id = %id)
        )]
        #[tauri::command]
        pub fn $update_fn(
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
                    &format!(
                        "UPDATE {} SET image_blob = ?1, image_mime = ?2, updated_at = ?3 WHERE id = ?4",
                        $table
                    ),
                    params![&bytes, &image_mime, now, &id],
                )?;
                if updated == 0 {
                    return Err(DbError::NotFound($label, id.clone()));
                }
                Ok(())
            });
            if result.is_ok() {
                emit_entity_changed(
                    &app,
                    $kind,
                    Some(id.clone()),
                    &space_id,
                    Some(&world_id),
                );
            }
            result
        }

        #[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
        #[tauri::command]
        pub fn $clear_fn(
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
                    &format!(
                        "UPDATE {} SET image_blob = NULL, image_mime = NULL, updated_at = ?1 WHERE id = ?2",
                        $table
                    ),
                    params![now, &id],
                )?;
                if updated == 0 {
                    return Err(DbError::NotFound($label, id.clone()));
                }
                Ok(())
            });
            if result.is_ok() {
                emit_entity_changed(
                    &app,
                    $kind,
                    Some(id.clone()),
                    &space_id,
                    Some(&world_id),
                );
            }
            result
        }

        #[tracing::instrument(skip(state, id), fields(entity_id = %id))]
        #[tauri::command]
        pub fn $get_fn(
            space_id: String,
            world_id: String,
            id: String,
            state: State<'_, DbManager>,
        ) -> Result<tauri::ipc::Response, DbError> {
            tracing::debug!(entity_id = %id, "image fetched");
            // Read the BLOB as Option<Vec<u8>> so a NULL image (row exists but
            // no image set) and a missing row both surface as a structured
            // NotFound("Image", id). The frontend treats both the same way
            // (show the placeholder).
            //
            // `id` is captured by reference inside the closure (params![&id]
            // + id.clone() in the error branch only borrow), so it stays owned
            // by this function and can be moved into the final NotFound below.
            let bytes: Option<Vec<u8>> = state.with_world(&space_id, &world_id, |conn| {
                conn.query_row(
                    &format!("SELECT image_blob FROM {} WHERE id = ?1", $table),
                    params![&id],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => {
                        DbError::NotFound("Image", id.clone())
                    }
                    other => DbError::Sqlite(other),
                })
            })?;
            let bytes = bytes.ok_or_else(|| DbError::NotFound("Image", id))?;
            Ok(tauri::ipc::Response::new(bytes))
        }
    };
}

impl_element_image_commands!(
    "locations",
    "Location",
    "location",
    update_location_image,
    clear_location_image,
    get_location_image
);
impl_element_image_commands!(
    "items",
    "Item",
    "item",
    update_item_image,
    clear_item_image,
    get_item_image
);
impl_element_image_commands!(
    "lores",
    "Lore",
    "lore",
    update_lore_image,
    clear_lore_image,
    get_lore_image
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
        let raw = with_world(&fx, |c| Ok(raw_tags(c, "locations", &created.id)?))
            .expect("raw tags");
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
        let raw_after =
            with_world(&fx, |c| Ok(raw_tags(c, "locations", &created.id)?))
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
        let raw = with_world(&fx, |c| Ok(raw_tags(c, "items", &created.id)?))
            .expect("raw tags");
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
        let raw_after = with_world(&fx, |c| Ok(raw_tags(c, "items", &created.id)?))
            .expect("raw tags after update");
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
        let raw = with_world(&fx, |c| Ok(raw_tags(c, "lores", &created.id)?))
            .expect("raw tags");
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
        let raw_after = with_world(&fx, |c| Ok(raw_tags(c, "lores", &created.id)?))
            .expect("raw tags after update");
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
                count(c, "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1", &item.id)?,
                count(c, "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1", &other.id)?,
            ))
        })
        .expect("counts before");
        assert_eq!(before, (2, 1));

        do_delete_item(&fx.mgr, &fx.space_id, &fx.world_id, &item.id, None).expect("delete item");

        let after: (i64, i64) = with_world(&fx, |c| {
            Ok((
                count(c, "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1", &item.id)?,
                count(c, "SELECT COUNT(*) FROM scene_item_refs WHERE item_id = ?1", &other.id)?,
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
                count(c, "SELECT COUNT(*) FROM scene_lore_refs WHERE lore_id = ?1", &lore.id)?,
                count(c, "SELECT COUNT(*) FROM scene_lore_refs WHERE lore_id = ?1", &other.id)?,
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
}
