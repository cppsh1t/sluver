use rusqlite::params;
use tauri::State;

use crate::db::migrations::WORLD_MIGRATIONS;
use crate::db::{DbError, DbManager};
use crate::models::config::{AppConfig, Appearance};
use crate::models::world::{CreateWorldInput, UpdateWorldInput, World};
use crate::util::{new_id, now_iso};

// ─── helpers ────────────────────────────────────────────────────────────────

fn row_to_world(row: &rusqlite::Row) -> rusqlite::Result<World> {
    Ok(World {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ─── World CRUD (meta.db) ───────────────────────────────────────────────────

#[tauri::command]
pub fn create_world(input: CreateWorldInput, state: State<'_, DbManager>) -> Result<World, DbError> {
    let id = new_id();
    let now = now_iso();
    let db_path = format!("worlds/{id}.db");

    // 1. Create the world DB file and run migrations
    let full_path = state.data_dir().join(&db_path);
    {
        let mut conn = rusqlite::Connection::open(&full_path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        WORLD_MIGRATIONS.to_latest(&mut conn)?;
    }

    // 2. Insert into meta.db registry (clean up DB file on failure)
    state.with_meta(|conn| {
        conn.execute(
            "INSERT INTO worlds (id, name, description, db_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, input.name, input.description, db_path, now, now],
        )?;
        Ok(())
    })
    .inspect_err(|_e| {
        // Meta insert failed — remove the orphaned DB file + WAL/SHM sidecars
        let _ = std::fs::remove_file(&full_path);
        let _ = std::fs::remove_file(format!("{}-wal", full_path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", full_path.display()));
    })?;

    Ok(World {
        id,
        name: input.name,
        description: input.description,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub fn list_worlds(state: State<'_, DbManager>) -> Result<Vec<World>, DbError> {
    state.with_meta(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, created_at, updated_at FROM worlds ORDER BY created_at",
        )?;
        let worlds = stmt
            .query_map([], row_to_world)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(worlds)
    })
}

#[tauri::command]
pub fn get_world(id: String, state: State<'_, DbManager>) -> Result<World, DbError> {
    state.with_meta(|conn| {
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at FROM worlds WHERE id = ?1",
            params![id],
            row_to_world,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::WorldNotFound(id),
            other => DbError::Sqlite(other),
        })
    })
}

#[tauri::command]
pub fn update_world(
    id: String,
    input: UpdateWorldInput,
    state: State<'_, DbManager>,
) -> Result<World, DbError> {
    let now = now_iso();
    state.with_meta(|conn| {
        let updated = conn.execute(
            "UPDATE worlds SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.name, input.description, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::WorldNotFound(id));
        }
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at FROM worlds WHERE id = ?1",
            params![id],
            row_to_world,
        )
        .map_err(DbError::Sqlite)
    })
}

#[tauri::command]
pub fn delete_world(id: String, state: State<'_, DbManager>) -> Result<(), DbError> {
    // 1. Delete from registry first — any concurrent with_world() will fail at
    //    world_db_path() with WorldNotFound before opening a new connection.
    let db_path = state.with_meta(|conn| {
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

    // 2. Close the cached connection (mutex serialization guarantees no active
    //    operations are in progress on this world).
    state.close_world(&id);

    // 3. Best-effort file deletion (WAL/SHM sidecars may linger briefly on Windows)
    let full_path = state.data_dir().join(&db_path);
    let _ = std::fs::remove_file(&full_path);
    let _ = std::fs::remove_file(format!("{}-wal", full_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", full_path.display()));

    Ok(())
}

// ─── App Config (meta.db settings table) ────────────────────────────────────

#[tauri::command]
pub fn get_app_config(state: State<'_, DbManager>) -> Result<AppConfig, DbError> {
    state.with_meta(|conn| {
        let theme = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'appearance.theme'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "system".to_string());

        let color_theme = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'appearance.colorTheme'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "neutral".to_string());

        let locale = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app.locale'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "auto".to_string());

        Ok(AppConfig {
            appearance: Appearance { theme, color_theme },
            locale,
        })
    })
}

#[tauri::command]
pub fn update_app_config(
    config: AppConfig,
    state: State<'_, DbManager>,
) -> Result<AppConfig, DbError> {
    let theme = config.appearance.theme.clone();
    let color_theme = config.appearance.color_theme.clone();
    let locale = config.locale.clone();
    state.with_meta(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('appearance.theme', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![theme],
        )?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('appearance.colorTheme', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![color_theme],
        )?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app.locale', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![locale],
        )?;
        Ok(())
    })?;
    Ok(config)
}
