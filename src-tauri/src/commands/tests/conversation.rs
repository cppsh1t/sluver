use super::*;
use crate::models::attachment::AttachmentInput;
use crate::models::conversation::MessageInput;
use crate::testutil::{make_space_with_world, uuid_shape, with_world, WorldFixture};
use base64::Engine as _;
use rusqlite::params;

const NOW: &str = "2026-01-01T00:00:00.000Z";

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Insert a bare conversation row (tests bypass `create_conversation`,
/// which needs a Tauri `State`).
fn seed_conversation(fx: &WorldFixture, id: &str) {
    with_world(fx, |conn| {
        conn.execute(
            "INSERT INTO conversations (id, agent_config_name, title, meta, created_at, updated_at)
                 VALUES (?1, 'default', NULL, ?2, ?3, ?3)",
            params![id, r#"{"kind":"world"}"#, NOW],
        )?;
        Ok(())
    })
    .expect("seed conversation");
}

fn msg_input(id: &str, attachments: Vec<AttachmentInput>) -> MessageInput {
    MessageInput {
        id: id.to_string(),
        body: serde_json::json!({ "role": "user", "content": "hi" }),
        created_at: NOW.to_string(),
        usage_input_tokens: None,
        usage_output_tokens: None,
        attachments,
    }
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
        data_base64: b64(bytes),
    }
}

fn count(fx: &WorldFixture, table: &str) -> i64 {
    // Table names are compile-time literals from this module only.
    let sql = format!("SELECT COUNT(*) FROM {table}");
    with_world(fx, |conn| Ok(conn.query_row(&sql, [], |r| r.get(0))?)).expect("count rows")
}

#[test]
fn append_messages_stores_attachments_with_size_and_position() {
    let fx = make_space_with_world();
    let conv = uuid_shape(7);
    seed_conversation(&fx, &conv);

    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let md: &[u8] = b"# outline\n\xE4\xB8\x96\xE7\x95\x8C";
    let msg_id = uuid_shape(8);
    let img_id = uuid_shape(9);
    let txt_id = uuid_shape(10);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv,
            messages: vec![msg_input(
                &msg_id,
                vec![
                    att(&img_id, 0, "image", "image/png", "pic.png", png),
                    att(&txt_id, 1, "text", "text/markdown", "notes.md", md),
                ],
            )],
        },
    )
    .expect("append with attachments");

    let rows: Vec<(String, String, i64, String, String, i64)> = with_world(&fx, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, message_id, position, kind, mime, size_bytes
                 FROM message_attachments
                 ORDER BY position ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("read attachment rows");

    assert_eq!(count(&fx, "messages"), 1, "message row persisted");
    assert_eq!(rows.len(), 2, "both attachment rows persisted");
    assert_eq!(
        rows[0],
        (
            img_id.clone(),
            msg_id.clone(),
            0,
            "image".into(),
            "image/png".into(),
            png.len() as i64
        ),
        "image attachment: id/message_id/position/mime + decoded size"
    );
    assert_eq!(
        rows[1],
        (
            txt_id.clone(),
            msg_id.clone(),
            1,
            "text".into(),
            "text/markdown".into(),
            md.len() as i64
        ),
        "text attachment: id/message_id/position/mime + decoded size"
    );
}

#[test]
fn append_messages_without_attachments_unchanged() {
    // The `#[serde(default)]` widening must not disturb the legacy path.
    let fx = make_space_with_world();
    let conv = uuid_shape(11);
    seed_conversation(&fx, &conv);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv,
            messages: vec![msg_input(&uuid_shape(12), vec![])],
        },
    )
    .expect("append without attachments");

    assert_eq!(count(&fx, "messages"), 1);
    assert_eq!(count(&fx, "message_attachments"), 0);
}

/// Each invalid-attachment flavor must reject the WHOLE batch — the
/// earlier, otherwise-valid message must NOT survive (transaction
/// rollback), and no attachment row may either.
#[test]
fn invalid_attachment_rolls_back_whole_batch() {
    let cases: &[(&str, &str, &str, Vec<u8>)] = &[
        (
            "oversized image",
            "image/png",
            "image",
            vec![0xAB; crate::util::MAX_ATTACHMENT_IMAGE_BYTES + 1],
        ),
        (
            "wrong mime",
            "application/pdf",
            "image",
            vec![0x25, 0x50, 0x44, 0x46],
        ),
        (
            "non-UTF-8 text",
            "text/plain",
            "text",
            vec![0xFF, 0xFE, 0x00],
        ),
    ];

    for (label, mime, kind, bytes) in cases {
        let fx = make_space_with_world();
        let conv = uuid_shape(13);
        seed_conversation(&fx, &conv);

        let result = do_append_messages(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &AppendMessagesInput {
                conversation_id: conv,
                messages: vec![
                    // First message is perfectly valid — it must be
                    // rolled back together with the bad second one.
                    msg_input(&uuid_shape(14), vec![]),
                    msg_input(
                        &uuid_shape(15),
                        vec![att(&uuid_shape(16), 0, kind, mime, "f", bytes)],
                    ),
                ],
            },
        );
        assert!(result.is_err(), "{label}: batch must be rejected");
        assert_eq!(
            count(&fx, "messages"),
            0,
            "{label}: rollback must remove ALL message rows"
        );
        assert_eq!(
            count(&fx, "message_attachments"),
            0,
            "{label}: no attachment rows may survive"
        );
    }
}

#[test]
fn delete_conversation_cascades_attachments() {
    let fx = make_space_with_world();
    let conv = uuid_shape(17);
    seed_conversation(&fx, &conv);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv.clone(),
            messages: vec![msg_input(
                &uuid_shape(18),
                vec![att(
                    &uuid_shape(19),
                    0,
                    "image",
                    "image/png",
                    "pic.png",
                    &[0x89, b'P', b'N', b'G'],
                )],
            )],
        },
    )
    .expect("append with attachment");
    assert_eq!(count(&fx, "message_attachments"), 1);

    // The FK cascade chain conversations → messages →
    // message_attachments is DB-level (WORLD_MIGRATION_013).
    with_world(&fx, |conn| {
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![conv])?;
        Ok(())
    })
    .expect("delete conversation");

    assert_eq!(count(&fx, "messages"), 0, "messages cascaded away");
    assert_eq!(
        count(&fx, "message_attachments"),
        0,
        "attachments cascaded away"
    );
}
