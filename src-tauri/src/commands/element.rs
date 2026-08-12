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
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
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
        load_element!(conn, &id, &world_id, "locations", Location, "Location")
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "location",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
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
            return Err(DbError::NotFound("Location", id));
        }
        load_element!(conn, &id, &world_id, "locations", Location, "Location")
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "location",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM locations WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Location", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "location",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
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
        load_element!(conn, &id, &world_id, "items", Item, "Item")
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "item",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
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
            return Err(DbError::NotFound("Item", id));
        }
        load_element!(conn, &id, &world_id, "items", Item, "Item")
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "item",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Item", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "item",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
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
        load_element!(conn, &id, &world_id, "lores", Lore, "Lore")
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "lore",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
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
            return Err(DbError::NotFound("Lore", id));
        }
        load_element!(conn, &id, &world_id, "lores", Lore, "Lore")
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "lore",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM lores WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Lore", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "lore",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
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
