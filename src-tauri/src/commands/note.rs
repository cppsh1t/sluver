//! Notes IPC: single-table Folder/Note tree CRUD + reorder + reparent +
//! match-centric search (ADR-0038 storage shape, ADR-0037 agent access
//! policy).
//!
//! Storage shape: one `notes` table behind a `kind` discriminator;
//! `parent_id` is a self-referential adjacency list — the codebase's FIRST
//! (all other hierarchy is fixed-depth via distinct parent tables).
//! Consequences that shape this file:
//!   - Sibling title uniqueness spans folders and notes (NULL-safe unique
//!     index). Duplicate-title violations surface as `INTERNAL_ERROR` with
//!     a raw SQLite message — a friendly variant is deliberately deferred
//!     (ADR-0038 Consequences); do NOT add a DuplicateName-style variant.
//!   - NO `UNIQUE(parent_id, position)` (the scene_images precedent):
//!     reorder writes `position = index` directly — no temporary-shift
//!     dance anywhere in this file.
//!   - Deletion leaves position gaps (no renumbering writes); ORDER BY
//!     position absorbs them; `reorder_notes` is the only renumbering
//!     path (ADR-0038 §5).
//!   - `move_note` cycle prevention is an application-layer ancestor walk
//!     inside the move's transaction (ADR-0038 §4).
//!   - NULL-safe parent comparisons use `parent_id IS ?1` — `= ?1` never
//!     matches the NULL root scope.
//!
//! `grep_notes` mirrors `commands/grep.rs` semantics exactly (ADR-0035,
//! applied to the notes corpus per ADR-0037's amendment): SQL LIKE
//! prefilter → in-memory literal scan with ASCII case folding,
//! field-grouped match groups, three-part snippets, 50-group offset pages,
//! deterministic ordering. It reuses grep.rs's scan primitives so the two
//! corpora cannot drift.
//!
//! Logging (ADR-0014 / ADR-0016): note titles and content are the author's
//! private material — NEVER logged at any level — and `grep_notes`'s query
//! is user creative content too (the grep.rs red line). Only ids, counts,
//! and aggregate outcomes appear in log records.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, State};

use crate::commands::events::emit_entity_changed;
use crate::commands::grep::{fold_ascii, like_pattern, scan_text_field};
use crate::db::{DbError, DbManager};
use crate::models::note::{
    CreateNoteInput, GrepNotesInput, GrepNotesResponse, Note, NoteKind, NoteMatchGroup,
    NoteSnippet, NoteSummary, UpdateNoteInput,
};
use crate::models::grep::GrepSnippet;
use crate::util::{new_id, now_iso};

/// Soft ceiling on match groups returned per page — mirrors `grep.rs`
/// (ADR-0035 §5, amended; ADR-0037 amendment applies it to notes).
const MAX_GROUPS: usize = 50;

// ─── helpers ────────────────────────────────────────────────────────────────

/// Parse the `kind` column's TEXT into [`NoteKind`]. The CHECK constraint
/// makes the fallback arm unreachable for rows written through normal
/// paths; hand-edited DBs get a descriptive `INTERNAL_ERROR`.
fn parse_kind(raw: &str, id: &str) -> Result<NoteKind, DbError> {
    NoteKind::from_db_str(raw)
        .ok_or_else(|| DbError::Internal(format!("corrupt notes.kind '{raw}' on row {id}")))
}

fn load_note(conn: &Connection, id: &str) -> Result<Note, DbError> {
    let (parent_id, kind_raw, title, content, position, created_at, updated_at) = conn
        .query_row(
            "SELECT parent_id, kind, title, content, position, created_at, updated_at
             FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>("parent_id")?,
                    row.get::<_, String>("kind")?,
                    row.get::<_, String>("title")?,
                    row.get::<_, String>("content")?,
                    row.get::<_, i64>("position")?,
                    row.get::<_, String>("created_at")?,
                    row.get::<_, String>("updated_at")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Note", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    Ok(Note {
        id: id.to_string(),
        parent_id,
        kind: parse_kind(&kind_raw, id)?,
        title,
        content,
        position,
        created_at,
        updated_at,
    })
}

/// Verify a would-be parent exists AND is a folder. Missing parent →
/// business `NotFound("Note", parent_id)` (the scene-image precedent: a
/// plain FK violation would surface as an opaque SQLite error); wrong kind
/// → `NoteParentNotFolder`. Shared by `create_note` and `move_note`.
fn ensure_parent_is_folder(conn: &Connection, parent_id: &str) -> Result<(), DbError> {
    let kind: String = conn
        .query_row(
            "SELECT kind FROM notes WHERE id = ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Note", parent_id.to_string()),
            other => DbError::Sqlite(other),
        })?;
    if kind != NoteKind::Folder.as_db_str() {
        return Err(DbError::NoteParentNotFolder(parent_id.to_string()));
    }
    Ok(())
}

/// Append position among siblings under `parent_id` (`None` = root scope):
/// `COALESCE(MAX(position), -1) + 1` inside the caller's transaction.
///
/// The comparison is `parent_id IS ?1` — NULL-safe. `parent_id = ?1` would
/// never match the NULL root scope and silently scope the MAX to non-root
/// siblings only.
fn next_sibling_position(conn: &Connection, parent_id: Option<&str>) -> Result<i64, DbError> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM notes WHERE parent_id IS ?1",
        params![parent_id],
        |row| row.get(0),
    )?)
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/// Map a raw SQLite UNIQUE violation on `idx_notes_sibling_title` to the
/// `NoteDuplicateTitle` business error (ADR-0038 §2). The index fires on
/// create (duplicate title under the parent), rename (title taken by a
/// sibling), and move (target folder already holds that title) — without
/// this mapping the user sees an opaque INTERNAL_ERROR carrying raw SQLite
/// text.
fn map_sibling_title_violation(err: DbError, title: &str) -> DbError {
    match &err {
        // The index name lives in the `SqliteFailure` variant's message
        // string (ffi::Error itself carries only the codes).
        DbError::Sqlite(rusqlite::Error::SqliteFailure(e, Some(msg)))
            if e.code == rusqlite::ErrorCode::ConstraintViolation
                && msg.contains("idx_notes_sibling_title") =>
        {
            DbError::NoteDuplicateTitle(title.to_string())
        }
        _ => err,
    }
}

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_note(
    space_id: String,
    world_id: String,
    input: CreateNoteInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Note, DbError> {
    let note = do_create_note(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", note.id.as_str());
    Ok(note)
}

/// Testable core of [`create_note`] (the `do_*` convention — see
/// `commands/space.rs::do_delete_space`): `app` is `None` only in unit
/// tests that bypass the Tauri runtime.
pub(crate) fn do_create_note(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateNoteInput,
    app: Option<&AppHandle>,
) -> Result<Note, DbError> {
    let id = new_id();
    let now = now_iso();
    // Folders are pure structural containers — content is forced to ''
    // (ADR-0038 §1) regardless of what the caller sent.
    let content = match input.kind {
        NoteKind::Folder => String::new(),
        NoteKind::Note => input.content.clone(),
    };

    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        // Parent pre-check → business NotFound / NoteParentNotFolder (an
        // opaque FK violation on INSERT is not a branchable contract).
        if let Some(parent_id) = input.parent_id.as_deref() {
            ensure_parent_is_folder(&tx, parent_id)?;
        }

        let position = next_sibling_position(&tx, input.parent_id.as_deref())?;

        tx.execute(
            "INSERT INTO notes (id, parent_id, kind, title, content, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                input.parent_id,
                input.kind.as_db_str(),
                input.title,
                content,
                position,
                now,
                now
            ],
        )
        .map_err(|e| map_sibling_title_violation(e.into(), &input.title))?;
        tx.commit()?;

        load_note(conn, &id)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "note",
                Some(entity.id.clone()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_note(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Note, DbError> {
    state.with_world(&space_id, &world_id, |conn| load_note(conn, &id))
}

/// One flat SELECT without `content` — the client builds the tree from it
/// (ADR-0038 §1: "one SELECT ... with client-side grouping", the list_x
/// no-N+1 convention). `ORDER BY parent_id` groups siblings; the NULL root
/// scope sorts first under SQLite ASC semantics.
#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_notes(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<NoteSummary>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        struct NoteRaw {
            id: String,
            parent_id: Option<String>,
            kind: String,
            title: String,
            position: i64,
            created_at: String,
            updated_at: String,
        }
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, kind, title, position, created_at, updated_at
             FROM notes
             ORDER BY parent_id, position",
        )?;
        let raws: Vec<NoteRaw> = stmt
            .query_map([], |row| {
                Ok(NoteRaw {
                    id: row.get("id")?,
                    parent_id: row.get("parent_id")?,
                    kind: row.get("kind")?,
                    title: row.get("title")?,
                    position: row.get("position")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let result: Vec<NoteSummary> = raws
            .into_iter()
            .map(|raw| {
                Ok(NoteSummary {
                    kind: parse_kind(&raw.kind, &raw.id)?,
                    id: raw.id,
                    parent_id: raw.parent_id,
                    title: raw.title,
                    position: raw.position,
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                })
            })
            .collect::<Result<Vec<_>, DbError>>()?;
        Ok(result)
    })
}

/// Full replacement of title + content ONLY — never parent/position (the
/// agent contract, ADR-0038 §6). Updating a folder is legal (it renames
/// the folder); the row-level `CASE` forces content back to '' for folder
/// rows so the invariant survives even if a caller sends non-empty
/// content.
#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_note(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateNoteInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Note, DbError> {
    do_update_note(&state, &space_id, &world_id, &id, &input, Some(&app))
}

/// Testable core of [`update_note`] (the `do_*` convention).
pub(crate) fn do_update_note(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateNoteInput,
    app: Option<&AppHandle>,
) -> Result<Note, DbError> {
    let now = now_iso();

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn
            .execute(
                "UPDATE notes
                 SET title = ?1,
                     content = CASE WHEN kind = 'folder' THEN '' ELSE ?2 END,
                     updated_at = ?3
                 WHERE id = ?4",
                params![input.title, input.content, now, id],
            )
            .map_err(|e| map_sibling_title_violation(e.into(), &input.title))?;
        if updated == 0 {
            return Err(DbError::NotFound("Note", id.to_string()));
        }
        load_note(conn, id)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "note",
                Some(entity.id.clone()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

/// Plain delete — `ON DELETE CASCADE` removes all descendants (the UI
/// shows the ADR-0006-style pre-delete disclosure BEFORE calling).
/// Sibling positions keep their gaps: `ORDER BY position` absorbs them,
/// and delete-then-renumber is a pointless write burst (ADR-0038 §5).
#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_note(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_note(&state, &space_id, &world_id, &id, Some(&app))
}

/// Testable core of [`delete_note`] (the `do_*` convention).
pub(crate) fn do_delete_note(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Note", id.to_string()));
        }
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(app, "note", Some(id.to_string()), space_id, Some(world_id));
        }
    }
    result
}

/// Full-list reorder contract (position = index, same as
/// `reorder_chapters`) scoped to one parent's siblings — but WITHOUT the
/// temporary-shift dance: no `UNIQUE(parent_id, position)` exists
/// (ADR-0038 §3), so per-row updates run directly. The scope comparison
/// is `parent_id IS ?1` (NULL-safe — `None` targets the root siblings).
#[tracing::instrument(skip(state, note_ids, app))]
#[tauri::command]
pub fn reorder_notes(
    space_id: String,
    world_id: String,
    parent_id: Option<String>,
    note_ids: Vec<String>,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_reorder_notes(
        &state,
        &space_id,
        &world_id,
        parent_id.as_deref(),
        &note_ids,
        Some(&app),
    )
}

/// Testable core of [`reorder_notes`] (the `do_*` convention).
pub(crate) fn do_reorder_notes(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    parent_id: Option<&str>,
    note_ids: &[String],
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;
        for (i, note_id) in note_ids.iter().enumerate() {
            let pos = i as i64;
            let affected = tx.execute(
                "UPDATE notes SET position = ?1 WHERE id = ?2 AND parent_id IS ?3",
                params![pos, note_id, parent_id],
            )?;
            if affected == 0 {
                return Err(DbError::NotFound("Note", note_id.clone()));
            }
        }
        tx.commit()?;
        Ok(())
    });
    if result.is_ok() {
        if let Some(app) = app {
            emit_entity_changed(app, "note", None, space_id, Some(world_id));
        }
    }
    result
}

/// Reparent + reposition one node in a single transaction. The UI-only
/// structural surface (ADR-0038 §6) — the agent's `update_note` can never
/// touch parent/position. Steps:
///
/// (a) the moved row must exist (business `NotFound`);
/// (b) a non-root target parent must exist and be a folder (same errors
///     as `create_note`);
/// (c) CYCLE CHECK — the codebase's first self-referential table, so no
///     precedent exists: walk the ancestor chain from the target parent
///     upward; meeting the moved id means the target is the note itself
///     or one of its descendants (SQLite cannot express this constraint).
///     The walk is bounded by the table's row count so a corrupt
///     pre-existing cycle (possible only via a hand-crafted import) cannot
///     loop forever — exhausting the bound is rejected as a cycle too;
/// (d) reparent (+ `updated_at`; position is normalized next);
/// (e) renumber the TARGET parent's children: ids in position order, the
///     moved id lifted out and re-inserted at `index` (clamped to
///     `0..=len`), positions written `0..n-1` sequentially;
/// (f) the OLD parent's children keep their gaps — no renumbering writes
///     (ADR-0038 §5);
/// (g) read back and return the note.
#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn move_note(
    space_id: String,
    world_id: String,
    id: String,
    new_parent_id: Option<String>,
    index: i64,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Note, DbError> {
    do_move_note(
        &state,
        &space_id,
        &world_id,
        &id,
        new_parent_id.as_deref(),
        index,
        Some(&app),
    )
}

/// Testable core of [`move_note`] (the `do_*` convention).
pub(crate) fn do_move_note(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    new_parent_id: Option<&str>,
    index: i64,
    app: Option<&AppHandle>,
) -> Result<Note, DbError> {
    let now = now_iso();
    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        // (a) Existence pre-check — a missing row would otherwise be a
        // silent no-op UPDATE + an empty renumber below. The title rides
        // along for the sibling-title violation mapping in (d).
        let moved_title: String = tx
            .query_row("SELECT title FROM notes WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Note", id.to_string()),
                other => DbError::Sqlite(other),
            })?;

        // (b) + (c) Root targets (None) skip both checks — the root cannot
        // be the note itself or any of its descendants.
        if let Some(parent_id) = new_parent_id {
            ensure_parent_is_folder(&tx, parent_id)?;

            let row_count: i64 = tx.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
            let mut cursor = parent_id.to_string();
            let mut steps_remaining = row_count + 1;
            loop {
                if cursor == id {
                    return Err(DbError::NoteMoveCycle(id.to_string()));
                }
                if steps_remaining == 0 {
                    // Walked more edges than rows exist without reaching
                    // the root — a corrupt pre-existing cycle. Reject as a
                    // cycle (the safest interpretation for a move target).
                    return Err(DbError::NoteMoveCycle(id.to_string()));
                }
                steps_remaining -= 1;
                let parent: Option<Option<String>> = tx
                    .query_row(
                        "SELECT parent_id FROM notes WHERE id = ?1",
                        params![&cursor],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?;
                match parent.flatten() {
                    Some(grandparent) => cursor = grandparent,
                    None => break, // root reached (or dangling ref) — acyclic
                }
            }
        }

        // (d) Reparent. Position is rewritten by (e) regardless of the
        // stale value carried over from the old sibling set. A UNIQUE
        // violation here means the target folder already holds a
        // same-titled sibling → business error, not a raw SQLite dump.
        tx.execute(
            "UPDATE notes SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_parent_id, now, id],
        )
        .map_err(|e| map_sibling_title_violation(e.into(), &moved_title))?;

        // (e) Renumber the target parent's children with the moved note at
        // `index`. `id` tiebreaker keeps the pre-insert order
        // deterministic when gaps/duplicate positions exist.
        let mut sibling_ids: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT id FROM notes WHERE parent_id IS ?1 ORDER BY position, id")?;
            let rows =
                stmt.query_map(params![new_parent_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        sibling_ids.retain(|sid| sid != id);
        let insert_at = (index.max(0) as usize).min(sibling_ids.len());
        sibling_ids.insert(insert_at, id.to_string());
        for (i, sid) in sibling_ids.iter().enumerate() {
            tx.execute(
                "UPDATE notes SET position = ?1 WHERE id = ?2",
                params![i as i64, sid],
            )?;
        }

        // (f) Old parent's children: gaps are fine — no writes.

        tx.commit()?;

        // (g)
        load_note(conn, id)
    });
    if let Ok(ref entity) = result {
        if let Some(app) = app {
            emit_entity_changed(
                app,
                "note",
                Some(entity.id.clone()),
                space_id,
                Some(world_id),
            );
        }
    }
    result
}

// ─── grep_notes (match-centric search — ADR-0035 semantics, ADR-0037
// amendment: note title + content; folder title only) ────────────────────────

/// The notes corpus index for ancestry walks: id → (parent_id, title).
/// Paths are computed in memory against this map instead of per-row parent
/// SELECTs — notes trees are desktop-scale and `list_notes` already loads
/// the whole table in one query (the established no-N+1 convention).
type NoteTitles = HashMap<String, (Option<String>, String)>;

/// Ancestor titles joined with `/`, root-to-parent, EXCLUDING the row
/// itself — note titles repeat across the tree and tree position is
/// semantic (ADR-0038 §6). Root-level rows get `""`. The walk is bounded
/// by the map's size so a corrupt pre-existing cycle cannot loop forever.
fn note_path(titles: &NoteTitles, parent_id: Option<&str>) -> String {
    let mut chain: Vec<&str> = Vec::new();
    let mut cursor = parent_id;
    while let Some(pid) = cursor {
        if chain.len() > titles.len() {
            break; // corrupt cycle — defensive bound
        }
        match titles.get(pid) {
            Some((grandparent, title)) => {
                chain.push(title.as_str());
                cursor = grandparent.as_deref();
            }
            None => break, // dangling ref — defensive chain end
        }
    }
    chain.reverse();
    chain.join("/")
}

/// Map a `GrepSnippet` (grep.rs's tested scanner output) onto the
/// notes-shaped snippet — identical three-part shape, different struct so
/// the two tool surfaces stay independently evolvable.
fn to_note_snippet(s: GrepSnippet) -> NoteSnippet {
    NoteSnippet {
        before: s.before,
        r#match: s.r#match,
        after: s.after,
    }
}

/// SQL LIKE prefilter + in-memory literal scan over the notes corpus,
/// mirroring the per-table scans in `grep.rs`: the prefilter is a superset
/// (no escaping — `%`/`_` act as wildcards); the Rust scan applies literal
/// semantics with ASCII case folding, counts NON-overlapping occurrences,
/// and extracts up to 3 snippets per field. Notes match on title + content
/// fields; folders (pure containers, content always '') match on title
/// only. One group per (row, field) with ≥1 match.
fn scan_notes(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<NoteMatchGroup>, DbError> {
    // (a) Full (id → parent, title) map for the in-memory ancestry walks.
    let mut titles: NoteTitles = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, parent_id, title FROM notes")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, Option<String>>("parent_id")?,
                row.get::<_, String>("title")?,
            ))
        })?;
        for row in rows {
            let (id, parent_id, title) = row?;
            titles.insert(id, (parent_id, title));
        }
    }

    // (b) Prefiltered rows. Folder rows are excluded from the content
    // predicate at the SQL level (mirroring the corpus definition), and
    // again at the scan level below.
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, kind, title, content FROM notes
         WHERE (kind = 'note' AND (title LIKE ?1 OR content LIKE ?1))
            OR (kind = 'folder' AND title LIKE ?1)",
    )?;
    let mut rows = stmt.query(params![pat])?;

    let mut groups = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get("id")?;
        let parent_id: Option<String> = row.get("parent_id")?;
        let kind_raw: String = row.get("kind")?;
        let title: String = row.get("title")?;
        let content: String = row.get("content")?;
        let kind = parse_kind(&kind_raw, &id)?;
        let path = note_path(&titles, parent_id.as_deref());

        let fields = [("title", title.as_str()), ("content", content.as_str())];
        let scanned_fields: &[(&str, &str)] = match kind {
            NoteKind::Folder => &fields[..1],
            NoteKind::Note => &fields[..2],
        };
        for (field_name, value) in scanned_fields {
            if let Some((match_count, snippets)) = scan_text_field(value, needle) {
                groups.push(NoteMatchGroup {
                    note_id: id.clone(),
                    kind,
                    title: title.clone(),
                    path: path.clone(),
                    field_name: (*field_name).to_string(),
                    match_count,
                    snippets: snippets.into_iter().map(to_note_snippet).collect(),
                });
            }
        }
    }
    Ok(groups)
}

/// Read-only match-centric search over the notes corpus (ADR-0037
/// amendment). Logging red line: the query, titles, and snippets are user
/// creative content — never logged; only the aggregate outcome is.
#[tracing::instrument(skip(state, input), fields(space_id = %space_id, world_id = %world_id))]
#[tauri::command]
pub fn grep_notes(
    space_id: String,
    world_id: String,
    input: GrepNotesInput,
    state: State<'_, DbManager>,
) -> Result<GrepNotesResponse, DbError> {
    // Defensive: a blank query would build a `'%…%'` pattern that matches
    // (nearly) every row and then match nothing literally — a full table
    // sweep for an empty result (grep.rs precedent).
    if input.query.trim().is_empty() {
        return Ok(GrepNotesResponse {
            groups: Vec::new(),
            group_count: 0,
            truncated: false,
        });
    }

    let pat = like_pattern(&input.query);
    let needle = fold_ascii(&input.query);

    let mut groups = state.with_world(&space_id, &world_id, |conn| {
        scan_notes(conn, &pat, &needle)
    })?;

    // Deterministic ordering (grep.rs §5 adapted to the single-table
    // corpus — no entity-type rank): match_count desc → title asc →
    // note_id asc as the final stabilizer (same input → same output, so
    // `offset` pages are stable across calls).
    groups.sort_by(|a, b| {
        b.match_count
            .cmp(&a.match_count)
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.note_id.cmp(&b.note_id))
    });

    let group_count = groups.len() as i64;
    let offset = input.offset.max(0) as usize;
    let page: Vec<NoteMatchGroup> = groups.into_iter().skip(offset).take(MAX_GROUPS).collect();
    let truncated = offset + page.len() < group_count as usize;

    let result = GrepNotesResponse {
        groups: page,
        group_count,
        truncated,
    };
    tracing::debug!(
        group_count = %result.group_count,
        truncated = result.truncated,
        "grep notes completed"
    );
    Ok(result)
}

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
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
        do_create_note(&fx.mgr, &fx.space_id, &fx.world_id, &input(parent, kind, title, ""), None)
            .expect("create note")
    }

    /// Raw `(parent_id, kind, title, content, position)` of one row.
    fn note_row(
        fx: &WorldFixture,
        id: &str,
    ) -> (Option<String>, String, String, String, i64) {
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
        let err = do_move_note(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, Some(&b.id), 0, None)
            .expect_err("parent under its own child");
        assert!(matches!(err, DbError::NoteMoveCycle(id) if id == a.id));

        // Deeper chain A←B←C: moving A under C is still a cycle.
        let c = create(&fx, Some(b.id.clone()), NoteKind::Folder, "C");
        let err = do_move_note(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, Some(&c.id), 0, None)
            .expect_err("ancestor under its descendant");
        assert!(matches!(err, DbError::NoteMoveCycle(_)));

        // A root folder may not move under a LEAF note.
        let leaf = create(&fx, None, NoteKind::Note, "Leaf");
        let err = do_move_note(&fx.mgr, &fx.space_id, &fx.world_id, &a.id, Some(&leaf.id), 0, None)
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
        do_move_note(&fx.mgr, &fx.space_id, &fx.world_id, &m.id, Some(&f.id), 99, None)
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
        do_move_note(&fx.mgr, &fx.space_id, &fx.world_id, &w.id, Some(&f.id), -5, None)
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
        assert_eq!(parent.as_deref(), Some(f.id.as_str()), "parent_id unchanged");
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
}
