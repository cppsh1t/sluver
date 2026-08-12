use rusqlite::params;
use tauri::{AppHandle, State};

use crate::commands::events::emit_entity_changed;
use crate::db::migrations::WORLD_MIGRATIONS;
use crate::db::{DbError, DbManager};
use crate::models::world::{CreateWorldInput, UpdateWorldInput, World};
use crate::util::{decode_and_validate_image, new_id, now_iso};

// ─── helpers ────────────────────────────────────────────────────────────────

fn row_to_world(row: &rusqlite::Row) -> rusqlite::Result<World> {
    Ok(World {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        has_image: row.get("has_image")?,
    })
}

// ─── World CRUD (space.db registry) ─────────────────────────────────────────
//
// Per ADR-0007 the worlds registry moved out of meta.db into each Space's
// own `space.db`. All five commands now resolve via `with_space` (registry
// reads/writes) and gain `space_id` as the first param. World content DB
// files live at `spaces/{spaceId}/worlds/{worldId}.db`.

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_world(
    space_id: String,
    input: CreateWorldInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<World, DbError> {
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    let db_path = format!("worlds/{id}.db");

    // 1. Create the world DB file + run migrations. Path is relative to the
    //    Space dir: `spaces/{spaceId}/worlds/{worldId}.db`.
    let full_path = state
        .data_dir()
        .join("spaces")
        .join(&space_id)
        .join(&db_path);
    {
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = rusqlite::Connection::open(&full_path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        WORLD_MIGRATIONS.to_latest(&mut conn)?;
    }

    // 2. Insert into the Space's registry (space.db). Clean up the orphaned
    //    content file if the insert fails (e.g. UNIQUE name violation).
    state
        .with_space(&space_id, |conn| {
            conn.execute(
                "INSERT INTO worlds (id, name, description, db_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, input.name, input.description, db_path, now, now],
            )?;
            Ok(())
        })
        .inspect_err(|_e| {
            let _ = std::fs::remove_file(&full_path);
            let _ = std::fs::remove_file(format!("{}-wal", full_path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", full_path.display()));
        })?;

    let entity = World {
        id,
        name: input.name,
        description: input.description,
        created_at: now.clone(),
        updated_at: now,
        has_image: false,
    };
    emit_entity_changed(&app, "world", Some(entity.id.clone()), &space_id, None);
    Ok(entity)
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_worlds(space_id: String, state: State<'_, DbManager>) -> Result<Vec<World>, DbError> {
    state.with_space(&space_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, created_at, updated_at, image_blob IS NOT NULL AS has_image FROM worlds ORDER BY created_at",
        )?;
        let worlds = stmt
            .query_map([], row_to_world)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(worlds)
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_world(
    space_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<World, DbError> {
    state.with_space(&space_id, |conn| {
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at, image_blob IS NOT NULL AS has_image FROM worlds WHERE id = ?1",
            params![id],
            row_to_world,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::WorldNotFound(id),
            other => DbError::Sqlite(other),
        })
    })
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_world(
    space_id: String,
    id: String,
    input: UpdateWorldInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<World, DbError> {
    let now = now_iso();
    let result = state.with_space(&space_id, |conn| {
        let updated = conn.execute(
            "UPDATE worlds SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.name, input.description, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::WorldNotFound(id.clone()));
        }
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at, image_blob IS NOT NULL AS has_image FROM worlds WHERE id = ?1",
            params![id],
            row_to_world,
        )
        .map_err(DbError::Sqlite)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(&app, "world", Some(entity.id.clone()), &space_id, None);
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_world(
    space_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    // 1. Delete from the Space's registry first — any concurrent with_world()
    //    will fail at path resolution with WorldNotFound before opening a new
    //    connection.
    let db_path = state.with_space(&space_id, |conn| {
        let path = conn.query_row(
            "SELECT db_path FROM worlds WHERE id = ?1",
            params![&id],
            |row| row.get::<_, String>(0),
        );
        match path {
            Ok(p) => {
                conn.execute("DELETE FROM worlds WHERE id = ?1", params![&id])?;
                Ok(p)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Err(DbError::WorldNotFound(id.clone())),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    })?;

    // 2. Close the cached world connection (idempotent).
    state.close_world(&id);

    // 3. Best-effort file deletion (WAL/SHM sidecars may linger briefly on Windows).
    let full_path = state
        .data_dir()
        .join("spaces")
        .join(&space_id)
        .join(&db_path);
    let _ = std::fs::remove_file(&full_path);
    let _ = std::fs::remove_file(format!("{}-wal", full_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", full_path.display()));

    emit_entity_changed(&app, "world", Some(id.clone()), &space_id, None);
    Ok(())
}

// ─── World cover image (space.db registry) ──────────────────────────────────
//
// World rows live in each Space's `space.db` (ADR-0007), so these three
// commands route through `with_space` (NOT `with_world` — that would resolve
// to a per-World content file). The World IS the world; there is no separate
// `world_id` param. The `image_blob` / `image_mime` columns are added by
// `SPACE_MIGRATION_004`; the regular `World` struct + `list_worlds` /
// `get_world` queries do NOT touch them (avoids a serde Vec<u8> → JSON-number-
// array encoding trap and keeps the world-list payload light).
//
// Logging (ADR-0014 / ADR-0016): only metadata (entity_id, byte length, mime)
// is ever logged — the bytes themselves are creative content. update + clear
// are INFO; get is DEBUG because it fires on every World card render.

#[tracing::instrument(
    skip(state, image_base64, app),
    fields(entity_id = %id)
)]
#[tauri::command]
pub fn update_world_image(
    space_id: String,
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
    let result = state.with_space(&space_id, |conn| {
        let updated = conn.execute(
            "UPDATE worlds SET image_blob = ?1, image_mime = ?2, updated_at = ?3 WHERE id = ?4",
            params![&bytes, &image_mime, now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::WorldNotFound(id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(&app, "world", Some(id.clone()), &space_id, None);
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn clear_world_image(
    space_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    let now = now_iso();
    tracing::info!(entity_id = %id, "image cleared");
    let result = state.with_space(&space_id, |conn| {
        let updated = conn.execute(
            "UPDATE worlds SET image_blob = NULL, image_mime = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::WorldNotFound(id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(&app, "world", Some(id.clone()), &space_id, None);
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_world_image(
    space_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<tauri::ipc::Response, DbError> {
    tracing::debug!(entity_id = %id, "image fetched");
    let bytes: Option<Vec<u8>> = state.with_space(&space_id, |conn| {
        conn.query_row(
            "SELECT image_blob FROM worlds WHERE id = ?1",
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
