use super::*;
use crate::testutil::{make_space_with_world, with_world, WorldFixture};

fn input(parent: Option<String>, kind: NoteKind, title: &str, content: &str) -> CreateNoteInput {
    CreateNoteInput {
        parent_id: parent,
        kind,
        title: title.to_string(),
        content: content.to_string(),
    }
}

fn create(fx: &WorldFixture, parent: Option<String>, kind: NoteKind, title: &str) -> Note {
    do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(parent, kind, title, ""),
        None,
    )
    .expect("create note")
}

/// Raw `(parent_id, kind, title, content, position)` of one row.
fn note_row(fx: &WorldFixture, id: &str) -> (Option<String>, String, String, String, i64) {
    with_world(fx, |conn| {
        Ok(conn.query_row(
            "SELECT parent_id, kind, title, content, position FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?)
    })
    .expect("read note row")
}

/// `(id, position)` of one parent's children in position order
/// (`parent_id IS ?1` — NULL-safe root scope).
fn sibling_positions(fx: &WorldFixture, parent: Option<&str>) -> Vec<(String, i64)> {
    with_world(fx, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, position FROM notes WHERE parent_id IS ?1 ORDER BY position, id",
        )?;
        let rows = stmt
            .query_map(params![parent], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("read sibling positions")
}

/// Root + child creation, folder content forcing, parent-kind and
/// parent-existence guards (task C1).
#[test]
fn create_note_root_child_and_folder_content_forcing() {
    let fx = make_space_with_world();

    // Root note lands at position 0 with its content.
    let n = do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(None, NoteKind::Note, "Root note", "hello"),
        None,
    )
    .expect("root note");
    assert_eq!(n.parent_id, None);
    assert_eq!(n.position, 0);
    assert_eq!(n.content, "hello");

    // Folder content is forced to '' even when the caller sends some.
    let f = do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(None, NoteKind::Folder, "Folder", "must be dropped"),
        None,
    )
    .expect("root folder");
    let (_, kind, _, content, _) = note_row(&fx, &f.id);
    assert_eq!(kind, "folder");
    assert_eq!(content, "", "folder content must be forced to ''");

    // Child note under the folder: appended after existing siblings.
    let c1 = create(&fx, Some(f.id.clone()), NoteKind::Note, "Child 1");
    let c2 = create(&fx, Some(f.id.clone()), NoteKind::Note, "Child 2");
    assert_eq!(c1.parent_id.as_deref(), Some(f.id.as_str()));
    assert_eq!(c1.position, 0);
    assert_eq!(c2.position, 1);

    // Child under a "note" kind → NoteParentNotFolder.
    let err = do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(Some(n.id.clone()), NoteKind::Note, "Bad", ""),
        None,
    )
    .expect_err("note cannot be a parent");
    assert!(matches!(err, DbError::NoteParentNotFolder(id) if id == n.id));

    // Child under a nonexistent parent → business NotFound("Note").
    let err = do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(Some("no-such-parent".into()), NoteKind::Note, "Bad", ""),
        None,
    )
    .expect_err("missing parent");
    assert!(matches!(err, DbError::NotFound("Note", id) if id == "no-such-parent"));
}

/// Sibling title uniqueness via `idx_notes_sibling_title`
/// (`IFNULL(parent_id,'') + title` — spans folders and notes, NULL-safe
/// root scope), mapped to `NoteDuplicateTitle` at create and rename
/// sites (task C2).
#[test]
fn sibling_title_uniqueness() {
    let fx = make_space_with_world();
    let _t = create(&fx, None, NoteKind::Note, "T");

    // Same title, same (root) parent → rejected.
    let err = do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(None, NoteKind::Note, "T", ""),
        None,
    )
    .expect_err("duplicate root title");
    assert!(matches!(err, DbError::NoteDuplicateTitle(t) if t == "T"));

    // Same title under a DIFFERENT parent → fine.
    let f = create(&fx, None, NoteKind::Folder, "F");
    create(&fx, Some(f.id.clone()), NoteKind::Note, "T");

    // Root-folder kind doesn't dodge the index either — folders and
    // notes share one sibling namespace.
    let err = do_create_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &input(None, NoteKind::Folder, "T", ""),
        None,
    )
    .expect_err("folder may not steal a root note's title");
    assert!(matches!(err, DbError::NoteDuplicateTitle(_)));

    // Rename onto a sibling's title → same business error at the
    // update site; the row keeps its old title.
    let b = create(&fx, None, NoteKind::Note, "B");
    let err = do_update_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &b.id,
        &UpdateNoteInput {
            title: "T".into(),
            content: String::new(),
        },
        None,
    )
    .expect_err("rename collision");
    assert!(matches!(err, DbError::NoteDuplicateTitle(t) if t == "T"));
    let (_, _, title, _, _) = note_row(&fx, &b.id);
    assert_eq!(title, "B", "rejected rename must not stick");
}

/// move_note cycle guard (ancestor walk), parent-kind guard, and the
/// always-legal root target (task C3).
#[test]
fn move_note_cycle_guard() {
    let fx = make_space_with_world();
    let a = create(&fx, None, NoteKind::Folder, "A");
    let b = create(&fx, Some(a.id.clone()), NoteKind::Folder, "B");

    // Direct: A under its own child B.
    let err = do_move_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        Some(&b.id),
        0,
        None,
    )
    .expect_err("parent under its own child");
    assert!(matches!(err, DbError::NoteMoveCycle(id) if id == a.id));

    // Deeper chain A←B←C: moving A under C is still a cycle.
    let c = create(&fx, Some(b.id.clone()), NoteKind::Folder, "C");
    let err = do_move_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        Some(&c.id),
        0,
        None,
    )
    .expect_err("ancestor under its descendant");
    assert!(matches!(err, DbError::NoteMoveCycle(_)));

    // A root folder may not move under a LEAF note.
    let leaf = create(&fx, None, NoteKind::Note, "Leaf");
    let err = do_move_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &a.id,
        Some(&leaf.id),
        0,
        None,
    )
    .expect_err("folder under a leaf note");
    assert!(matches!(err, DbError::NoteParentNotFolder(id) if id == leaf.id));

    // Moving to root (None) is always legal — even out of a folder.
    let moved = do_move_note(&fx.mgr, &fx.space_id, &fx.world_id, &b.id, None, 0, None)
        .expect("move to root");
    assert_eq!(moved.parent_id, None);
    let (parent, _, _, _, position) = note_row(&fx, &b.id);
    assert_eq!(parent, None);
    assert_eq!(position, 0, "root renumber puts the moved note first");
}

/// move_note clamps out-of-range indexes and rewrites the target
/// sibling set contiguously (task C4).
#[test]
fn move_note_index_clamping_and_renumber() {
    let fx = make_space_with_world();
    let f = create(&fx, None, NoteKind::Folder, "F");
    let x = create(&fx, Some(f.id.clone()), NoteKind::Note, "x");
    let y = create(&fx, Some(f.id.clone()), NoteKind::Note, "y");
    let z = create(&fx, Some(f.id.clone()), NoteKind::Note, "z");
    let m = create(&fx, None, NoteKind::Note, "m");

    // index 99 (beyond len) → clamps to last.
    do_move_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &m.id,
        Some(&f.id),
        99,
        None,
    )
    .expect("clamped move");
    assert_eq!(
        sibling_positions(&fx, Some(&f.id)),
        vec![
            (x.id.clone(), 0),
            (y.id.clone(), 1),
            (z.id.clone(), 2),
            (m.id.clone(), 3),
        ],
        "index 99 must land last with contiguous 0..=3 positions"
    );

    // index -5 (negative) → clamps to first.
    let w = create(&fx, None, NoteKind::Note, "w");
    do_move_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &w.id,
        Some(&f.id),
        -5,
        None,
    )
    .expect("clamped move to front");
    assert_eq!(
        sibling_positions(&fx, Some(&f.id)),
        vec![
            (w.id.clone(), 0),
            (x.id.clone(), 1),
            (y.id.clone(), 2),
            (z.id.clone(), 3),
            (m.id.clone(), 4),
        ],
        "index -5 must land first with contiguous 0..=4 positions"
    );
}

/// reorder_notes is parent-scoped (`parent_id IS ?1`, NULL-safe for the
/// root scope), rejects ids under other parents, and needs no
/// temporary-shift dance — there is no UNIQUE(parent_id, position)
/// (task C5).
#[test]
fn reorder_notes_parent_scoped_and_null_safe() {
    let fx = make_space_with_world();
    let p = create(&fx, None, NoteKind::Folder, "P");
    let a = create(&fx, Some(p.id.clone()), NoteKind::Note, "a");
    let b = create(&fx, Some(p.id.clone()), NoteKind::Note, "b");

    // Swap [b, a] under P — writing b→0 while a still holds 0 proves
    // no UNIQUE(parent_id, position) exists mid-transaction.
    do_reorder_notes(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        Some(&p.id),
        &[b.id.clone(), a.id.clone()],
        None,
    )
    .expect("reorder under parent");
    let positions = sibling_positions(&fx, Some(&p.id));
    assert!(positions.contains(&(a.id.clone(), 1)));
    assert!(positions.contains(&(b.id.clone(), 0)));

    // An id under a DIFFERENT parent is not in scope → NotFound.
    let other = create(&fx, None, NoteKind::Folder, "Other");
    let q = create(&fx, Some(other.id.clone()), NoteKind::Note, "q");
    let err = do_reorder_notes(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        Some(&p.id),
        std::slice::from_ref(&q.id),
        None,
    )
    .expect_err("foreign-parent id must reject");
    assert!(matches!(err, DbError::NotFound("Note", id) if id == q.id));

    // Root scope: `None` targets the NULL root siblings (NULL-safe IS).
    let r1 = create(&fx, None, NoteKind::Note, "r1");
    let r2 = create(&fx, None, NoteKind::Note, "r2");
    do_reorder_notes(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        None,
        &[r2.id.clone(), r1.id.clone()],
        None,
    )
    .expect("root reorder");
    let root = sibling_positions(&fx, None);
    assert!(root.contains(&(r2.id.clone(), 0)));
    assert!(root.contains(&(r1.id.clone(), 1)));
}

/// delete_note cascades the whole subtree (self-FK ON DELETE CASCADE)
/// and deliberately leaves position gaps among the surviving siblings
/// (ADR-0038 §5 — ORDER BY position absorbs them).
#[test]
fn delete_note_cascades_subtree_and_keeps_gaps() {
    let fx = make_space_with_world();
    let x = create(&fx, None, NoteKind::Note, "x"); // root pos 0
    let g = create(&fx, None, NoteKind::Folder, "g"); // root pos 1
    let z = create(&fx, None, NoteKind::Note, "z"); // root pos 2
    let h = create(&fx, Some(g.id.clone()), NoteKind::Folder, "h");
    let i = create(&fx, Some(h.id.clone()), NoteKind::Note, "i");

    do_delete_note(&fx.mgr, &fx.space_id, &fx.world_id, &g.id, None).expect("delete subtree");

    for gone in [&g.id, &h.id, &i.id] {
        let rows: i64 = with_world(&fx, |conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE id = ?1",
                params![gone],
                |row| row.get(0),
            )?)
        })
        .expect("count gone");
        assert_eq!(rows, 0, "{gone} must be cascade-deleted");
    }

    // Surviving siblings keep their positions — the gap at 1 remains.
    assert_eq!(
        sibling_positions(&fx, None),
        vec![(x.id.clone(), 0), (z.id.clone(), 2)],
        "gap at position 1 must remain by design"
    );
}

/// update_note is title+content only — parent_id and position are
/// byte-identical after the update (the agent contract, ADR-0038 §6).
/// Folder rows also force content back to '' on update.
#[test]
fn update_note_never_touches_parent_or_position() {
    let fx = make_space_with_world();
    let f = create(&fx, None, NoteKind::Folder, "F");
    let _s1 = create(&fx, Some(f.id.clone()), NoteKind::Note, "s1");
    let s2 = create(&fx, Some(f.id.clone()), NoteKind::Note, "s2");

    let updated = do_update_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &s2.id,
        &UpdateNoteInput {
            title: "renamed".into(),
            content: "new body".into(),
        },
        None,
    )
    .expect("update note");
    assert_eq!(updated.parent_id.as_deref(), Some(f.id.as_str()));
    assert_eq!(updated.position, 1);

    let (parent, kind, title, content, position) = note_row(&fx, &s2.id);
    assert_eq!(
        parent.as_deref(),
        Some(f.id.as_str()),
        "parent_id unchanged"
    );
    assert_eq!(position, 1, "position unchanged");
    assert_eq!(kind, "note");
    assert_eq!(title, "renamed");
    assert_eq!(content, "new body");

    // Folder update: rename sticks, content is re-forced to ''.
    let f2 = do_update_note(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &f.id,
        &UpdateNoteInput {
            title: "F2".into(),
            content: "junk".into(),
        },
        None,
    )
    .expect("update folder");
    assert_eq!(f2.title, "F2");
    assert_eq!(f2.content, "", "folder content re-forced on update");
    let (parent, _, _, content, position) = note_row(&fx, &f.id);
    assert_eq!(parent, None, "folder parent unchanged");
    assert_eq!(position, 0, "folder position unchanged");
    assert_eq!(content, "");
}
