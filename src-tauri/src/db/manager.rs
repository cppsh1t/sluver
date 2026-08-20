use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::db::error::DbError;
use crate::db::migrations::{META_MIGRATIONS, SPACE_MIGRATIONS, WORLD_MIGRATIONS};

/// Per-Space cached state: the `space.db` connection plus a nested cache of
/// that Space's open World content connections.
///
/// Nesting the world cache inside the space cache is what makes the lock
/// ordering in ADR-0007 trivially safe: a single `spaces` lock guards both
/// tiers, so the only multi-lock sequence the manager ever performs is
/// `meta` (acquire → release) followed later by `spaces` (acquire → release).
/// There is no separate `worlds` lock that could be acquired in the wrong
/// order — the nested design eliminates the `spaces → worlds` vs
/// `worlds → spaces` hazard that a flat two-lock design would create.
struct SpaceConn {
    /// `spaces/{spaceId}/space.db` connection (this Space's world registry +
    /// `space_config` KV per ADR-0007).
    conn: Connection,
    /// Cached World content connections (`spaces/{spaceId}/worlds/{worldId}.db`),
    /// keyed by `world_id`. Opened lazily on first `with_world`.
    worlds: HashMap<String, Connection>,
}

/// Central database manager for the three-tier layout (ADR-0007).
///
/// Owns:
/// - `meta.db` (always open) — the Space registry + global app settings.
/// - A cache of open `space.db` connections, each with its own nested cache
///   of World content connections.
/// - The data directory path (for constructing Space/World DB file paths).
///
/// Lock ordering invariant (ADR-0007): "resolve any path via the outer lock,
/// release it, then acquire the inner cache lock". With the nested cache
/// design there is only ever ONE lock (`spaces`) acquired for space/world
/// operations, so the invariant holds trivially — there is no second lock
/// to acquire in the wrong order. The `meta` lock is only ever acquired
/// alone (never while holding `spaces`).
pub struct DbManager {
    meta: Mutex<Connection>,
    spaces: Mutex<HashMap<String, SpaceConn>>,
    data_dir: PathBuf,
}

impl DbManager {
    /// Initialize the manager: open `meta.db`, run `META_MIGRATIONS`, and
    /// create the `spaces/` container directory.
    pub fn new(data_dir: PathBuf) -> Result<Self, DbError> {
        tracing::info!(data_dir = ?data_dir, "DbManager initializing");

        let meta_path = data_dir.join("meta.db");
        let mut meta = Connection::open(&meta_path)?;
        meta.execute_batch("PRAGMA foreign_keys = ON;")?;
        tracing::info!(db = "meta", path = %meta_path.display(), "opened meta.db");
        tracing::info!(db_kind = "meta", "applying migrations");
        META_MIGRATIONS.to_latest(&mut meta)?;
        tracing::debug!(db_kind = "meta", "migrations applied");

        std::fs::create_dir_all(data_dir.join("spaces"))?;

        tracing::info!(data_dir = ?data_dir, "DbManager initialized");
        Ok(Self {
            meta: Mutex::new(meta),
            spaces: Mutex::new(HashMap::new()),
            data_dir,
        })
    }

    // ─── pure path helpers (no locks) ──────────────────────────────────────

    /// Validate that `id` is a UUID-shaped string (8-4-4-4-12 hex digits,
    /// 36 chars total). This is a SHAPE check only — sufficient to reject
    /// path-traversal attempts (e.g. "../../foo") and other malformed ids
    /// that are used in filesystem path construction. The version nibble is
    /// NOT validated; that is a concern of the id generator, not the consumer.
    pub fn validate_id(id: &str) -> Result<(), DbError> {
        // UUID shape: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        // 32 hex digits + 4 dashes = 36 chars.
        if id.len() != 36 {
            return Err(DbError::InvalidInput(format!(
                "invalid id length ({}): {}",
                id.len(),
                id
            )));
        }
        for (i, c) in id.chars().enumerate() {
            let expect_dash = matches!(i, 8 | 13 | 18 | 23);
            if expect_dash {
                if c != '-' {
                    return Err(DbError::InvalidInput(format!(
                        "invalid id format (expected '-' at position {i}): {id}"
                    )));
                }
            } else if !c.is_ascii_hexdigit() {
                return Err(DbError::InvalidInput(format!(
                    "invalid id format (non-hex '{c}' at position {i}): {id}"
                )));
            }
        }
        Ok(())
    }

    /// `data_dir/spaces/{space_id}`.
    fn space_dir(&self, space_id: &str) -> PathBuf {
        self.data_dir.join("spaces").join(space_id)
    }

    /// `data_dir/spaces/{space_id}/space.db`.
    fn space_db_path(&self, space_id: &str) -> PathBuf {
        self.space_dir(space_id).join("space.db")
    }

    /// `data_dir/spaces/{space_id}` — the Space's data directory. Used as
    /// the default cwd for agent shell execution (ADR-0041). Same path
    /// convention as [`Self::space_db_path`] (single source of truth for
    /// Space paths): pure construction, no locks, no existence guarantee.
    pub fn space_data_dir(&self, space_id: &str) -> PathBuf {
        self.space_dir(space_id)
    }

    /// `data_dir/spaces/{space_id}/{relative}` where `relative` is the
    /// `db_path` column from this Space's `worlds` table (e.g.
    /// `"worlds/{worldId}.db"` — relative to the Space dir per ADR-0007).
    fn world_db_path(&self, space_id: &str, relative: &str) -> PathBuf {
        self.space_dir(space_id).join(relative)
    }

    /// Resolve the absolute filesystem path of a World's `.db` content file
    /// by looking up its `db_path` in this Space's registry (`space.db`) and
    /// joining with `data_dir/spaces/{space_id}/`.
    ///
    /// Used by `export_world` to locate the file to checkpoint + read after
    /// the WAL has been folded in. Single-lock operation (only `spaces`):
    /// the lock is released before the caller does any file I/O. The `meta`
    /// lock is never acquired.
    pub fn world_db_file_path(&self, space_id: &str, world_id: &str) -> Result<PathBuf, DbError> {
        let relative = self.with_space(space_id, |conn| {
            conn.query_row(
                "SELECT db_path FROM worlds WHERE id = ?1",
                rusqlite::params![world_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DbError::WorldNotFound(world_id.to_string())
                }
                other => DbError::Sqlite(other),
            })
        })?;
        Ok(self.space_dir(space_id).join(relative))
    }

    /// Opens a fresh `space.db` connection at the conventional path, applies
    /// `SPACE_MIGRATIONS`, and returns it. Does NOT touch the cache. Defensively
    /// creates the parent `spaces/{space_id}/` dir so first-open of a
    /// freshly-created Space succeeds.
    fn open_space_conn_inner(&self, space_id: &str) -> Result<Connection, DbError> {
        let path = self.space_db_path(space_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        tracing::info!(
            db = "space",
            space_id = %space_id,
            path = %path.display(),
            "opened space.db"
        );
        tracing::info!(db_kind = "space", space_id = %space_id, "applying migrations");
        SPACE_MIGRATIONS.to_latest(&mut conn)?;
        tracing::debug!(db_kind = "space", space_id = %space_id, "migrations applied");
        Ok(conn)
    }

    // ─── closure entry points ──────────────────────────────────────────────

    /// Execute a closure with the `meta.db` connection.
    ///
    /// Single-lock operation (only `meta` is acquired). Never call this while
    /// holding the `spaces` lock — that would violate ADR-0007's lock ordering.
    pub fn with_meta<F, R>(&self, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbError>,
    {
        tracing::debug!(db = "meta", "acquiring meta connection");
        let mut meta = self.meta.lock().unwrap();
        f(&mut meta)
    }

    /// Execute a closure with a Space's `space.db` connection. Opens + caches
    /// on first access (runs `SPACE_MIGRATIONS`).
    ///
    /// Lock ordering (ADR-0007): single-lock — only `spaces` is acquired for
    /// the entire open-if-needed + run-closure sequence. Path resolution is
    /// convention-based (`data_dir/spaces/{space_id}/space.db`) so no `meta`
    /// lock is required.
    pub fn with_space<F, R>(&self, space_id: &str, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbError>,
    {
        tracing::debug!(db = "space", space_id = %space_id, "acquiring space connection");
        Self::validate_id(space_id)?;
        let mut spaces = self.spaces.lock().unwrap();
        tracing::trace!(db = "space", space_id = %space_id, "spaces lock acquired");
        if !spaces.contains_key(space_id) {
            let conn = self.open_space_conn_inner(space_id)?;
            spaces.insert(
                space_id.to_string(),
                SpaceConn {
                    conn,
                    worlds: HashMap::new(),
                },
            );
        }
        let space_conn = spaces.get_mut(space_id).expect("inserted above");
        f(&mut space_conn.conn)
    }

    /// Execute a closure with a World content DB connection. Opens + caches
    /// on first access (runs `WORLD_MIGRATIONS`).
    ///
    /// **New signature `(space_id, world_id, …)`** — the world's `db_path` is
    /// resolved by querying this Space's `space.db`, which is already cached
    /// inside the parent `SpaceConn`.
    ///
    /// Lock ordering (ADR-0007): single-lock — only `spaces` is acquired for
    /// the entire ensure-space + resolve-path + open-world + run-closure
    /// sequence. The nested cache design means both the Space's registry conn
    /// and the World content conn live under one lock, so there is no
    /// `spaces → worlds` hazard. The `meta` lock is never acquired here
    /// (per ADR-0007 the worlds registry moved out of `meta.db` into
    /// `space.db`).
    pub fn with_world<F, R>(&self, space_id: &str, world_id: &str, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbError>,
    {
        tracing::debug!(
            db = "world",
            space_id = %space_id,
            world_id = %world_id,
            "acquiring world connection"
        );
        Self::validate_id(space_id)?;
        Self::validate_id(world_id)?;
        let mut spaces = self.spaces.lock().unwrap();
        tracing::trace!(
            db = "world",
            space_id = %space_id,
            world_id = %world_id,
            "spaces lock acquired"
        );

        // Ensure the parent SpaceConn exists (opens space.db if needed).
        if !spaces.contains_key(space_id) {
            let conn = self.open_space_conn_inner(space_id)?;
            spaces.insert(
                space_id.to_string(),
                SpaceConn {
                    conn,
                    worlds: HashMap::new(),
                },
            );
        }
        let space_conn = spaces.get_mut(space_id).expect("inserted above");

        // Resolve db_path from space.db + open the world conn if not cached.
        if !space_conn.worlds.contains_key(world_id) {
            let relative: String = space_conn
                .conn
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
            let path = self.world_db_path(space_id, &relative);
            let mut conn = Connection::open(&path)?;
            conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
            tracing::info!(
                db = "world",
                space_id = %space_id,
                world_id = %world_id,
                path = %path.display(),
                "opened world db"
            );
            tracing::info!(
                db_kind = "world",
                space_id = %space_id,
                world_id = %world_id,
                "applying migrations"
            );
            WORLD_MIGRATIONS.to_latest(&mut conn)?;
            tracing::debug!(
                db_kind = "world",
                space_id = %space_id,
                world_id = %world_id,
                "migrations applied"
            );
            space_conn.worlds.insert(world_id.to_string(), conn);
        }

        let world_conn = space_conn.worlds.get_mut(world_id).expect("inserted above");
        f(world_conn)
    }

    // ─── connection-lifecycle helpers ──────────────────────────────────────
    //
    // These manage ONLY the connection cache. Persisted session state
    // (`lastOpenedSpaceId` / `lockedSpaceIds` in `meta.db` settings KV,
    // post-ADR-0011) is owned by the session command layer, not here.

    /// Ensure the Space's `space.db` connection is cached (idempotent — no-op
    /// if already open). Used by the session layer (T12) when opening a Space
    /// to warm the cache after successful password verification.
    pub fn open_space_conn(&self, space_id: &str) -> Result<(), DbError> {
        let mut spaces = self.spaces.lock().unwrap();
        if !spaces.contains_key(space_id) {
            let conn = self.open_space_conn_inner(space_id)?;
            spaces.insert(
                space_id.to_string(),
                SpaceConn {
                    conn,
                    worlds: HashMap::new(),
                },
            );
        }
        Ok(())
    }

    /// Drop a Space's cached `space.db` AND all its cached World content
    /// connections. Idempotent (no-op if the Space isn't cached). Called by
    /// the window-event router in `lib.rs` when a Space window is destroyed
    /// (ADR-0011) and by `commands::space::do_delete_space` during the
    /// deletion cascade.
    ///
    /// Single-lock operation (only `spaces`). The nested design means
    /// removing one `SpaceConn` entry drops both the space.db conn and every
    /// world conn in one go.
    pub fn close_space(&self, space_id: &str) {
        tracing::info!(db_kind = "space", space_id = %space_id, "closed space.db connections");
        let mut spaces = self.spaces.lock().unwrap();
        spaces.remove(space_id);
    }

    /// Drop a Space's cached connections so that re-opening requires re-auth.
    /// At the connection-cache level this is equivalent to `close_space` —
    /// both release the cached conns so the next `open_space` must re-verify
    /// the password (T12) and re-open `space.db`. The session-state side
    /// (adding to `lockedSpaceIds`) is T12's responsibility.
    pub fn lock_space(&self, space_id: &str) {
        self.close_space(space_id);
    }

    /// Drop a single World's cached connection (used on world delete).
    /// Searches every cached Space for the `world_id` — acceptable cost
    /// since this is called rarely (only on `delete_world`).
    pub fn close_world(&self, world_id: &str) {
        let mut spaces = self.spaces.lock().unwrap();
        for space_conn in spaces.values_mut() {
            space_conn.worlds.remove(world_id);
        }
    }

    /// Get the data directory.
    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }
}

#[cfg(test)]
#[path = "tests/manager.rs"]
mod stress_tests;
