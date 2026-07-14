use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::item::{CreateItemInput, Item, UpdateItemInput};
use crate::models::location::{CreateLocationInput, Location, UpdateLocationInput};
use crate::models::lore::{CreateLoreInput, Lore, UpdateLoreInput};
use crate::util::{new_id, now_iso};

// ─── shared helpers ───────────────────────────────────────────────────────────

struct ElementRaw {
    id: String,
    name: String,
    description: String,
    notes: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
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
    })
}

const SELECT_COLS: &str =
    "id, name, description, notes, tags, created_at, updated_at";

macro_rules! load_element {
    ($conn:expr, $id:expr, $world_id:expr, $table:literal, $Entity:ident, $label:literal) => {{
        let raw = $conn
            .query_row(
                &format!("SELECT {SELECT_COLS} FROM {} WHERE id = ?1", $table),
                params![$id],
                row_to_element_raw,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DbError::NotFound($label, $id.to_string())
                }
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
        })
    }};
}

macro_rules! list_element {
    ($conn:expr, $world_id:expr, $table:literal, $Entity:ident) => {{
        let mut stmt = $conn
            .prepare(&format!("SELECT {SELECT_COLS} FROM {} ORDER BY created_at", $table))?;
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
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entities)
    }};
}

// ─── Location CRUD ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_location(
    world_id: String,
    input: CreateLocationInput,
    state: State<'_, DbManager>,
) -> Result<Location, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        conn.execute(
            "INSERT INTO locations (id, name, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.name, input.description, input.notes, tags_json, now, now],
        )?;
        load_element!(conn, &id, &world_id, "locations", Location, "Location")
    })
}

#[tauri::command]
pub fn get_location(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Location, DbError> {
    state.with_world(&world_id, |conn| {
        load_element!(conn, &id, &world_id, "locations", Location, "Location")
    })
}

#[tauri::command]
pub fn list_locations(
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Location>, DbError> {
    state.with_world(&world_id, |conn| {
        list_element!(conn, world_id, "locations", Location)
    })
}

#[tauri::command]
pub fn update_location(
    world_id: String,
    id: String,
    input: UpdateLocationInput,
    state: State<'_, DbManager>,
) -> Result<Location, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE locations
             SET name = ?1, description = ?2, notes = ?3, tags = ?4, updated_at = ?5
             WHERE id = ?6",
            params![input.name, input.description, input.notes, tags_json, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Location", id));
        }
        load_element!(conn, &id, &world_id, "locations", Location, "Location")
    })
}

#[tauri::command]
pub fn delete_location(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM locations WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Location", id));
        }
        Ok(())
    })
}

// ─── Item CRUD ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_item(
    world_id: String,
    input: CreateItemInput,
    state: State<'_, DbManager>,
) -> Result<Item, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        conn.execute(
            "INSERT INTO items (id, name, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.name, input.description, input.notes, tags_json, now, now],
        )?;
        load_element!(conn, &id, &world_id, "items", Item, "Item")
    })
}

#[tauri::command]
pub fn get_item(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Item, DbError> {
    state.with_world(&world_id, |conn| {
        load_element!(conn, &id, &world_id, "items", Item, "Item")
    })
}

#[tauri::command]
pub fn list_items(
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Item>, DbError> {
    state.with_world(&world_id, |conn| {
        list_element!(conn, world_id, "items", Item)
    })
}

#[tauri::command]
pub fn update_item(
    world_id: String,
    id: String,
    input: UpdateItemInput,
    state: State<'_, DbManager>,
) -> Result<Item, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE items
             SET name = ?1, description = ?2, notes = ?3, tags = ?4, updated_at = ?5
             WHERE id = ?6",
            params![input.name, input.description, input.notes, tags_json, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Item", id));
        }
        load_element!(conn, &id, &world_id, "items", Item, "Item")
    })
}

#[tauri::command]
pub fn delete_item(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Item", id));
        }
        Ok(())
    })
}

// ─── Lore CRUD ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_lore(
    world_id: String,
    input: CreateLoreInput,
    state: State<'_, DbManager>,
) -> Result<Lore, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        conn.execute(
            "INSERT INTO lores (id, name, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.name, input.description, input.notes, tags_json, now, now],
        )?;
        load_element!(conn, &id, &world_id, "lores", Lore, "Lore")
    })
}

#[tauri::command]
pub fn get_lore(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Lore, DbError> {
    state.with_world(&world_id, |conn| {
        load_element!(conn, &id, &world_id, "lores", Lore, "Lore")
    })
}

#[tauri::command]
pub fn list_lores(
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Lore>, DbError> {
    state.with_world(&world_id, |conn| {
        list_element!(conn, world_id, "lores", Lore)
    })
}

#[tauri::command]
pub fn update_lore(
    world_id: String,
    id: String,
    input: UpdateLoreInput,
    state: State<'_, DbManager>,
) -> Result<Lore, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE lores
             SET name = ?1, description = ?2, notes = ?3, tags = ?4, updated_at = ?5
             WHERE id = ?6",
            params![input.name, input.description, input.notes, tags_json, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Lore", id));
        }
        load_element!(conn, &id, &world_id, "lores", Lore, "Lore")
    })
}

#[tauri::command]
pub fn delete_lore(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM lores WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Lore", id));
        }
        Ok(())
    })
}
