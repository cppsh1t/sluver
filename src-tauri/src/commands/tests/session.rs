use super::*;
use rusqlite::params;
use tempfile::TempDir;

/// Test harness: owns the `TempDir` (so cleanup is automatic) and exposes
/// a fresh `DbManager`. Spaces are inserted directly into `meta.db`
/// because the Space CRUD commands live in a sibling module and aren't
/// wired into the test.
struct Fixture {
    _tmp: TempDir,
    manager: DbManager,
}

impl Fixture {
    fn new() -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let manager = DbManager::new(tmp.path().to_path_buf()).expect("DbManager::new");
        Self { _tmp: tmp, manager }
    }

    /// Insert a Space row. `password_hash = None` for unprotected;
    /// pass a PHC string for protected.
    fn insert_space(&self, id: &str, name: &str, password_hash: Option<&str>) {
        self.manager
            .with_meta(|conn| {
                conn.execute(
                    "INSERT INTO spaces (id, name, password_hash, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, name, password_hash, "2026-01-01T00:00:00.000Z"],
                )?;
                Ok(())
            })
            .expect("insert space row");
    }

    fn session(&self) -> SessionState {
        get_session_impl(&self.manager).expect("get_session")
    }

    fn space_db_exists(&self, id: &str) -> bool {
        self.manager
            .data_dir()
            .join("spaces")
            .join(id)
            .join("space.db")
            .exists()
    }
}

// ─── migration ──────────────────────────────────────────────────────────

#[test]
fn read_session_migrates_old_format() {
    let f = Fixture::new();
    // Write pre-ADR-0011 JSON directly into the settings KV.
    f.manager
        .with_meta(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('session', ?1)",
                params![r#"{"openSpaceIds":["a","b"],"activeSpaceId":"b","lockedSpaceIds":["c"]}"#],
            )?;
            Ok(())
        })
        .expect("insert old session");

    let s = f.session();
    // last_opened falls back to active_space_id.
    assert_eq!(s.last_opened_space_id.as_deref(), Some("b"));
    // locked list preserved.
    assert_eq!(s.locked_space_ids, vec!["c".to_string()]);
}

#[test]
fn read_session_migrates_old_format_without_active() {
    let f = Fixture::new();
    f.manager
        .with_meta(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('session', ?1)",
                params![r#"{"openSpaceIds":["x","y"],"activeSpaceId":null,"lockedSpaceIds":[]}"#],
            )?;
            Ok(())
        })
        .expect("insert old session");

    let s = f.session();
    // No active → fall back to first open.
    assert_eq!(s.last_opened_space_id.as_deref(), Some("x"));
    assert!(s.locked_space_ids.is_empty());
}

// ─── get_session ────────────────────────────────────────────────────────

#[test]
fn get_session_defaults_to_empty_when_no_row() {
    let f = Fixture::new();
    let s = f.session();
    assert!(s.last_opened_space_id.is_none());
    assert!(s.locked_space_ids.is_empty());
}

// ─── open_space (unprotected) ───────────────────────────────────────────

#[test]
fn open_unprotected_space_succeeds_and_warms_cache() {
    let f = Fixture::new();
    f.insert_space("s1", "Open", None);

    let s = open_space_impl("s1", None, &f.manager).expect("open unprotected");

    assert_eq!(s.last_opened_space_id.as_deref(), Some("s1"));
    assert!(s.locked_space_ids.is_empty());
    // `open_space_conn` creates `spaces/{id}/space.db` on first warm.
    assert!(
        f.space_db_exists("s1"),
        "space.db file should exist after open"
    );
}

#[test]
fn open_space_idempotent_when_already_open_and_unlocked() {
    let f = Fixture::new();
    f.insert_space("s1", "Open", None);
    let _ = open_space_impl("s1", None, &f.manager).expect("first open");

    // Second open — no password required, no error.
    let s = open_space_impl("s1", None, &f.manager).expect("second open");
    assert_eq!(s.last_opened_space_id.as_deref(), Some("s1"));
    assert!(s.locked_space_ids.is_empty());
}

// ─── open_space (protected) ─────────────────────────────────────────────

#[test]
fn open_protected_space_without_password_opens_in_locked_state() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("hunter2").expect("hash");
    f.insert_space("sp", "Protected", Some(&phc));

    // No password supplied → ADR-0008 locked-state open (NOT a rejection).
    let session = open_space_impl("sp", None, &f.manager).expect("open in locked state");

    // Space is last_opened.
    assert_eq!(session.last_opened_space_id.as_deref(), Some("sp"));
    // Space IS in locked_space_ids (locked state).
    assert!(
        session.locked_space_ids.contains(&"sp".to_string()),
        "locked-state open must add to locked list"
    );
    // Cache is NOT warmed — space.db file must not exist yet (content
    // stays hidden behind the in-page password gate).
    assert!(
        !f.space_db_exists("sp"),
        "space.db must NOT be created in locked state"
    );
}

#[test]
fn open_protected_space_with_correct_password_unlocks() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("hunter2").expect("hash");
    f.insert_space("sp", "Protected", Some(&phc));

    // First open without password → locked state.
    open_space_impl("sp", None, &f.manager).expect("first open locked");

    // Then open with correct password → unlocked.
    let session = open_space_impl("sp", Some("hunter2"), &f.manager).expect("unlock");
    assert_eq!(session.last_opened_space_id.as_deref(), Some("sp"));
    assert!(
        !session.locked_space_ids.contains(&"sp".to_string()),
        "correct password must clear locked state"
    );
    // Cache is now warmed.
    assert!(f.space_db_exists("sp"), "space.db must exist after unlock");
}

#[test]
fn open_protected_space_with_wrong_password_returns_error() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("hunter2").expect("hash");
    f.insert_space("sp", "Protected", Some(&phc));

    // First open without password → locked state.
    open_space_impl("sp", None, &f.manager).expect("first open locked");

    // Try to unlock with wrong password → SpaceWrongPassword error.
    let err =
        open_space_impl("sp", Some("wrong"), &f.manager).expect_err("wrong password must reject");
    match err {
        DbError::SpaceWrongPassword(id) => assert_eq!(id, "sp"),
        other => panic!("expected SpaceWrongPassword, got {other:?}"),
    }

    // Space stays locked.
    let session = f.session();
    assert!(
        session.locked_space_ids.contains(&"sp".to_string()),
        "wrong password must leave Space locked"
    );
    assert!(
        !f.space_db_exists("sp"),
        "space.db must NOT be created on wrong password"
    );
}

#[test]
fn open_protected_space_wrong_password_returns_wrong_password() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("hunter2").expect("hash");
    f.insert_space("sp", "Protected", Some(&phc));

    let err =
        open_space_impl("sp", Some("wrong-password"), &f.manager).expect_err("wrong password");
    match err {
        DbError::SpaceWrongPassword(id) => assert_eq!(id, "sp"),
        other => panic!("expected SpaceWrongPassword, got {other:?}"),
    }
    let s = f.session();
    assert!(
        !s.locked_space_ids.contains(&"sp".to_string()),
        "wrong pw must not add to locked list"
    );
    assert!(
        s.last_opened_space_id.is_none(),
        "wrong pw must not set last_opened"
    );
}

#[test]
fn open_protected_space_correct_password_succeeds() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("hunter2").expect("hash");
    f.insert_space("sp", "Protected", Some(&phc));

    let s = open_space_impl("sp", Some("hunter2"), &f.manager).expect("correct pw");
    assert_eq!(s.last_opened_space_id.as_deref(), Some("sp"));
    assert!(s.locked_space_ids.is_empty());
    assert!(f.space_db_exists("sp"));
}

#[test]
fn open_unknown_space_returns_not_found() {
    let f = Fixture::new();
    let err = open_space_impl("ghost", None, &f.manager).expect_err("unknown space");
    assert!(matches!(err, DbError::SpaceNotFound(_)));
}

// ─── lock_space ─────────────────────────────────────────────────────────

#[test]
fn lock_unprotected_space_is_no_op() {
    let f = Fixture::new();
    f.insert_space("su", "Unprot", None);
    let _ = open_space_impl("su", None, &f.manager).expect("open");

    let s = lock_space_impl("su", &f.manager).expect("lock");
    assert!(
        s.locked_space_ids.is_empty(),
        "unprotected Space must never enter the locked list"
    );
    assert_eq!(s.last_opened_space_id.as_deref(), Some("su"));
}

#[test]
fn lock_protected_space_marks_locked() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("pw").expect("hash");
    f.insert_space("sp", "Prot", Some(&phc));
    let _ = open_space_impl("sp", Some("pw"), &f.manager).expect("open");

    let s = lock_space_impl("sp", &f.manager).expect("lock");
    assert_eq!(s.locked_space_ids, vec!["sp".to_string()]);
}

#[test]
fn open_locked_protected_space_without_password_is_noop() {
    let f = Fixture::new();
    let phc = crate::util::password::hash_password("pw").expect("hash");
    f.insert_space("sp", "Prot", Some(&phc));
    let _ = open_space_impl("sp", Some("pw"), &f.manager).expect("open");
    let _ = lock_space_impl("sp", &f.manager).expect("lock");

    // Locked + no password → no-op (returns current session unchanged).
    // Per ADR-0008 the Space stays in locked state; the in-page gate
    // handles the re-auth UX. This is NOT a rejection.
    let s = open_space_impl("sp", None, &f.manager).expect("locked no-op");
    assert!(
        s.locked_space_ids.contains(&"sp".to_string()),
        "locked Space must stay locked without a password"
    );

    // Re-auth with the right password clears the locked flag.
    let s = open_space_impl("sp", Some("pw"), &f.manager).expect("re-auth open");
    assert!(s.locked_space_ids.is_empty());
    assert_eq!(s.last_opened_space_id.as_deref(), Some("sp"));
}

// ─── lock_all_protected_spaces ──────────────────────────────────────────

#[test]
fn lock_all_locks_every_protected_space() {
    let f = Fixture::new();
    f.insert_space("su", "Unprot", None);
    let phc = crate::util::password::hash_password("pw").expect("hash");
    f.insert_space("sp1", "Prot1", Some(&phc));
    f.insert_space("sp2", "Prot2", Some(&phc));
    // A protected Space that is NOT open — still locked under the new
    // "lock all" semantics (ADR-0011: lock down everything on exit).
    f.insert_space("sp3", "Prot3Closed", Some(&phc));

    let _ = open_space_impl("su", None, &f.manager).expect("open su");
    let _ = open_space_impl("sp1", Some("pw"), &f.manager).expect("open sp1");
    let _ = open_space_impl("sp2", Some("pw"), &f.manager).expect("open sp2");

    let s = lock_all_protected_spaces_impl(&f.manager).expect("lock all");

    // All three protected Spaces locked, unprotected untouched.
    assert_eq!(s.locked_space_ids.len(), 3, "all protected Spaces locked");
    assert!(s.locked_space_ids.contains(&"sp1".to_string()));
    assert!(s.locked_space_ids.contains(&"sp2".to_string()));
    assert!(s.locked_space_ids.contains(&"sp3".to_string()));
    assert!(!s.locked_space_ids.contains(&"su".to_string()));
}

#[test]
fn lock_all_with_no_protected_spaces_is_no_op() {
    let f = Fixture::new();
    f.insert_space("su", "Unprot", None);
    let _ = open_space_impl("su", None, &f.manager).expect("open");

    let s = lock_all_protected_spaces_impl(&f.manager).expect("lock all");
    assert!(s.locked_space_ids.is_empty());
}

// ─── persistence ────────────────────────────────────────────────────────

#[test]
fn session_persists_across_manager_reopen() {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();

    {
        let mgr = DbManager::new(data_dir.clone()).expect("mgr");
        mgr.with_meta(|conn| {
            conn.execute(
                "INSERT INTO spaces (id, name, password_hash, created_at, updated_at)
                     VALUES (?1, ?2, NULL, ?3, ?3)",
                params!["persist", "P", "2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("insert space");
        let s = open_space_impl("persist", None, &mgr).expect("open");
        assert_eq!(s.last_opened_space_id.as_deref(), Some("persist"));
    } // mgr dropped → connections closed, meta.db flushed.

    // A fresh DbManager over the same data_dir must observe the persisted row.
    let mgr = DbManager::new(data_dir).expect("mgr reopen");
    let s = get_session_impl(&mgr).expect("get after reopen");
    assert_eq!(s.last_opened_space_id.as_deref(), Some("persist"));
    assert!(s.locked_space_ids.is_empty());
}
