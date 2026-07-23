// Space CRUD + argon2id password lifecycle.
//
// All Space commands operate on the `spaces` table in `meta.db` (ADR-0007
// tier 1). Per ADR-0008 a Space's optional password is an auth-gate, NOT
// encryption: `password_hash` stores an argon2id PHC string; verification
// happens before the Space's `space.db` is opened (see `commands::session`).
//
// Lock discipline (CRITICAL — see plan T11 + ADR-0007): argon2id
// hashing/verification is ~50ms of CPU work. It is NEVER performed while
// holding the `meta` lock. The pattern is: read the stored hash under the
// `meta` lock, release it, run the slow verify/hash, then re-acquire the
// `meta` lock to persist. This keeps the global `meta` lock held only for
// cheap SQL, avoiding a global serialization point on every password op.
//
// `password_hash` is NEVER included in any serializable struct — only the
// derived boolean `has_password` flag leaves this module.

use rusqlite::params;
use tauri::{AppHandle, Manager, State};

use crate::db::{DbError, DbManager};
use crate::models::space::{
    CreateSpaceInput, SetSpacePasswordInput, SpaceSummary, UpdateSpaceInput,
};
use crate::util::{new_id, now_iso, password};

// ─── helpers ────────────────────────────────────────────────────────────────

/// Maps a `spaces` row to a `SpaceSummary`. Reads `password_hash` only to
/// derive the `has_password` boolean — the hash itself never leaves this
/// closure, so it cannot leak into a serializable struct.
fn row_to_summary(row: &rusqlite::Row) -> rusqlite::Result<SpaceSummary> {
    let password_hash: Option<String> = row.get("password_hash")?;
    Ok(SpaceSummary {
        id: row.get("id")?,
        name: row.get("name")?,
        has_password: password_hash.is_some(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// True iff `e` is a SQLite UNIQUE-constraint violation. `name` is the only
/// UNIQUE column `commands::space` writes to (via `idx_spaces_name`), so any
/// constraint violation on the `spaces` table is a name collision and is
/// translated to `SpaceNameTaken`. Relying on the UNIQUE index (rather than
/// a pre-check SELECT) is race-safe under concurrent inserts.
fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(ref err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/// Read a Space's stored password hash by id, distinguishing "row missing"
/// (`Err(SpaceNotFound)`) from "row exists, unprotected" (`Ok(None)`).
fn load_password_hash(mgr: &DbManager, id: &str) -> Result<Option<String>, DbError> {
    mgr.with_meta(|conn| {
        let hash = conn
            .query_row(
                "SELECT password_hash FROM spaces WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::SpaceNotFound(id.to_string()),
                other => DbError::Sqlite(other),
            })?;
        Ok(hash)
    })
}

// ─── create ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_space(
    input: CreateSpaceInput,
    state: State<'_, DbManager>,
) -> Result<SpaceSummary, DbError> {
    do_create_space(&state, input)
}

pub(crate) fn do_create_space(
    mgr: &DbManager,
    input: CreateSpaceInput,
) -> Result<SpaceSummary, DbError> {
    // 1. Hash the password (if any) OUTSIDE the meta lock — argon2id is slow.
    let password_hash = match input.password.as_deref() {
        Some(plain) => Some(password::hash_password(plain)?),
        None => None,
    };
    let has_password = password_hash.is_some();

    let id = new_id();
    let now = now_iso();

    // 2. INSERT into meta.db. Translate UNIQUE violation → SpaceNameTaken.
    mgr.with_meta(|conn| {
        let res = conn.execute(
            "INSERT INTO spaces (id, name, password_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, input.name, password_hash, now, now],
        );
        match res {
            Ok(_) => Ok(()),
            Err(ref e) if is_unique_violation(e) => {
                Err(DbError::SpaceNameTaken(input.name.clone()))
            }
            Err(e) => Err(DbError::Sqlite(e)),
        }
    })?;

    // 3. Create the Space's directory: `spaces/{id}/`. On failure, roll back
    //    the meta row so we don't leave an orphaned registry entry.
    let space_dir = mgr.data_dir().join("spaces").join(&id);
    if let Err(e) = std::fs::create_dir_all(&space_dir) {
        let _ = mgr.with_meta(|conn| {
            conn.execute("DELETE FROM spaces WHERE id = ?1", params![id])?;
            Ok(())
        });
        return Err(DbError::Io(e));
    }

    // 4. Seed the two AI agents (ADR-0012): `explorer` + `writer`, each with
    //    model_id = NULL. `with_space` opens + caches the brand-new
    //    `space.db` (running SPACE_MIGRATIONS, which creates the `agents`
    //    table). The cached conn is reused by the frontend's first
    //    `list_agents` call. The frontend looks these up by `name`, not by
    //    the random UUID id, so the ids here are throwaway.
    //
    //    On failure, roll back the entire Space (meta row + directory) so we
    //    don't leave a registered Space with a broken agent table — matching
    //    the step-3 rollback pattern.
    if let Err(seed_err) = mgr.with_space(&id, |conn| {
        for name in ["explorer", "writer"] {
            let aid = new_id();
            conn.execute(
                "INSERT INTO agents (id, name, model_id, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?3)",
                params![aid, name, now],
            )?;
        }
        Ok(())
    }) {
        // Best-effort cleanup: delete meta row + remove directory.
        let _ = mgr.with_meta(|conn| {
            conn.execute("DELETE FROM spaces WHERE id = ?1", params![id])?;
            Ok(())
        });
        mgr.close_space(&id);
        let _ = std::fs::remove_dir_all(&space_dir);
        return Err(seed_err);
    }

    Ok(SpaceSummary {
        id,
        name: input.name,
        has_password,
        created_at: now.clone(),
        updated_at: now,
    })
}

// ─── list ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_spaces(state: State<'_, DbManager>) -> Result<Vec<SpaceSummary>, DbError> {
    do_list_spaces(&state)
}

pub(crate) fn do_list_spaces(mgr: &DbManager) -> Result<Vec<SpaceSummary>, DbError> {
    mgr.with_meta(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, password_hash, created_at, updated_at
             FROM spaces ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([], row_to_summary)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ─── get ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_space(id: String, state: State<'_, DbManager>) -> Result<SpaceSummary, DbError> {
    do_get_space(&state, &id)
}

fn do_get_space(mgr: &DbManager, id: &str) -> Result<SpaceSummary, DbError> {
    mgr.with_meta(|conn| {
        conn.query_row(
            "SELECT id, name, password_hash, created_at, updated_at
             FROM spaces WHERE id = ?1",
            params![id],
            row_to_summary,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::SpaceNotFound(id.to_string()),
            other => DbError::Sqlite(other),
        })
    })
}

// ─── update ─────────────────────────────────────────────────────────────────
//
// `UpdateSpaceInput.name: Option<String>` — `Some` sets the name (subject to
// the UNIQUE constraint), `None` leaves it unchanged. `password` is NOT
// updatable here; use `set_space_password`.

#[tauri::command]
pub fn update_space(
    id: String,
    input: UpdateSpaceInput,
    state: State<'_, DbManager>,
) -> Result<SpaceSummary, DbError> {
    do_update_space(&state, &id, input)
}

fn do_update_space(
    mgr: &DbManager,
    id: &str,
    input: UpdateSpaceInput,
) -> Result<SpaceSummary, DbError> {
    let now = now_iso();
    // COALESCE keeps the existing name when `input.name` is None, so a partial
    // update leaves non-targeted columns untouched. `updated_at` always bumps.
    mgr.with_meta(|conn| {
        let res = conn.execute(
            "UPDATE spaces SET name = COALESCE(?1, name), updated_at = ?2 WHERE id = ?3",
            params![input.name, now, id],
        );
        match res {
            Ok(0) => Err(DbError::SpaceNotFound(id.to_string())),
            Ok(_) => Ok(()),
            Err(ref e) if is_unique_violation(e) => {
                Err(DbError::SpaceNameTaken(input.name.unwrap_or_default()))
            }
            Err(e) => Err(DbError::Sqlite(e)),
        }
    })?;
    // Read back the canonical row (AGENTS.md: read after mutation).
    do_get_space(mgr, id)
}

// ─── delete ─────────────────────────────────────────────────────────────────
//
// Cascade order (safest for Windows file-handle semantics):
//   1. verify password (outside any lock)
//   2. close_space — drop cached space.db + world.db connections so no open
//      handle blocks the directory removal
//   3. DELETE the meta row
//   4. evict from session state (last_opened + locked lists)
//   5. close the Space's OS window (if open) so it doesn't keep hitting
//      SpaceNotFound on every IPC after the meta row is gone
//   6. remove_dir_all(`spaces/{id}/`)

#[tauri::command]
pub fn delete_space(
    id: String,
    password: Option<String>,
    app: AppHandle,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    do_delete_space(Some(&app), &state, &id, password)
}

fn do_delete_space(
    app: Option<&AppHandle>,
    mgr: &DbManager,
    id: &str,
    password_arg: Option<String>,
) -> Result<(), DbError> {
    // 1. Read stored hash. (Lock released before verify.)
    let stored_hash = load_password_hash(mgr, id)?;

    // 2. If protected, require + verify the password argument OUTSIDE the lock.
    if let Some(stored) = stored_hash.as_deref() {
        let plain = password_arg.ok_or_else(|| DbError::SpacePasswordRequired(id.to_string()))?;
        let matched = password::verify_password(&plain, stored)?;
        if !matched {
            return Err(DbError::SpaceWrongPassword(id.to_string()));
        }
    }

    // 3. Drop cached connections (idempotent — no-op if the Space wasn't open).
    mgr.close_space(id);

    // 4. DELETE the meta row. rows_affected == 0 guards against the race
    //    where the row vanished between step 1 and now.
    let deleted = mgr.with_meta(|conn| {
        Ok(conn.execute("DELETE FROM spaces WHERE id = ?1", params![id])?)
    })?;
    if deleted == 0 {
        return Err(DbError::SpaceNotFound(id.to_string()));
    }

    // 5. Remove from session state (last_opened + locked lists). Without
    //    this the deleted Space's id lingers, causing the startup auto-open
    //    (ADR-0011) to target a non-existent window. Must run BEFORE the
    //    window close + directory removal so the session is consistent
    //    even if the file cleanup partially fails.
    mgr.with_meta(|conn| {
        let mut session = crate::commands::session::read_session(conn)?;
        session.locked_space_ids.retain(|s| s != id);
        if session.last_opened_space_id.as_deref() == Some(id) {
            session.last_opened_space_id = None;
        }
        crate::commands::session::write_session(conn, &session)?;
        Ok(())
    })?;

    // 6. Close the Space's OS window (if one is open). After step 4 the meta
    //    row is gone, so any further IPC from this window would resolve to
    //    SpaceNotFound — better to tear it down explicitly. `destroy()`
    //    asynchronously fires the `Destroyed` window event whose handler
    //    (lib.rs) calls `DbManager::close_space` again; that's idempotent.
    //    `app` is `None` only in unit tests that bypass the Tauri runtime.
    if let Some(app) = app {
        if let Some(w) = app.get_webview_window(&crate::window_manager::space_window_label(id))
        {
            let _ = w.destroy();
        }
    }

    // 7. Remove the Space's directory tree. Idempotent: if the dir is already
    //    gone (partial-cleanup recovery), treat as success.
    let space_dir = mgr.data_dir().join("spaces").join(id);
    if space_dir.exists() {
        std::fs::remove_dir_all(&space_dir)?;
    }
    Ok(())
}

// ─── set_space_password ─────────────────────────────────────────────────────
//
// Three modes keyed on `(current_password, new_password)`:
//   add    (None,  Some) — space must be unprotected
//   change (Some,  Some) — space must be protected + current must verify
//   remove (Some,  None) — space must be protected + current must verify
//   (None, None) is a no-op.
//
// Per plan T11, "add onto an already-protected space" and "change/remove on
// an unprotected space" both surface as `SpaceWrongPassword` rather than a
// dedicated code — the T5 error set is locked.

#[tauri::command]
pub fn set_space_password(
    id: String,
    input: SetSpacePasswordInput,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    do_set_space_password(&state, &id, input)
}

fn do_set_space_password(
    mgr: &DbManager,
    id: &str,
    input: SetSpacePasswordInput,
) -> Result<(), DbError> {
    // 1. Load stored hash (also serves as the existence check).
    let stored_hash = load_password_hash(mgr, id)?;

    // 2. Resolve the new hash. Verification/hashing runs OUTSIDE the meta lock.
    let new_hash: Option<String> = match (input.current_password, input.new_password) {
        // ADD: no current needed, but space must currently be unprotected.
        (None, Some(new)) => {
            if stored_hash.is_some() {
                return Err(DbError::SpaceWrongPassword(id.to_string()));
            }
            Some(password::hash_password(&new)?)
        }
        // CHANGE: verify current against the stored hash.
        (Some(cur), Some(new)) => {
            let stored = require_stored(id, &stored_hash)?;
            verify_or_wrong_password(id, &cur, stored)?;
            Some(password::hash_password(&new)?)
        }
        // REMOVE: verify current, then clear the hash.
        (Some(cur), None) => {
            let stored = require_stored(id, &stored_hash)?;
            verify_or_wrong_password(id, &cur, stored)?;
            None
        }
        // (None, None): nothing requested.
        (None, None) => return Ok(()),
    };

    // 3. Persist the new hash (or NULL) + bump updated_at.
    let now = now_iso();
    let updated = mgr.with_meta(|conn| {
        Ok(conn.execute(
            "UPDATE spaces SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_hash, now, id],
        )?)
    })?;
    if updated == 0 {
        return Err(DbError::SpaceNotFound(id.to_string()));
    }
    Ok(())
}

/// Returns the stored PHC string or `SpaceWrongPassword` if the space has no
/// password (change/remove against an unprotected space is a misuse).
fn require_stored<'a>(id: &str, stored: &'a Option<String>) -> Result<&'a str, DbError> {
    stored
        .as_deref()
        .ok_or_else(|| DbError::SpaceWrongPassword(id.to_string()))
}

/// Verifies `plain` against `stored_phc`; on mismatch returns
/// `SpaceWrongPassword`. Infrastructure errors (malformed PHC) propagate.
fn verify_or_wrong_password(id: &str, plain: &str, stored_phc: &str) -> Result<(), DbError> {
    let matched = password::verify_password(plain, stored_phc)?;
    if matched {
        Ok(())
    } else {
        Err(DbError::SpaceWrongPassword(id.to_string()))
    }
}

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Bootstrap a real `DbManager` against an isolated tempdir. The `TempDir`
    /// is bound first in the tuple so it drops AFTER the manager (Rust drops
    /// in reverse declaration order), ensuring SQLite connections close before
    /// the temp files vanish (matters for WAL on Windows).
    fn make_manager() -> (TempDir, DbManager) {
        let tmp = TempDir::new().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let mgr = DbManager::new(data_dir).expect("manager new");
        (tmp, mgr)
    }

    fn space_dir(mgr: &DbManager, id: &str) -> std::path::PathBuf {
        mgr.data_dir().join("spaces").join(id)
    }

    // ─── create ─────────────────────────────────────────────────────────────

    #[test]
    fn create_space_basic() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Alpha".into(),
                password: None,
            },
        )
        .expect("create unprotected space");

        assert_eq!(s.name, "Alpha");
        assert!(!s.has_password);
        assert!(!s.id.is_empty());
        assert_eq!(s.created_at, s.updated_at);
        assert!(space_dir(&mgr, &s.id).exists(), "space dir must be created");
    }

    #[test]
    fn create_space_with_password() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Vault".into(),
                password: Some("s3cret".into()),
            },
        )
        .expect("create protected space");

        assert!(s.has_password, "has_password must be true");
        assert!(space_dir(&mgr, &s.id).exists());
    }

    #[test]
    fn create_space_name_taken() {
        let (_tmp, mgr) = make_manager();
        let _first = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Dupe".into(),
                password: None,
            },
        )
        .expect("first create");
        let err = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Dupe".into(),
                password: None,
            },
        )
        .expect_err("duplicate name must reject");
        match err {
            DbError::SpaceNameTaken(name) => assert_eq!(name, "Dupe"),
            other => panic!("expected SpaceNameTaken, got {other:?}"),
        }
    }

    // ─── list ───────────────────────────────────────────────────────────────

    #[test]
    fn list_spaces_excludes_password_hash() {
        let (_tmp, mgr) = make_manager();
        do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "A".into(),
                password: None,
            },
        )
        .expect("create A");
        let protected = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "B".into(),
                password: Some("pw".into()),
            },
        )
        .expect("create B");

        let list = do_list_spaces(&mgr).expect("list");
        assert_eq!(list.len(), 2);

        // Serialize every summary and prove NO password hash leaks. The flag
        // `hasPassword` must be present; neither `passwordHash` nor
        // `password_hash` may appear anywhere in the JSON.
        for s in &list {
            let json = serde_json::to_string(s).expect("serialize");
            assert!(
                !json.contains("passwordHash") && !json.contains("password_hash"),
                "password hash must NOT appear in serialized SpaceSummary: {json}"
            );
            assert!(json.contains("hasPassword"), "hasPassword flag missing: {json}");
        }

        let b = list.iter().find(|s| s.id == protected.id).expect("B in list");
        assert!(b.has_password, "B should be flagged protected");
        let a = list.iter().find(|s| s.name == "A").expect("A in list");
        assert!(!a.has_password, "A should be flagged unprotected");
    }

    // ─── get ────────────────────────────────────────────────────────────────

    #[test]
    fn get_space_returns_summary() {
        let (_tmp, mgr) = make_manager();
        let created = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Lookup".into(),
                password: Some("pw".into()),
            },
        )
        .expect("create");
        let got = do_get_space(&mgr, &created.id).expect("get");
        assert_eq!(got.id, created.id);
        assert_eq!(got.name, "Lookup");
        assert!(got.has_password);
    }

    #[test]
    fn get_space_not_found() {
        let (_tmp, mgr) = make_manager();
        let err = do_get_space(&mgr, "no-such-id").expect_err("missing space");
        match err {
            DbError::SpaceNotFound(id) => assert_eq!(id, "no-such-id"),
            other => panic!("expected SpaceNotFound, got {other:?}"),
        }
    }

    // ─── update ─────────────────────────────────────────────────────────────

    #[test]
    fn update_space_renames() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Old".into(),
                password: None,
            },
        )
        .expect("create");
        let updated = do_update_space(
            &mgr,
            &s.id,
            UpdateSpaceInput {
                name: Some("New".into()),
            },
        )
        .expect("update");
        assert_eq!(updated.name, "New");
        assert_eq!(updated.id, s.id);
        // updated_at advanced (or stayed equal if within 1ms; just check it's
        // present and >= created_at).
        assert!(updated.updated_at >= updated.created_at);
    }

    #[test]
    fn update_space_name_taken() {
        let (_tmp, mgr) = make_manager();
        let _a = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "First".into(),
                password: None,
            },
        )
        .expect("create A");
        let b = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Second".into(),
                password: None,
            },
        )
        .expect("create B");
        let err = do_update_space(
            &mgr,
            &b.id,
            UpdateSpaceInput {
                name: Some("First".into()),
            },
        )
        .expect_err("rename to taken name must reject");
        match err {
            DbError::SpaceNameTaken(name) => assert_eq!(name, "First"),
            other => panic!("expected SpaceNameTaken, got {other:?}"),
        }
    }

    #[test]
    fn update_space_not_found() {
        let (_tmp, mgr) = make_manager();
        let err = do_update_space(
            &mgr,
            "ghost",
            UpdateSpaceInput {
                name: Some("X".into()),
            },
        )
        .expect_err("update missing space");
        assert!(matches!(err, DbError::SpaceNotFound(_)));
    }

    // ─── delete ─────────────────────────────────────────────────────────────

    #[test]
    fn delete_space_unprotected_succeeds() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Open".into(),
                password: None,
            },
        )
        .expect("create");
        do_delete_space(None, &mgr, &s.id, None).expect("delete unprotected needs no password");
        // Row is gone.
        let err = do_get_space(&mgr, &s.id).expect_err("space should be gone");
        assert!(matches!(err, DbError::SpaceNotFound(_)));
    }

    #[test]
    fn delete_space_requires_password_when_protected() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Locked".into(),
                password: Some("pw".into()),
            },
        )
        .expect("create");
        let err = do_delete_space(None, &mgr, &s.id, None).expect_err("must require password");
        match err {
            DbError::SpacePasswordRequired(id) => assert_eq!(id, s.id),
            other => panic!("expected SpacePasswordRequired, got {other:?}"),
        }
        // Space still exists (the rejection did NOT cascade).
        assert!(do_get_space(&mgr, &s.id).is_ok(), "space must still exist");
        assert!(space_dir(&mgr, &s.id).exists(), "space dir must still exist");
    }

    #[test]
    fn delete_space_wrong_password() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Locked".into(),
                password: Some("correct".into()),
            },
        )
        .expect("create");
        let err = do_delete_space(None, &mgr, &s.id, Some("wrong".into()))
            .expect_err("wrong password must reject");
        match err {
            DbError::SpaceWrongPassword(id) => assert_eq!(id, s.id),
            other => panic!("expected SpaceWrongPassword, got {other:?}"),
        }
        // Nothing was cascaded.
        assert!(do_get_space(&mgr, &s.id).is_ok(), "space must still exist");
        assert!(space_dir(&mgr, &s.id).exists(), "dir must still exist");
    }

    #[test]
    fn delete_space_cascades_dir_removal() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Doomed".into(),
                password: Some("pw".into()),
            },
        )
        .expect("create");
        let dir = space_dir(&mgr, &s.id);
        assert!(dir.exists(), "dir exists pre-delete");

        do_delete_space(None, &mgr, &s.id, Some("pw".into())).expect("delete with correct password");

        assert!(!dir.exists(), "dir must be removed after cascade delete");
        let err = do_get_space(&mgr, &s.id).expect_err("row must be gone");
        assert!(matches!(err, DbError::SpaceNotFound(_)));
    }

    #[test]
    fn delete_space_not_found() {
        let (_tmp, mgr) = make_manager();
        let err = do_delete_space(None, &mgr, "phantom", None).expect_err("delete missing");
        assert!(matches!(err, DbError::SpaceNotFound(_)));
    }

    /// Regression guard: deleting a Space evicts it from the persisted session
    /// state (last_opened + locked lists). Without this the deleted Space's id
    /// would linger, causing the startup auto-open (ADR-0011) to target a
    /// non-existent window.
    #[test]
    fn delete_space_evicts_from_session_state() {
        let (_tmp, mgr) = make_manager();
        let a = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "A".into(),
                password: None,
            },
        )
        .expect("create A");
        let b = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "B".into(),
                password: None,
            },
        )
        .expect("create B");

        // Open both — B becomes last_opened (last opened wins).
        crate::commands::session::open_space_impl(&a.id, None, &mgr).expect("open A");
        crate::commands::session::open_space_impl(&b.id, None, &mgr).expect("open B");

        // Sanity: B is last_opened.
        let before = crate::commands::session::get_session_impl(&mgr).expect("session");
        assert_eq!(before.last_opened_space_id.as_deref(), Some(b.id.as_str()));

        // Delete B (the last_opened Space).
        do_delete_space(None, &mgr, &b.id, None).expect("delete B");

        // Session must reflect the eviction: B cleared from last_opened.
        let after = crate::commands::session::get_session_impl(&mgr).expect("session");
        assert_ne!(
            after.last_opened_space_id.as_deref(),
            Some(b.id.as_str()),
            "deleted Space must be cleared from last_opened"
        );
    }

    /// Deleting a locked Space also removes it from `locked_space_ids`.
    #[test]
    fn delete_space_evicts_from_locked_list() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Prot".into(),
                password: Some("pw".into()),
            },
        )
        .expect("create protected");

        // Open in locked state (no password) — ADR-0008.
        crate::commands::session::open_space_impl(&s.id, None, &mgr).expect("open locked");
        let before = crate::commands::session::get_session_impl(&mgr).expect("session");
        assert!(before.locked_space_ids.contains(&s.id));

        // Delete with correct password.
        do_delete_space(None, &mgr, &s.id, Some("pw".into())).expect("delete");

        let after = crate::commands::session::get_session_impl(&mgr).expect("session");
        assert!(
            !after.locked_space_ids.contains(&s.id),
            "deleted Space must be evicted from locked list"
        );
        assert_ne!(
            after.last_opened_space_id.as_deref(),
            Some(s.id.as_str()),
            "deleted Space must be cleared from last_opened"
        );
    }

    // ─── set_space_password lifecycle ───────────────────────────────────────

    #[test]
    fn set_space_password_add_change_remove() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "Lifecycle".into(),
                password: None,
            },
        )
        .expect("create unprotected");

        // ADD: no current password needed.
        do_set_space_password(
            &mgr,
            &s.id,
            SetSpacePasswordInput {
                current_password: None,
                new_password: Some("first".into()),
            },
        )
        .expect("add password");
        assert!(
            do_get_space(&mgr, &s.id).unwrap().has_password,
            "has_password after add"
        );

        // CHANGE: must supply the correct current password.
        do_set_space_password(
            &mgr,
            &s.id,
            SetSpacePasswordInput {
                current_password: Some("first".into()),
                new_password: Some("second".into()),
            },
        )
        .expect("change password");
        // The old password no longer verifies against the space: prove it via
        // delete_space (wrong pw rejects, new pw succeeds).
        do_delete_space(None, &mgr, &s.id, Some("first".into()))
            .expect_err("old password must no longer work");
        // (Don't actually delete yet — cancel by checking it rejected.)

        // REMOVE: must supply the correct current password (the NEW one).
        do_set_space_password(
            &mgr,
            &s.id,
            SetSpacePasswordInput {
                current_password: Some("second".into()),
                new_password: None,
            },
        )
        .expect("remove password");
        assert!(
            !do_get_space(&mgr, &s.id).unwrap().has_password,
            "has_password must be false after remove"
        );

        // Now unprotected — delete without a password should succeed.
        do_delete_space(None, &mgr, &s.id, None).expect("delete after password removal");
    }

    #[test]
    fn set_space_password_add_when_already_protected_errors() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "P".into(),
                password: Some("original".into()),
            },
        )
        .expect("create protected");
        // ADD (current=None) onto a protected space must reject.
        let err = do_set_space_password(
            &mgr,
            &s.id,
            SetSpacePasswordInput {
                current_password: None,
                new_password: Some("new".into()),
            },
        )
        .expect_err("add onto protected must reject");
        assert!(matches!(err, DbError::SpaceWrongPassword(_)));
        // Stored hash is unchanged — the original password still works.
        do_delete_space(None, &mgr, &s.id, Some("original".into()))
            .expect("original password must still work");
    }

    #[test]
    fn set_space_password_change_with_wrong_current_errors() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "P".into(),
                password: Some("right".into()),
            },
        )
        .expect("create protected");
        let err = do_set_space_password(
            &mgr,
            &s.id,
            SetSpacePasswordInput {
                current_password: Some("wrong".into()),
                new_password: Some("new".into()),
            },
        )
        .expect_err("wrong current must reject");
        assert!(matches!(err, DbError::SpaceWrongPassword(_)));
        // new password was NOT set.
        do_delete_space(None, &mgr, &s.id, Some("new".into()))
            .expect_err("new password must not be active");
        do_delete_space(None, &mgr, &s.id, Some("right".into()))
            .expect("right password still works");
    }

    #[test]
    fn set_space_password_remove_with_wrong_current_errors() {
        let (_tmp, mgr) = make_manager();
        let s = do_create_space(
            &mgr,
            CreateSpaceInput {
                name: "P".into(),
                password: Some("keep".into()),
            },
        )
        .expect("create protected");
        let err = do_set_space_password(
            &mgr,
            &s.id,
            SetSpacePasswordInput {
                current_password: Some("nope".into()),
                new_password: None,
            },
        )
        .expect_err("wrong current must reject remove");
        assert!(matches!(err, DbError::SpaceWrongPassword(_)));
        // Password still in place.
        assert!(
            do_get_space(&mgr, &s.id).unwrap().has_password,
            "password must still be set"
        );
    }

    #[test]
    fn set_space_password_not_found() {
        let (_tmp, mgr) = make_manager();
        let err = do_set_space_password(
            &mgr,
            "ghost",
            SetSpacePasswordInput {
                current_password: None,
                new_password: Some("x".into()),
            },
        )
        .expect_err("set pw on missing space");
        assert!(matches!(err, DbError::SpaceNotFound(_)));
    }

    /// Regression guard: a SpaceSummary serialized for the frontend carries
    /// the camelCase `hasPassword` field and NEVER a `passwordHash` field.
    #[test]
    fn space_summary_serialization_shape() {
        let s = SpaceSummary {
            id: "abc".into(),
            name: "N".into(),
            has_password: true,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"hasPassword\":true"), "json: {json}");
        assert!(!json.contains("passwordHash"), "leak in json: {json}");
        assert!(
            !json.contains("password_hash"),
            "snake_case leak in json: {json}"
        );
    }
}
