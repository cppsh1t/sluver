// Chat message attachment READ commands (ADR-0044 / plan D2).
//
// Attachments are WRITTEN exclusively through `append_messages` (inline
// `AttachmentInput` rows inside its single transaction) — there is
// deliberately NO standalone add/delete command here. This module exposes
// the two read paths:
//   get_message_attachment   -> raw binary (tauri::ipc::Response, mirrors
//                               get_scene_image in commands/novel.rs)
//   list_message_attachments -> metadata-only rows (no blob)
//
// All world-scoped, taking (space_id, world_id) first per the house style.
// Attachment ids are client-minted (UUID v4), stored verbatim.

use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::attachment::AttachmentMeta;

// ─── row helpers ────────────────────────────────────────────────────────────

fn row_to_attachment_meta(row: &rusqlite::Row) -> rusqlite::Result<AttachmentMeta> {
    Ok(AttachmentMeta {
        id: row.get("id")?,
        message_id: row.get("message_id")?,
        position: row.get("position")?,
        kind: row.get("kind")?,
        mime: row.get("mime")?,
        filename: row.get("filename")?,
        size_bytes: row.get("size_bytes")?,
        created_at: row.get("created_at")?,
    })
}

// ─── commands ───────────────────────────────────────────────────────────────

/// Fetch one attachment's raw bytes as a binary IPC response — no JSON
/// encoding on the way out (mirrors `get_scene_image`). The frontend
/// consumes this as an `ArrayBuffer` and rebuilds its `data:` URL at the
/// session-store hydration boundary (plan D3).
#[tracing::instrument(skip(state), fields(entity_id = %id))]
#[tauri::command]
pub fn get_message_attachment(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<tauri::ipc::Response, DbError> {
    tracing::debug!(entity_id = %id, "attachment fetched");
    let bytes = do_get_message_attachment(&state, &space_id, &world_id, &id)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// `get_message_attachment` implementation over a bare `&DbManager` — the
/// `do_*` split per the crate's no-mock-runtime test convention. Returns
/// the raw bytes; the command wrapper above only adds tracing + the
/// `tauri::ipc::Response` envelope.
pub(crate) fn do_get_message_attachment(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
) -> Result<Vec<u8>, DbError> {
    mgr.with_world(space_id, world_id, |conn| {
        conn.query_row(
            "SELECT data_blob FROM message_attachments WHERE id = ?1",
            params![id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DbError::NotFound("Attachment", id.to_string())
            }
            other => DbError::Sqlite(other),
        })
    })
}

/// List a message's attachments as metadata-only rows (NO blob), ordered
/// by position. Returns an empty vec for an unknown message id — never
/// throws — mirroring `load_messages` semantics (a missing message simply
/// has no attachments to render).
#[tracing::instrument(skip(state), fields(message_id = %message_id))]
#[tauri::command]
pub fn list_message_attachments(
    space_id: String,
    world_id: String,
    message_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<AttachmentMeta>, DbError> {
    tracing::debug!(message_id = %message_id, "attachments listed");
    do_list_message_attachments(&state, &space_id, &world_id, &message_id)
}

/// `list_message_attachments` implementation over a bare `&DbManager` —
/// the `do_*` split per the crate's no-mock-runtime test convention.
pub(crate) fn do_list_message_attachments(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    message_id: &str,
) -> Result<Vec<AttachmentMeta>, DbError> {
    mgr.with_world(space_id, world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, message_id, position, kind, mime, filename, size_bytes, created_at
             FROM message_attachments
             WHERE message_id = ?1
             ORDER BY position ASC",
        )?;
        let rows = stmt
            .query_map(params![message_id], row_to_attachment_meta)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ─── tests ──────────────────────────────────────────────────────────────────

/// Read-command integration tests over the `do_*` helpers (no
/// `State<'_, _>`, no `AppHandle` — this crate has no mock runtime),
/// bootstrapped via `crate::testutil::make_space_with_world`. Writes go
/// through `conversation::do_append_messages` — the ONLY attachment write
/// path (plan D2).
#[cfg(test)]
#[path = "tests/attachment.rs"]
mod tests;
