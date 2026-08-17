//! Shared test fixtures for command-level integration tests.
//!
//! Compiled only under `cfg(test)` (declared in `lib.rs` as
//! `#[cfg(test)] mod testutil;`) — never ships in release builds.
//!
//! Follows the bootstrap pattern from `db/manager.rs::stress_tests`:
//! `space.db` + world DB files are created directly (bypassing Tauri
//! commands) so tests never construct `State<'_, DbManager>` or
//! `AppHandle` — this crate has no mock runtime by convention (see
//! `commands/space.rs` `do_*` helpers and `commands/session.rs`
//! `*_impl` fns for the matching command-layer pattern).

use crate::db::migrations::{SPACE_MIGRATIONS, WORLD_MIGRATIONS};
use crate::db::{DbError, DbManager};
use rusqlite::{Connection, params};
use tempfile::TempDir;

/// Format `n` into a 36-char UUID-shaped string (8-4-4-4-12 hex digits).
/// For test ids only — the shape passes `validate_id`; the value is
/// deterministic per `n`, so tests can construct the same id twice
/// without coordination.
pub fn uuid_shape(n: u64) -> String {
    let h = format!("{n:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Fixture bundle: a `DbManager` over an isolated temp dir with one
/// Space containing one World. The `TempDir` is returned FIRST so it
/// drops LAST (Rust drops bindings in reverse declaration order) —
/// SQLite connections close before the temp files vanish, which
/// matters for WAL on Windows.
pub struct WorldFixture {
    pub _tmp: TempDir,
    pub mgr: DbManager,
    pub space_id: String,
    pub world_id: String,
}

/// Bootstrap a manager with one Space (`uuid_shape(1)`) holding one
/// World (`uuid_shape(1000)`). The `space.db` and world DB files are
/// created and migrated directly; the `worlds` registry row is inserted
/// so `with_world` can resolve the DB path.
pub fn make_space_with_world() -> WorldFixture {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let mgr = DbManager::new(data_dir.clone()).expect("manager new");

    let space_id = uuid_shape(1);
    let world_id = uuid_shape(1000);
    let now = "2026-01-01T00:00:00.000Z";

    let space_dir = data_dir.join("spaces").join(&space_id);
    std::fs::create_dir_all(space_dir.join("worlds")).expect("space dir");

    let mut sconn = Connection::open(space_dir.join("space.db")).expect("open space.db");
    sconn
        .execute_batch("PRAGMA foreign_keys = ON;")
        .expect("space pragma");
    SPACE_MIGRATIONS
        .to_latest(&mut sconn)
        .expect("space migrations");

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

    WorldFixture {
        _tmp: tmp,
        mgr,
        space_id,
        world_id,
    }
}

/// Run `f` against the fixture's world DB via `with_world`. Convenience
/// wrapper so tests read as `with_world(&fx, |conn| ...)`.
pub fn with_world<R>(
    fx: &WorldFixture,
    f: impl FnOnce(&mut Connection) -> Result<R, DbError>,
) -> Result<R, DbError> {
    fx.mgr.with_world(&fx.space_id, &fx.world_id, f)
}
