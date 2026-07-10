use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::db::error::DbError;
use crate::db::migrations::{META_MIGRATIONS, WORLD_MIGRATIONS};

/// Central database manager.
///
/// Owns:
/// - `meta.db` connection (always open) — world registry + app settings
/// - A cache of open world DB connections (opened lazily on first access)
/// - The data directory path (for constructing world DB file paths)
///
/// World DB connections are cached in `worlds`. Once a world is opened,
/// subsequent operations reuse the connection without re-querying meta.db.
/// All world operations are serialized via the `worlds` Mutex — acceptable
/// for a single-user desktop app where SQLite ops are sub-millisecond.
pub struct DbManager {
    meta: Mutex<Connection>,
    worlds: Mutex<HashMap<String, Connection>>,
    data_dir: PathBuf,
}

impl DbManager {
    /// Initialize the manager: open meta.db, run migrations, create worlds/ dir.
    pub fn new(data_dir: PathBuf) -> Result<Self, DbError> {
        let meta_path = data_dir.join("meta.db");
        let mut meta = Connection::open(&meta_path)?;
        meta.execute_batch("PRAGMA foreign_keys = ON;")?;
        META_MIGRATIONS.to_latest(&mut meta)?;

        Ok(Self {
            meta: Mutex::new(meta),
            worlds: Mutex::new(HashMap::new()),
            data_dir,
        })
    }

    /// Look up a world's DB file path from the meta registry.
    fn world_db_path(&self, world_id: &str) -> Result<PathBuf, DbError> {
        let meta = self.meta.lock().unwrap();
        let db_path: String = meta
            .query_row(
                "SELECT db_path FROM worlds WHERE id = ?1",
                rusqlite::params![world_id],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DbError::WorldNotFound(world_id.to_string())
                }
                other => DbError::Sqlite(other),
            })?;
        Ok(self.data_dir.join(db_path))
    }

    /// Execute a closure with the meta.db connection.
    pub fn with_meta<F, R>(&self, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbError>,
    {
        let mut meta = self.meta.lock().unwrap();
        f(&mut meta)
    }

    /// Execute a closure with a world DB connection.
    ///
    /// Opens and caches the connection on first access (runs migrations).
    /// The connection stays cached until `close_world` is called.
    ///
    /// Lock ordering: resolves the DB path (acquiring `meta` lock) BEFORE
    /// acquiring the `worlds` lock. This prevents a `worlds → meta` lock
    /// dependency that could deadlock if any future `with_meta` callback
    /// calls `with_world`.
    pub fn with_world<F, R>(&self, world_id: &str, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbError>,
    {
        // Fast path: connection already cached
        {
            let mut worlds = self.worlds.lock().unwrap();
            if let Some(conn) = worlds.get_mut(world_id) {
                return f(conn);
            }
        }

        // Slow path: resolve path (meta lock acquired + released here)
        let path = self.world_db_path(world_id)?;
        let mut worlds = self.worlds.lock().unwrap();
        // Re-check: another thread may have inserted while we were unlocked
        if !worlds.contains_key(world_id) {
            let mut conn = Connection::open(&path)?;
            conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
            WORLD_MIGRATIONS.to_latest(&mut conn)?;
            worlds.insert(world_id.to_string(), conn);
        }
        let conn = worlds.get_mut(world_id).unwrap();
        f(conn)
    }

    /// Remove a world connection from the cache (used on world delete).
    pub fn close_world(&self, world_id: &str) {
        let mut worlds = self.worlds.lock().unwrap();
        worlds.remove(world_id);
    }

    /// Get the data directory (for constructing world DB file paths).
    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }
}
