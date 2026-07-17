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
        let meta_path = data_dir.join("meta.db");
        let mut meta = Connection::open(&meta_path)?;
        meta.execute_batch("PRAGMA foreign_keys = ON;")?;
        META_MIGRATIONS.to_latest(&mut meta)?;

        std::fs::create_dir_all(data_dir.join("spaces"))?;

        Ok(Self {
            meta: Mutex::new(meta),
            spaces: Mutex::new(HashMap::new()),
            data_dir,
        })
    }

    // ─── pure path helpers (no locks) ──────────────────────────────────────

    /// `data_dir/spaces/{space_id}`.
    fn space_dir(&self, space_id: &str) -> PathBuf {
        self.data_dir.join("spaces").join(space_id)
    }

    /// `data_dir/spaces/{space_id}/space.db`.
    fn space_db_path(&self, space_id: &str) -> PathBuf {
        self.space_dir(space_id).join("space.db")
    }

    /// `data_dir/spaces/{space_id}/{relative}` where `relative` is the
    /// `db_path` column from this Space's `worlds` table (e.g.
    /// `"worlds/{worldId}.db"` — relative to the Space dir per ADR-0007).
    fn world_db_path(&self, space_id: &str, relative: &str) -> PathBuf {
        self.space_dir(space_id).join(relative)
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
        SPACE_MIGRATIONS.to_latest(&mut conn)?;
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
        let mut spaces = self.spaces.lock().unwrap();

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
            WORLD_MIGRATIONS.to_latest(&mut conn)?;
            space_conn.worlds.insert(world_id.to_string(), conn);
        }

        let world_conn = space_conn.worlds.get_mut(world_id).expect("inserted above");
        f(world_conn)
    }

    // ─── connection-lifecycle helpers ──────────────────────────────────────
    //
    // These manage ONLY the connection cache. Persisted session state
    // (openSpaceIds / activeSpaceId / lockedSpaceIds in meta.db settings KV)
    // is owned by the session command layer, not here.

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
    /// connections. Idempotent (no-op if the Space isn't cached). Used by
    /// the session layer's `close_space` command (T12) when the user closes
    /// a Space tab.
    ///
    /// Single-lock operation (only `spaces`). The nested design means
    /// removing one `SpaceConn` entry drops both the space.db conn and every
    /// world conn in one go.
    pub fn close_space(&self, space_id: &str) {
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
mod stress_tests {
    use super::*;
    use rusqlite::params;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    /// Bootstraps a DbManager with `num_spaces` Spaces, each registering
    /// `worlds_per_space` Worlds. The `space.db` + `world.db` files are
    /// created directly (bypassing commands) so the test doesn't depend on
    /// T11/T14 command wiring.
    fn bootstrap(
        num_spaces: usize,
        worlds_per_space: usize,
    ) -> (TempDir, Arc<DbManager>, Vec<(String, Vec<String>)>) {
        let tmp = TempDir::new().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let manager = Arc::new(DbManager::new(data_dir.clone()).expect("manager new"));

        let now = "2026-01-01T00:00:00.000Z";
        let mut layout = Vec::new();
        for s in 0..num_spaces {
            let space_id = format!("space-{s}");
            let space_dir = data_dir.join("spaces").join(&space_id);
            std::fs::create_dir_all(space_dir.join("worlds")).expect("space dir");

            let mut sconn = Connection::open(space_dir.join("space.db")).expect("open space.db");
            sconn
                .execute_batch("PRAGMA foreign_keys = ON;")
                .expect("space pragma");
            SPACE_MIGRATIONS
                .to_latest(&mut sconn)
                .expect("space migrations");

            let mut world_ids = Vec::new();
            for w in 0..worlds_per_space {
                let world_id = format!("{space_id}-world-{w}");
                let db_path = format!("worlds/{world_id}.db");
                let mut wconn = Connection::open(space_dir.join(&db_path)).expect("open world.db");
                wconn
                    .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
                    .expect("world pragma");
                WORLD_MIGRATIONS
                    .to_latest(&mut wconn)
                    .expect("world migrations");
                drop(wconn);

                sconn
                    .execute(
                        "INSERT INTO worlds (id, name, description, db_path, created_at, updated_at)
                         VALUES (?1, ?2, '', ?3, ?4, ?4)",
                        params![world_id, world_id, db_path, now],
                    )
                    .expect("insert world row");
                world_ids.push(world_id);
            }
            layout.push((space_id, world_ids));
        }
        (tmp, manager, layout)
    }

    /// Spawns 8 threads, each hammering `with_space` / `with_world` /
    /// `close_space` / `lock_space` in parallel for several seconds. Passes
    /// iff every thread joins (no deadlock, no panic). With the nested
    /// single-lock design a deadlock is structurally impossible, but this
    /// test guards against logic regressions (e.g. someone reintroducing a
    /// second lock and acquiring it in the wrong order).
    #[test]
    fn no_deadlock_under_concurrent_space_world_access() {
        let (_tmp, manager, layout) = bootstrap(4, 3);
        let duration = Duration::from_secs(3);
        let num_threads = 8;

        let mut handles = Vec::new();
        for t in 0..num_threads {
            let m = Arc::clone(&manager);
            let l = layout.clone();
            handles.push(thread::spawn(move || {
                let deadline = Instant::now() + duration;
                let mut iter = t;
                while Instant::now() < deadline {
                    iter += 1;
                    let si = iter % l.len();
                    let (space_id, world_ids) = &l[si];
                    match iter % 4 {
                        0 => {
                            let _ = m.with_space(space_id, |_| Ok::<(), DbError>(()));
                        }
                        1 => {
                            let wid = &world_ids[iter % world_ids.len()];
                            let _ = m.with_world(space_id, wid, |_| Ok::<(), DbError>(()));
                        }
                        2 => m.close_space(space_id),
                        3 => m.lock_space(space_id),
                        _ => unreachable!(),
                    }
                }
            }));
        }

        for (i, h) in handles.into_iter().enumerate() {
            h.join()
                .unwrap_or_else(|e| panic!("thread {i} panicked (possible deadlock): {e:?}"));
        }
    }

    /// `close_space` must drop the Space's `space.db` conn AND every cached
    /// world conn, and the cache must be re-openable from disk afterwards.
    #[test]
    fn close_space_drops_its_worlds() {
        let (_tmp, manager, layout) = bootstrap(1, 2);
        let (space_id, world_ids) = &layout[0];

        // Warm both world caches.
        for wid in world_ids {
            manager
                .with_world(space_id, wid, |_| Ok::<(), DbError>(()))
                .expect("warm world cache");
        }
        {
            let spaces = manager.spaces.lock().unwrap();
            let sc = spaces.get(space_id).expect("space cached");
            assert_eq!(sc.worlds.len(), world_ids.len());
        }

        manager.close_space(space_id);

        {
            let spaces = manager.spaces.lock().unwrap();
            assert!(spaces.get(space_id).is_none());
        }

        // Re-opening works (re-creates everything from disk).
        manager
            .with_world(space_id, &world_ids[0], |_| Ok::<(), DbError>(()))
            .expect("re-open after close");
    }

    /// `with_world` returns `WorldNotFound` (not a panic) for an unregistered
    /// world id, after transparently opening the Space's `space.db`.
    #[test]
    fn with_world_returns_world_not_found_for_unknown_world() {
        let (_tmp, manager, layout) = bootstrap(1, 0);
        let (space_id, _) = &layout[0];

        let err = manager
            .with_world(space_id, "no-such-world", |_| Ok::<(), DbError>(()))
            .expect_err("unknown world should error");
        match err {
            DbError::WorldNotFound(id) => assert_eq!(id, "no-such-world"),
            other => panic!("expected WorldNotFound, got {other:?}"),
        }
    }

    /// `with_space` round-trips a write + read against the Space's
    /// `space_config` KV table, proving migrations applied correctly.
    #[test]
    fn with_space_round_trip() {
        let (_tmp, manager, layout) = bootstrap(1, 0);
        let (space_id, _) = &layout[0];

        manager
            .with_space(space_id, |c| {
                c.execute(
                    "INSERT INTO space_config (key, value) VALUES ('k1', 'v1')",
                    [],
                )?;
                let v: String =
                    c.query_row("SELECT value FROM space_config WHERE key = 'k1'", [], |r| {
                        r.get(0)
                    })?;
                assert_eq!(v, "v1");
                Ok(())
            })
            .expect("with_space round-trip");
    }

    /// `with_world` round-trips a write + read against the world content DB,
    /// proving WORLD_MIGRATIONS applied and the connection is usable.
    #[test]
    fn with_world_round_trip() {
        let (_tmp, manager, layout) = bootstrap(1, 1);
        let (space_id, world_ids) = &layout[0];
        let world_id = &world_ids[0];

        manager
            .with_world(space_id, world_id, |c| {
                c.execute(
                    "INSERT INTO characters (id, name, aliases, description, notes, tags, created_at, updated_at)
                     VALUES ('c1', 'Hero', '[]', '', '', '[]', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                let name: String =
                    c.query_row("SELECT name FROM characters WHERE id = 'c1'", [], |r| r.get(0))?;
                assert_eq!(name, "Hero");
                Ok(())
            })
            .expect("with_world round-trip");
    }
}
