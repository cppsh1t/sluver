//! Session commands — Space lock lifecycle (ADR-0011).
//!
//! Session state (`lastOpenedSpaceId` + `lockedSpaceIds`) is persisted as a
//! SINGLE JSON value under the `"session"` key in the `meta.db` `settings` KV
//! table, so a read-modify-write cycle is atomic at the row level. The
//! connection cache (which `space.db` files are currently held in memory) is
//! owned by [`DbManager`]; this module only flips the session flags and calls
//! the cache lifecycle helpers (`open_space_conn` / `lock_space`).
//! `DbManager::close_space` is invoked directly by the window-event router
//! (`lib.rs`) when a Space window is destroyed — there is no longer a
//! session-level `close_space` command in the multi-window model.
//!
//! # Migration (ADR-0011)
//!
//! The pre-ADR-0011 format tracked three fields (`openSpaceIds` +
//! `activeSpaceId` + `lockedSpaceIds`). [`read_session`] transparently
//! migrates old JSON: `lastOpenedSpaceId = activeSpaceId ?? openSpaceIds[0]`.
//! The `deny_unknown_fields` attribute on [`SessionState`] forces old JSON
//! (which carries extra fields) to fail the new-format parse, triggering the
//! migration path. After the first post-migration write, the JSON is in the
//! new shape and migration never runs again.
//!
//! # Lock ordering & argon2
//!
//! Every command acquires only the `meta` lock (for the settings KV) and/or
//! the `spaces` lock (via the cache helpers). The two are NEVER held
//! simultaneously — argon2 verification in [`open_space_impl`] runs with NO
//! lock held (the hash is read under `meta`, the lock is released,
//! verification runs lock-free, then `meta` is re-acquired to persist the new
//! session). This keeps the multi-hundred-ms argon2 compute off the hot
//! locks.

use rusqlite::{params, Connection};
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::space::SessionState;

/// The single `settings` KV row holding the serialized [`SessionState`].
/// Persisting the whole struct as one JSON value makes read-modify-write
/// atomic at the row level (no partial session ever observable).
const SESSION_KEY: &str = "session";

// ─── KV helpers (private) ───────────────────────────────────────────────────

/// An all-empty [`SessionState`] — the value returned when no `session` row
/// exists yet (first boot).
fn empty_session() -> SessionState {
    SessionState {
        last_opened_space_id: None,
        locked_space_ids: Vec::new(),
    }
}

/// Read the persisted session. Absent row → empty default. Old-format JSON
/// → transparently migrated. Corrupt JSON → `DbError::Serde` (surfaces as
/// `INTERNAL_ERROR` on the frontend).
///
/// **Migration**: [`SessionState`] carries `#[serde(deny_unknown_fields)]`,
/// so pre-ADR-0011 JSON (with `openSpaceIds` + `activeSpaceId`) fails the
/// new-format parse and falls through to [`migrate_old_session`].
pub(crate) fn read_session(conn: &Connection) -> Result<SessionState, DbError> {
    let json: Option<String> = match conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![SESSION_KEY],
        |row| row.get::<_, String>(0),
    ) {
        Ok(s) => Some(s),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(DbError::Sqlite(e)),
    };
    match json {
        Some(s) => match serde_json::from_str::<SessionState>(&s) {
            Ok(state) => Ok(state),
            Err(_) => migrate_old_session(&s),
        },
        None => Ok(empty_session()),
    }
}

/// Parse pre-ADR-0011 session JSON and migrate to the new shape.
/// `lastOpenedSpaceId` falls back to `activeSpaceId`, else the first entry
/// of `openSpaceIds` (best-effort restore of the user's last context).
fn migrate_old_session(s: &str) -> Result<SessionState, DbError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OldSession {
        open_space_ids: Vec<String>,
        active_space_id: Option<String>,
        locked_space_ids: Vec<String>,
    }
    let old: OldSession = serde_json::from_str(s)?;
    Ok(SessionState {
        last_opened_space_id: old
            .active_space_id
            .or_else(|| old.open_space_ids.first().cloned()),
        locked_space_ids: old.locked_space_ids,
    })
}

/// Persist the session, replacing any prior value (atomic upsert).
pub(crate) fn write_session(conn: &Connection, session: &SessionState) -> Result<(), DbError> {
    let json = serde_json::to_string(session)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SESSION_KEY, json],
    )?;
    Ok(())
}

/// Look up a Space's stored `password_hash`. Missing Space row →
/// [`DbError::SpaceNotFound`]; present row → `Ok(None)` (unprotected) or
/// `Ok(Some(phc))` (protected).
fn fetch_space_password_hash(conn: &Connection, id: &str) -> Result<Option<String>, DbError> {
    match conn.query_row(
        "SELECT password_hash FROM spaces WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<String>>(0),
    ) {
        Ok(h) => Ok(h),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(DbError::SpaceNotFound(id.to_string())),
        Err(e) => Err(DbError::Sqlite(e)),
    }
}

/// Query ALL protected Space IDs from `meta.db` (every row with a non-NULL
/// `password_hash`). Used by [`lock_all_protected_spaces_impl`] — on app
/// exit/hide, EVERY protected Space must be locked, regardless of whether it
/// currently has an open window. Locking a never-opened Space is idempotent
/// (it just records the id in `locked_space_ids`).
fn all_protected_ids(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare("SELECT id FROM spaces WHERE password_hash IS NOT NULL")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

/// `true` if `id` appears in `session.locked_space_ids`.
fn is_locked(session: &SessionState, id: &str) -> bool {
    session.locked_space_ids.iter().any(|s| s.as_str() == id)
}

// ─── impl fns (private; take &DbManager so tests bypass `State<'_, _>`) ─────

pub(crate) fn get_session_impl(manager: &DbManager) -> Result<SessionState, DbError> {
    manager.with_meta(|c| read_session(c))
}

pub(crate) fn open_space_impl(
    id: &str,
    password: Option<&str>,
    manager: &DbManager,
) -> Result<SessionState, DbError> {
    // 1. Read password_hash + current locked flag under the meta lock, then
    //    RELEASE so argon2 verification runs lock-free. The open/active lists
    //    of the pre-ADR-0011 model are gone — only `was_locked` remains as
    //    the discriminator for the ADR-0008 state machine below.
    let (hash, was_locked) = manager.with_meta(|conn| {
        let hash = fetch_space_password_hash(conn, id)?;
        let session = read_session(conn)?;
        Ok((hash, is_locked(&session, id)))
    })?;

    // 2. State machine (ADR-0008): a protected Space can be opened WITHOUT a
    //    password — it lands in a LOCKED state (window visible, content
    //    hidden behind the in-page password gate). This replaces the old
    //    chicken-and-egg deadlock where protected Spaces were unreachable
    //    until a password was supplied, but the UI had nowhere to enter one.
    //
    //    Without an `open_space_ids` list to consult, `was_locked` is the
    //    only signal: a protected Space that is NOT locked is treated as a
    //    fresh open (locked-state-open path); one that IS locked is an
    //    unlock attempt. With a correct password both paths converge on
    //    "unlock + warm cache".
    //
    //    The triad captures the session mutation intent:
    //      warm_cache   — whether to open + cache `space.db` (content access)
    //      mark_locked  — whether to ADD the id to `locked_space_ids`
    //      clear_locked — whether to REMOVE the id from `locked_space_ids`
    let warm_cache: bool;
    let mark_locked: bool;
    let clear_locked: bool;

    match hash.as_deref() {
        // Unprotected Space: always open + unlock + warm cache.
        None => {
            warm_cache = true;
            mark_locked = false;
            clear_locked = true;
        }
        Some(phc) => {
            if !was_locked {
                // Protected Space, not locked → fresh-open path.
                match password {
                    Some(plain) => {
                        // Password supplied → verify (argon2 runs lock-free).
                        let ok = crate::util::password::verify_password(plain, phc)?;
                        if !ok {
                            return Err(DbError::SpaceWrongPassword(id.to_string()));
                        }
                        // Correct password → unlock + warm cache.
                        warm_cache = true;
                        mark_locked = false;
                        clear_locked = true;
                    }
                    None => {
                        // No password → LOCKED-STATE OPEN (ADR-0008). The
                        // Space window is visible but content stays hidden
                        // behind the in-page gate; do NOT warm the cache.
                        warm_cache = false;
                        mark_locked = true;
                        clear_locked = false;
                    }
                }
            } else {
                // Protected Space, currently locked → unlock attempt.
                match password {
                    Some(plain) => {
                        let ok = crate::util::password::verify_password(plain, phc)?;
                        if !ok {
                            return Err(DbError::SpaceWrongPassword(id.to_string()));
                        }
                        // Correct password → unlock + warm cache.
                        warm_cache = true;
                        mark_locked = false;
                        clear_locked = true;
                    }
                    None => {
                        // No password → no-op (already locked). Return
                        // current session unchanged.
                        return get_session_impl(manager);
                    }
                }
            }
        }
    }

    // 3. Warm the space.db cache (acquires the spaces lock; meta is NOT
    //    held). SKIPPED when opening in the locked state — content stays
    //    hidden.
    if warm_cache {
        manager.open_space_conn(id)?;
    }

    // 4. Re-acquire meta to update + persist session state.
    let new_session = manager.with_meta(|conn| {
        let mut session = read_session(conn)?;
        session.last_opened_space_id = Some(id.to_string());
        if mark_locked && !is_locked(&session, id) {
            session.locked_space_ids.push(id.to_string());
        }
        if clear_locked {
            session.locked_space_ids.retain(|s| s.as_str() != id);
        }
        write_session(conn, &session)?;
        Ok(session)
    })?;
    Ok(new_session)
}

fn lock_space_impl(id: &str, manager: &DbManager) -> Result<SessionState, DbError> {
    // Read protection flag + update session under the meta lock.
    let protected = manager.with_meta(|conn| {
        let hash = fetch_space_password_hash(conn, id)?;
        if hash.is_none() {
            // Unprotected — locking is a no-op (return current session).
            return Ok(false);
        }
        let mut session = read_session(conn)?;
        if !is_locked(&session, id) {
            session.locked_space_ids.push(id.to_string());
        }
        write_session(conn, &session)?;
        Ok(true)
    })?;

    if protected {
        // Drop cached connections so re-open requires re-auth (spaces lock).
        manager.lock_space(id);
    }
    // Re-read so we return the freshly-persisted locked state.
    get_session_impl(manager)
}

pub(crate) fn lock_all_protected_spaces_impl(manager: &DbManager) -> Result<SessionState, DbError> {
    // 1. Identify ALL protected Spaces (meta lock). On app exit/hide every
    //    protected Space is locked, regardless of whether it has an open
    //    window — this is a strict superset of the pre-ADR-0011 "open &
    //    protected" set, which is the intended behavior (lock down
    //    everything before the process goes dormant).
    let to_lock: Vec<String> = manager.with_meta(|conn| all_protected_ids(conn))?;

    // 2. Drop their cached connections (spaces lock, meta released).
    for sid in &to_lock {
        manager.lock_space(sid);
    }

    // 3. Mark them locked in the persisted session (meta lock).
    let new_session = manager.with_meta(|conn| {
        let mut session = read_session(conn)?;
        for sid in &to_lock {
            if !is_locked(&session, sid) {
                session.locked_space_ids.push(sid.clone());
            }
        }
        write_session(conn, &session)?;
        Ok(session)
    })?;
    Ok(new_session)
}

// ─── #[tauri::command] wrappers ─────────────────────────────────────────────
//
// Each command is a one-line delegate to its `_impl` twin. `State<'_, DbManager>`
// derefs to `&DbManager`, so `&state` coerces to the impl signature. Splitting
// the impl out keeps the Tauri-flavoured wrapper free of testable logic.

#[tauri::command]
pub fn get_session(state: State<'_, DbManager>) -> Result<SessionState, DbError> {
    get_session_impl(&state)
}

#[tauri::command]
pub fn open_space(
    id: String,
    password: Option<String>,
    state: State<'_, DbManager>,
) -> Result<SessionState, DbError> {
    open_space_impl(&id, password.as_deref(), &state)
}

#[tauri::command]
pub fn lock_space(id: String, state: State<'_, DbManager>) -> Result<SessionState, DbError> {
    lock_space_impl(&id, &state)
}

#[tauri::command]
pub fn lock_all_protected_spaces(state: State<'_, DbManager>) -> Result<SessionState, DbError> {
    lock_all_protected_spaces_impl(&state)
}

#[cfg(test)]
mod tests {
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
            Self {
                _tmp: tmp,
                manager,
            }
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
                    params![
                        r#"{"openSpaceIds":["a","b"],"activeSpaceId":"b","lockedSpaceIds":["c"]}"#
                    ],
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
        let err = open_space_impl("sp", Some("wrong"), &f.manager)
            .expect_err("wrong password must reject");
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

        let err = open_space_impl("sp", Some("wrong-password"), &f.manager)
            .expect_err("wrong password");
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
}
