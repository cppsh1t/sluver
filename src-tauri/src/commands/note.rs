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

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_note(
    space_id: String,
    world_id: String,
    input: CreateNoteInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Note, DbError> {
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    // Folders are pure structural containers — content is forced to ''
    // (ADR-0038 §1) regardless of what the caller sent.
    let content = match input.kind {
        NoteKind::Folder => String::new(),
        NoteKind::Note => input.content,
    };

    let result = state.with_world(&space_id, &world_id, |conn| {
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
        )?;
        tx.commit()?;

        load_note(conn, &id)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "note",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let now = now_iso();

    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE notes
             SET title = ?1,
                 content = CASE WHEN kind = 'folder' THEN '' ELSE ?2 END,
                 updated_at = ?3
             WHERE id = ?4",
            params![input.title, input.content, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Note", id.clone()));
        }
        load_note(conn, &id)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "note",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Note", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "note",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
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
    let result = state.with_world(&space_id, &world_id, |conn| {
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
        emit_entity_changed(&app, "note", None, &space_id, Some(&world_id));
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
    let now = now_iso();
    let result = state.with_world(&space_id, &world_id, |conn| {
        let tx = conn.transaction()?;

        // (a) Existence pre-check — a missing row would otherwise be a
        // silent no-op UPDATE + an empty renumber below.
        tx.query_row("SELECT 1 FROM notes WHERE id = ?1", params![&id], |_| Ok(()))
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Note", id.clone()),
                other => DbError::Sqlite(other),
            })?;

        // (b) + (c) Root targets (None) skip both checks — the root cannot
        // be the note itself or any of its descendants.
        if let Some(parent_id) = new_parent_id.as_deref() {
            ensure_parent_is_folder(&tx, parent_id)?;

            let row_count: i64 = tx.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
            let mut cursor = parent_id.to_string();
            let mut steps_remaining = row_count + 1;
            loop {
                if cursor == id {
                    return Err(DbError::NoteMoveCycle(id.clone()));
                }
                if steps_remaining == 0 {
                    // Walked more edges than rows exist without reaching
                    // the root — a corrupt pre-existing cycle. Reject as a
                    // cycle (the safest interpretation for a move target).
                    return Err(DbError::NoteMoveCycle(id.clone()));
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
        // stale value carried over from the old sibling set.
        tx.execute(
            "UPDATE notes SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_parent_id, now, &id],
        )?;

        // (e) Renumber the target parent's children with the moved note at
        // `index`. `id` tiebreaker keeps the pre-insert order
        // deterministic when gaps/duplicate positions exist.
        let mut sibling_ids: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT id FROM notes WHERE parent_id IS ?1 ORDER BY position, id")?;
            let rows =
                stmt.query_map(params![new_parent_id.as_deref()], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        sibling_ids.retain(|sid| sid != &id);
        let insert_at = (index.max(0) as usize).min(sibling_ids.len());
        sibling_ids.insert(insert_at, id.clone());
        for (i, sid) in sibling_ids.iter().enumerate() {
            tx.execute(
                "UPDATE notes SET position = ?1 WHERE id = ?2",
                params![i as i64, sid],
            )?;
        }

        // (f) Old parent's children: gaps are fine — no writes.

        tx.commit()?;

        // (g)
        load_note(conn, &id)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "note",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
        );
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
