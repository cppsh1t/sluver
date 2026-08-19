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
mod tests {
    use super::*;
    use crate::commands::conversation::do_append_messages;
    use crate::models::attachment::AttachmentInput;
    use crate::models::conversation::{AppendMessagesInput, MessageInput};
    use crate::testutil::{make_space_with_world, uuid_shape, with_world, WorldFixture};
    use base64::Engine as _;
    use rusqlite::params;

    const NOW: &str = "2026-01-01T00:00:00.000Z";
    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    fn seed_conversation_with_message(
        fx: &WorldFixture,
        conv_id: &str,
        msg_id: &str,
        attachments: Vec<AttachmentInput>,
    ) {
        with_world(fx, |conn| {
            conn.execute(
                "INSERT INTO conversations (id, agent_config_name, title, meta, created_at, updated_at)
                 VALUES (?1, 'default', NULL, ?2, ?3, ?3)",
                params![conv_id, r#"{"kind":"world"}"#, NOW],
            )?;
            Ok(())
        })
        .expect("seed conversation");
        do_append_messages(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &AppendMessagesInput {
                conversation_id: conv_id.to_string(),
                messages: vec![MessageInput {
                    id: msg_id.to_string(),
                    body: serde_json::json!({ "role": "user", "content": "hi" }),
                    created_at: NOW.to_string(),
                    usage_input_tokens: None,
                    usage_output_tokens: None,
                    attachments,
                }],
            },
        )
        .expect("append message with attachments");
    }

    fn att(
        id: &str,
        position: i64,
        kind: &str,
        mime: &str,
        filename: &str,
        bytes: &[u8],
    ) -> AttachmentInput {
        AttachmentInput {
            id: id.to_string(),
            position,
            kind: kind.to_string(),
            mime: mime.to_string(),
            filename: filename.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    #[test]
    fn get_message_attachment_round_trips_bytes() {
        let fx = make_space_with_world();
        let att_id = uuid_shape(21);
        seed_conversation_with_message(
            &fx,
            &uuid_shape(20),
            &uuid_shape(22),
            vec![att(&att_id, 0, "image", "image/png", "pic.png", PNG_MAGIC)],
        );

        let bytes =
            do_get_message_attachment(&fx.mgr, &fx.space_id, &fx.world_id, &att_id)
                .expect("fetch attachment");
        assert_eq!(bytes, PNG_MAGIC.to_vec(), "byte-identical round-trip");
    }

    #[test]
    fn get_message_attachment_missing_is_not_found() {
        let fx = make_space_with_world();
        let missing = uuid_shape(23);
        let err =
            do_get_message_attachment(&fx.mgr, &fx.space_id, &fx.world_id, &missing)
                .expect_err("missing id must be NotFound");
        match err {
            DbError::NotFound(entity, id) => {
                assert_eq!(entity, "Attachment");
                assert_eq!(id, missing);
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn list_message_attachments_returns_meta_without_blob() {
        let fx = make_space_with_world();
        let msg_id = uuid_shape(24);
        let img_id = uuid_shape(25);
        let txt_id = uuid_shape(26);
        let txt_bytes = b"a,b,c".to_vec();
        seed_conversation_with_message(
            &fx,
            &uuid_shape(27),
            &msg_id,
            vec![
                att(&img_id, 0, "image", "image/png", "pic.png", PNG_MAGIC),
                att(&txt_id, 1, "text", "text/csv", "data.csv", &txt_bytes),
            ],
        );

        let metas = do_list_message_attachments(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &msg_id,
        )
        .expect("list attachments");

        assert_eq!(metas.len(), 2, "both attachments listed");
        assert_eq!(metas[0].id, img_id);
        assert_eq!(metas[0].message_id, msg_id);
        assert_eq!(metas[0].position, 0);
        assert_eq!(metas[0].kind, "image");
        assert_eq!(metas[0].mime, "image/png");
        assert_eq!(metas[0].filename, "pic.png");
        assert_eq!(metas[0].size_bytes, PNG_MAGIC.len() as i64);

        assert_eq!(metas[1].id, txt_id);
        assert_eq!(metas[1].position, 1);
        assert_eq!(metas[1].kind, "text");
        assert_eq!(metas[1].mime, "text/csv");
        assert_eq!(metas[1].size_bytes, txt_bytes.len() as i64);
        // created_at is populated server-side (now_iso at insert time).
        assert!(!metas[0].created_at.is_empty());
        assert!(!metas[1].created_at.is_empty());
    }

    #[test]
    fn list_message_attachments_unknown_message_is_empty() {
        // Never-throws semantics, mirroring load_messages: an unknown
        // message simply has no attachments.
        let fx = make_space_with_world();
        let metas = do_list_message_attachments(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &uuid_shape(28),
        )
        .expect("unknown message must not throw");
        assert!(metas.is_empty());
    }
}
