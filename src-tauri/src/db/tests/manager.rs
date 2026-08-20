use super::*;
use rusqlite::params;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// Layout returned by [`bootstrap`]: each entry is a Space id and the list
/// of World ids registered under it. Extracted as a type alias to keep
/// `bootstrap`'s signature readable (avoids `clippy::type_complexity`).
type Layout = Vec<(String, Vec<String>)>;

/// Bootstrap result: temp dir (dropped last), manager, layout.
type BootstrapResult = (TempDir, Arc<DbManager>, Layout);

/// Format `n` into a 36-char UUID-shaped string (8-4-4-4-12 hex digits).
/// For test ids only — shape passes `validate_id`; value is deterministic.
fn uuid_shape(n: u64) -> String {
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

/// Bootstraps a DbManager with `num_spaces` Spaces, each registering
/// `worlds_per_space` Worlds. The `space.db` + `world.db` files are
/// created directly (bypassing commands) so the test doesn't depend on
/// T11/T14 command wiring.
fn bootstrap(num_spaces: usize, worlds_per_space: usize) -> BootstrapResult {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let manager = Arc::new(DbManager::new(data_dir.clone()).expect("manager new"));

    let now = "2026-01-01T00:00:00.000Z";
    let mut layout: Layout = Vec::new();
    for s in 0..num_spaces {
        // Space ids must be UUID-shaped (validated by with_space/with_world).
        let space_id = uuid_shape((s as u64) + 1);
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
            // World ids must also be UUID-shaped.
            let world_id = uuid_shape(((s as u64) + 1) * 1000 + w as u64);
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
/// world id (with a VALID UUID shape), after transparently opening the
/// Space's `space.db`.
#[test]
fn with_world_returns_world_not_found_for_unknown_world() {
    let (_tmp, manager, layout) = bootstrap(1, 0);
    let (space_id, _) = &layout[0];
    // UUID-shaped but not registered in the Space's worlds table.
    let ghost = "deadbeef-0000-0000-0000-00000000dead";

    let err = manager
        .with_world(space_id, ghost, |_| Ok::<(), DbError>(()))
        .expect_err("unknown world should error");
    match err {
        DbError::WorldNotFound(id) => assert_eq!(id, ghost),
        other => panic!("expected WorldNotFound, got {other:?}"),
    }
}

/// `validate_id` rejects malformed ids that could enable path traversal.
/// Guards the filesystem boundary against frontend-supplied ids.
#[test]
fn validate_id_rejects_non_uuid_shapes() {
    // Valid UUID shapes accepted.
    assert!(DbManager::validate_id("01926f5e-1d5a-7bbf-b6c4-3e8e5f6a7b8c").is_ok());
    assert!(DbManager::validate_id("00000000-0000-0000-0000-000000000000").is_ok());

    // Path-traversal attempts rejected.
    assert!(DbManager::validate_id("../../etc/passwd").is_err());
    assert!(DbManager::validate_id("..").is_err());
    assert!(DbManager::validate_id("foo/bar").is_err());

    // Wrong length rejected.
    assert!(DbManager::validate_id("short").is_err());
    assert!(DbManager::validate_id("01926f5e-1d5a-7bbf-b6c4-3e8e5f6a7b8c-extra").is_err());

    // Non-hex chars rejected.
    assert!(DbManager::validate_id("01926f5z-1d5a-7bbf-b6c4-3e8e5f6a7b8c").is_err());

    // Misplaced dashes rejected.
    assert!(DbManager::validate_id("01926f5e1d5a-7bbf-b6c4-3e8e5f6a7b8c-").is_err());
}

/// `with_space` rejects malformed space ids BEFORE touching the filesystem,
/// so a path-traversal id can never reach `Connection::open`.
#[test]
fn with_space_rejects_invalid_id() {
    let tmp = TempDir::new().expect("tempdir");
    let manager = DbManager::new(tmp.path().to_path_buf()).expect("manager new");

    let err = manager
        .with_space("../../etc/passwd", |_| Ok::<(), DbError>(()))
        .expect_err("traversal id must reject");
    assert!(matches!(err, DbError::InvalidInput(_)));

    // The traversal directory was NOT created.
    assert!(
        !tmp.path().join("../../etc/passwd").exists(),
        "path traversal must not reach the filesystem"
    );
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
