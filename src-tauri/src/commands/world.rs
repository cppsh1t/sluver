use std::io::Read;

use rusqlite::params;
use serde::{Deserialize, Serialize};
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

// ─── World export / import (.sluver-world zip archive) ──────────────────────
//
// Cross-computer world transfer via a single self-contained file:
//
//   my-world.sluver-world (zip)
//   ├── manifest.json   # metadata + schema version
//   └── world.db        # WAL-checkpointed, self-contained SQLite file
//
// The world's content DB is checkpointed (WAL folded into the main file)
// before reading so the recipient gets a fully-consistent snapshot without
// needing the `-wal`/`-shm` sidecars. On import the `.db` is run through
// `WORLD_MIGRATIONS` so a file exported from an older app version migrates
// forward transparently (source schema ≤ target → migrates up; already-
// latest → no-op).
//
// Logging (ADR-0014 / ADR-0016): only structural metadata (entity_id,
// output_bytes, duration_ms, overwrite flag) is ever logged. World name /
// description / cover image / creative content NEVER appear in any field
// (AGENTS.md "❌ NEVER log" tier).

/// Format version of the `.sluver-world` export archive. Increment when the
/// manifest schema or archive layout changes in a backwards-incompatible way.
/// On import, a `format_version` higher than this constant is rejected as
/// `WORLD_IMPORT_CORRUPT_FILE`.
const WORLD_EXPORT_FORMAT_VERSION: u32 = 1;

/// Top-level manifest written to `manifest.json` inside the archive.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorldManifest {
    format_version: u32,
    app_version: String,
    exported_at: String,
    world: ManifestWorld,
}

/// World registry snapshot embedded in the manifest. Mirrors the `worlds`
/// table columns (id, name, description, created_at, updated_at) plus an
/// optional cover image (encoded as base64 so the manifest stays pure JSON).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestWorld {
    id: String,
    name: String,
    description: String,
    created_at: String,
    updated_at: String,
    /// `null` when the world has no cover image; otherwise the base64-encoded
    /// bytes + MIME. `#[serde(default)]` so a missing key deserializes to
    /// `None` (forwards-compat with future fields).
    #[serde(default)]
    image: Option<ManifestImage>,
}

/// Cover image payload inside the manifest. The bytes are base64-encoded so
/// the entire manifest is plain JSON (no binary mixed in).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestImage {
    blob_base64: String,
    mime: String,
}

/// Write a `.sluver-world` zip archive containing `manifest.json` +
/// `world.db`. Extracted from [`export_world`] so the success-path lock
/// structure stays readable. Any error returned is mapped to
/// [`DbError::WorldExportFailed`]; the caller is responsible for removing
/// the partial output file.
fn build_world_export_zip(
    output_path: &str,
    manifest_bytes: &[u8],
    db_bytes: &[u8],
) -> Result<(), DbError> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let file = std::fs::File::create(output_path)
        .map_err(|e| DbError::WorldExportFailed(format!("create output: {e}")))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("manifest.json", options)
        .map_err(|e| DbError::WorldExportFailed(format!("manifest entry: {e}")))?;
    zip.write_all(manifest_bytes)
        .map_err(|e| DbError::WorldExportFailed(format!("write manifest: {e}")))?;

    zip.start_file("world.db", options)
        .map_err(|e| DbError::WorldExportFailed(format!("db entry: {e}")))?;
    zip.write_all(db_bytes)
        .map_err(|e| DbError::WorldExportFailed(format!("write db: {e}")))?;

    zip.finish()
        .map_err(|e| DbError::WorldExportFailed(format!("zip finish: {e}")))?;
    Ok(())
}

/// Export a World to a `.sluver-world` zip archive at `output_path`.
///
/// Flow:
///   1. WAL-checkpoint the world DB (TRUNCATE) so the exported snapshot is
///      self-contained (no `-wal`/`-shm` sidecars needed).
///   2. Read the world registry row (name, description, timestamps, cover
///      image) from `space.db`.
///   3. Read the checkpointed `.db` bytes from disk.
///   4. Build + serialize the manifest.
///   5. Write the zip (manifest.json + world.db). On any failure after the
///      file is created, the partial output is removed.
///
/// Lock structure mirrors `export_novel` / `export_logs`: the DB lock is
/// held only for the checkpoint + registry read; all file I/O happens after
/// release.
#[tracing::instrument(skip(state), fields(entity_id = %world_id))]
#[tauri::command]
pub fn export_world(
    space_id: String,
    world_id: String,
    output_path: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    let start = std::time::Instant::now();

    // 1. Fold the WAL into the main .db so the exported file is
    //    self-contained. `with_world` resolves + caches the connection; the
    //    lock is released when the closure returns, before any file I/O.
    state.with_world(&space_id, &world_id, |conn| {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|e| DbError::WorldExportFailed(format!("wal checkpoint: {e}")))?;
        Ok(())
    })?;

    // 2. Read the registry row (metadata + cover image) in ONE query. The
    //    `.db` file path is resolved separately via the dedicated helper so
    //    the metadata query stays focused on registry columns.
    let (name, description, created_at, updated_at, image_blob, image_mime) =
        state.with_space(&space_id, |conn| {
            conn.query_row(
                "SELECT name, description, created_at, updated_at, image_blob, image_mime
                 FROM worlds WHERE id = ?1",
                params![&world_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<Vec<u8>>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::WorldNotFound(world_id.clone()),
                other => DbError::Sqlite(other),
            })
        })?;

    // 3. Resolve the full path + read the checkpointed bytes. The lock is
    //    NOT held here (pure file I/O after release).
    let db_full_path = state.world_db_file_path(&space_id, &world_id)?;
    let db_bytes = std::fs::read(&db_full_path)
        .map_err(|e| DbError::WorldExportFailed(format!("read db file: {e}")))?;

    // 4. Build the manifest. Cover image is included iff BOTH blob + mime
    //    are present (mirrors the `export_novel` cover handling).
    let image = match (image_blob, image_mime) {
        (Some(bytes), Some(mime)) => {
            use base64::Engine as _;
            Some(ManifestImage {
                blob_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                mime,
            })
        }
        _ => None,
    };
    let manifest = WorldManifest {
        format_version: WORLD_EXPORT_FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: now_iso(),
        world: ManifestWorld {
            id: world_id.clone(),
            name,
            description,
            created_at,
            updated_at,
            image,
        },
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| DbError::WorldExportFailed(format!("serialize manifest: {e}")))?;

    // 5. Write the zip. On any failure after creation, remove the partial
    //    output file so the user never finds a truncated archive.
    let zip_result = build_world_export_zip(&output_path, manifest_json.as_bytes(), &db_bytes);
    if let Err(e) = zip_result {
        let _ = std::fs::remove_file(&output_path);
        return Err(e);
    }

    // 6. Success — structural metadata only (AGENTS.md red line: no name,
    //    no description, no image bytes).
    let output_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let duration_ms = start.elapsed().as_millis();
    tracing::info!(space_id = %space_id, output_bytes, duration_ms, "world.exported");

    Ok(())
}

/// Resolve a unique world name within a Space, appending `" (n)"` suffixes if
/// the desired name is already taken by a different world.
///
/// `exclude_id` skips a world's own row — used on the overwrite path where
/// the row will be UPDATEd, so its own name slot doesn't count as a collision
/// against itself. On the new-import path `exclude_id` is `None` (the name is
/// checked against every existing world).
fn resolve_unique_name(
    conn: &rusqlite::Connection,
    desired: &str,
    exclude_id: Option<&str>,
) -> Result<String, DbError> {
    use rusqlite::OptionalExtension;

    /// `true` iff some world (other than `exclude_id`) already owns `name`.
    fn name_taken(
        conn: &rusqlite::Connection,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<bool, DbError> {
        let exists: Option<()> = match exclude_id {
            Some(excl) => conn
                .query_row(
                    "SELECT 1 FROM worlds WHERE name = ?1 AND id != ?2 LIMIT 1",
                    params![name, excl],
                    |_| Ok(()),
                )
                .optional()?,
            None => conn
                .query_row(
                    "SELECT 1 FROM worlds WHERE name = ?1 LIMIT 1",
                    params![name],
                    |_| Ok(()),
                )
                .optional()?,
        };
        Ok(exists.is_some())
    }

    if !name_taken(conn, desired, exclude_id)? {
        return Ok(desired.to_string());
    }
    // Try "Name (2)", "Name (3)", … until a free slot is found. The loop is
    // bounded in practice by the number of same-named worlds in the Space.
    let mut n = 2u32;
    loop {
        let candidate = format!("{desired} ({n})");
        if !name_taken(conn, &candidate, exclude_id)? {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// Import a World from a `.sluver-world` zip archive at `input_path`.
///
/// Flow:
///   1. Open + parse the archive (`manifest.json` + `world.db`).
///   2. Validate `format_version` (reject futures as corrupt).
///   3. Check whether the manifest's world id already exists in this Space:
///      - exists + `overwrite=false` → `WorldImportAlreadyExists` (frontend
///        confirms, retries with `overwrite=true`).
///      - exists + `overwrite=true` → replace the `.db` file + UPDATE the row.
///      - doesn't exist → always create new (regardless of `overwrite`).
///   4. Resolve a unique name (suffix collisions with a DIFFERENT world).
///   5. Close any cached world connection (overwrite path) so the `.db` file
///      can be replaced, then write the new bytes.
///   6. Run `WORLD_MIGRATIONS` on the new `.db` (forward-compat).
///   7. INSERT or UPDATE the registry row in `space.db` (with decoded cover
///      image if present), then read back the full `World`.
///   8. Emit `entity-changed` so the frontend refreshes its caches.
///
/// Returns the imported `World` so the frontend can navigate to it.
#[tracing::instrument(skip(state, app), fields(entity_id))]
#[tauri::command]
pub fn import_world(
    space_id: String,
    input_path: String,
    overwrite: bool,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<World, DbError> {
    let start = std::time::Instant::now();

    // 1. Open + parse the archive.
    let file = std::fs::File::open(&input_path)
        .map_err(|e| DbError::WorldImportFailed(format!("open file: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| DbError::WorldImportCorruptFile(format!("not a valid archive: {e}")))?;

    // 2. Extract + parse manifest.json.
    let manifest: WorldManifest = {
        let mut manifest_entry = archive
            .by_name("manifest.json")
            .map_err(|e| DbError::WorldImportCorruptFile(format!("missing manifest.json: {e}")))?;
        let mut buf = Vec::new();
        manifest_entry
            .read_to_end(&mut buf)
            .map_err(|e| DbError::WorldImportCorruptFile(format!("read manifest: {e}")))?;
        serde_json::from_slice(&buf)
            .map_err(|e| DbError::WorldImportCorruptFile(format!("parse manifest: {e}")))?
    };

    // 3. Reject format versions from a newer build (we can't read the future).
    if manifest.format_version > WORLD_EXPORT_FORMAT_VERSION {
        return Err(DbError::WorldImportCorruptFile(format!(
            "unsupported format version {} (this build supports up to {})",
            manifest.format_version, WORLD_EXPORT_FORMAT_VERSION
        )));
    }

    // Validate the manifest's world id BEFORE it touches the filesystem or
    // the registry. `manifest.world.id` is used to construct
    // `worlds/{id}.db` — an unvalidated value (e.g. "../../foo") is a path-
    // traversal vector. This is the same UUID-shape guard `with_space` /
    // `with_world` apply to their id params, but import_world bypasses those
    // helpers when writing the .db file directly.
    DbManager::validate_id(&manifest.world.id).map_err(|_| {
        DbError::WorldImportCorruptFile("manifest contains an invalid world id".to_string())
    })?;

    // Record the entity_id now that we've parsed the manifest (the command's
    // `#[instrument]` declared `entity_id` without a value).
    tracing::Span::current().record("entity_id", manifest.world.id.as_str());

    // 4. Extract world.db bytes.
    let db_bytes: Vec<u8> = {
        let mut db_entry = archive
            .by_name("world.db")
            .map_err(|e| DbError::WorldImportCorruptFile(format!("missing world.db: {e}")))?;
        let mut buf = Vec::new();
        db_entry
            .read_to_end(&mut buf)
            .map_err(|e| DbError::WorldImportCorruptFile(format!("read world.db: {e}")))?;
        buf
    };

    // 5. Does the manifest's world id already exist in this Space?
    let existing: Option<String> = state.with_space(&space_id, |conn| {
        let result = conn.query_row(
            "SELECT name FROM worlds WHERE id = ?1",
            params![&manifest.world.id],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(name) => Ok(Some(name)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    })?;

    // 6. Branch: exists + !overwrite → error; exists + overwrite → replace;
    //    !exists → create new.
    let is_overwrite = match existing {
        Some(ref name) if !overwrite => {
            return Err(DbError::WorldImportAlreadyExists {
                id: manifest.world.id.clone(),
                existing_name: name.clone(),
            });
        }
        Some(_) => true,
        None => false,
    };

    // 7. Resolve a unique name. On overwrite, exclude the world's own row
    //    (it's about to be UPDATEd, so its own name slot is free for itself).
    let exclude_id = if is_overwrite {
        Some(manifest.world.id.as_str())
    } else {
        None
    };
    let final_name =
        state.with_space(&space_id, |conn| {
            resolve_unique_name(conn, &manifest.world.name, exclude_id)
        })?;

    // 8. Close any cached world connection so the .db file can be replaced
    //    (mirrors delete_world). Idempotent — no-op if nothing is cached.
    if is_overwrite {
        state.close_world(&manifest.world.id);
    }

    // 9. Write the .db file to disk.
    let world_dir = state
        .data_dir()
        .join("spaces")
        .join(&space_id)
        .join("worlds");
    std::fs::create_dir_all(&world_dir)
        .map_err(|e| DbError::WorldImportFailed(format!("create worlds dir: {e}")))?;
    let world_db_path = world_dir.join(format!("{}.db", manifest.world.id));

    if is_overwrite {
        // Best-effort deletion of old .db + WAL/SHM sidecars (Windows may
        // hold them briefly — mirrors delete_world).
        let _ = std::fs::remove_file(&world_db_path);
        let _ = std::fs::remove_file(format!("{}-wal", world_db_path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", world_db_path.display()));
    }

    std::fs::write(&world_db_path, &db_bytes)
        .map_err(|e| DbError::WorldImportFailed(format!("write world.db: {e}")))?;

    // 10. Run migrations on the new .db (forward-compat). Open a temporary
    //     connection, migrate, then drop it so DbManager re-caches on next
    //     `with_world` call. The connection is scoped so it's fully closed
    //     (WAL flushed) before the registry write below.
    {
        let mut conn = rusqlite::Connection::open(&world_db_path)
            .map_err(|e| DbError::WorldImportFailed(format!("open for migrate: {e}")))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(|e| DbError::WorldImportFailed(format!("pragma: {e}")))?;
        WORLD_MIGRATIONS
            .to_latest(&mut conn)
            .map_err(|e| DbError::WorldImportFailed(format!("migrate: {e}")))?;
        // Explicit close to flush WAL before the scoped drop (defensive on
        // Windows where file handles can linger). Surface failure rather than
        // silently dropping it — an unflushed WAL means the migration writes
        // may not have reached the main .db file.
        conn.close()
            .map_err(|(_, e)| DbError::WorldImportFailed(format!("close after migrate: {e}")))?;
    }

    // 11. Decode the cover image (if any) for the registry row.
    let (image_blob, image_mime): (Option<Vec<u8>>, Option<String>) =
        match &manifest.world.image {
            Some(img) => {
                // Reuse the single-sourced validator so import enforces the
                // same MIME allowlist (webp/jpeg/png) + 1 MiB ceiling as every
                // `update_*_image` command. A crafted archive with an oversized
                // or off-MIME blob is rejected as INVALID_IMAGE.
                let bytes = decode_and_validate_image(&img.blob_base64, &img.mime)?;
                (Some(bytes), Some(img.mime.clone()))
            }
            None => (None, None),
        };

    // 12. Insert or update the registry row, then read back the full World.
    //     The manifest's created_at/updated_at are preserved so the imported
    //     world retains its original content timeline.
    let world_id = manifest.world.id.clone();
    let result = state.with_space(&space_id, |conn| {
        if is_overwrite {
            let updated = conn.execute(
                "UPDATE worlds
                 SET name = ?2, description = ?3, created_at = ?4, updated_at = ?5,
                     image_blob = ?6, image_mime = ?7
                 WHERE id = ?1",
                params![
                    &world_id,
                    &final_name,
                    &manifest.world.description,
                    &manifest.world.created_at,
                    &manifest.world.updated_at,
                    &image_blob,
                    &image_mime,
                ],
            )?;
            if updated == 0 {
                return Err(DbError::WorldNotFound(world_id.clone()));
            }
        } else {
            let db_path = format!("worlds/{world_id}.db");
            conn.execute(
                "INSERT INTO worlds
                    (id, name, description, db_path, created_at, updated_at, image_blob, image_mime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    &world_id,
                    &final_name,
                    &manifest.world.description,
                    &db_path,
                    &manifest.world.created_at,
                    &manifest.world.updated_at,
                    &image_blob,
                    &image_mime,
                ],
            )?;
        }
        // Read back the final row (has_image computed column included).
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at,
                    image_blob IS NOT NULL AS has_image
             FROM worlds WHERE id = ?1",
            params![&world_id],
            row_to_world,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::WorldNotFound(world_id.clone()),
            other => DbError::Sqlite(other),
        })
    });

    let world = match result {
        Ok(w) => w,
        Err(e) => {
            // Best-effort cleanup of the written .db on registry failure
            // (only on the new-import path — overwrite left an existing row
            // that should stay even if the UPDATE failed).
            if !is_overwrite {
                let _ = std::fs::remove_file(&world_db_path);
                let _ = std::fs::remove_file(format!("{}-wal", world_db_path.display()));
                let _ = std::fs::remove_file(format!("{}-shm", world_db_path.display()));
            }
            return Err(e);
        }
    };

    // 13. Emit entity-changed so the frontend invalidates its caches
    //     (same event create_world / update_world use).
    emit_entity_changed(&app, "world", Some(world.id.clone()), &space_id, None);

    let duration_ms = start.elapsed().as_millis();
    tracing::info!(space_id = %space_id, overwrite = is_overwrite, duration_ms, "world.imported");

    Ok(world)
}
