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
        assert!(
            json.contains("hasPassword"),
            "hasPassword flag missing: {json}"
        );
    }

    let b = list
        .iter()
        .find(|s| s.id == protected.id)
        .expect("B in list");
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
    assert!(
        space_dir(&mgr, &s.id).exists(),
        "space dir must still exist"
    );
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
    do_delete_space(None, &mgr, &s.id, Some("right".into())).expect("right password still works");
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
