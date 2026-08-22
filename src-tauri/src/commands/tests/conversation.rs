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

// ─── delete_messages ────────────────────────────────────────────────────────

/// `msg_input` with an explicit created_at — delete/ordering tests need
/// distinct timestamps (the shared helper hardcodes NOW for all rows).
fn msg_at(id: &str, created_at: &str, attachments: Vec<AttachmentInput>) -> MessageInput {
    MessageInput {
        id: id.to_string(),
        body: serde_json::json!({ "role": "user", "content": "hi" }),
        created_at: created_at.to_string(),
        usage_input_tokens: None,
        usage_output_tokens: None,
        attachments,
    }
}

fn conv_updated_at(fx: &WorldFixture, conv: &str) -> String {
    with_world(fx, |conn| {
        Ok(conn.query_row(
            "SELECT updated_at FROM conversations WHERE id = ?1",
            params![conv],
            |r| r.get(0),
        )?)
    })
    .expect("read conversations.updated_at")
}

#[test]
fn delete_messages_removes_only_targeted_rows() {
    let fx = make_space_with_world();
    let conv = uuid_shape(20);
    seed_conversation(&fx, &conv);

    let m1 = uuid_shape(21);
    let m2 = uuid_shape(22);
    let m3 = uuid_shape(23);
    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv.clone(),
            messages: vec![
                msg_at(&m1, "2026-01-01T00:00:01.000Z", vec![]),
                msg_at(&m2, "2026-01-01T00:00:02.000Z", vec![]),
                msg_at(&m3, "2026-01-01T00:00:03.000Z", vec![]),
            ],
        },
    )
    .expect("seed three messages");

    do_delete_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &DeleteMessagesInput {
            conversation_id: conv.clone(),
            ids: vec![m2],
        },
    )
    .expect("delete middle message");

    let remaining: Vec<String> = with_world(&fx, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map(params![conv], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("read remaining messages");

    assert_eq!(
        remaining,
        vec![m1, m3],
        "outer messages survive, created_at order intact"
    );
}

#[test]
fn delete_messages_cascades_message_attachments() {
    let fx = make_space_with_world();
    let conv = uuid_shape(24);
    seed_conversation(&fx, &conv);

    let attached = uuid_shape(25);
    let bare = uuid_shape(26);
    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv,
            messages: vec![
                msg_input(&attached, vec![att(
                    &uuid_shape(27),
                    0,
                    "image",
                    "image/png",
                    "pic.png",
                    png,
                )]),
                msg_input(&bare, vec![]),
            ],
        },
    )
    .expect("seed one attached + one bare message");
    assert_eq!(count(&fx, "message_attachments"), 1);

    do_delete_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &DeleteMessagesInput {
            conversation_id: uuid_shape(24),
            ids: vec![attached],
        },
    )
    .expect("delete attached message");

    assert_eq!(count(&fx, "messages"), 1, "bare message survives");
    assert_eq!(
        count(&fx, "message_attachments"),
        0,
        "attachment rows cascade-deleted with their message"
    );
}

#[test]
fn delete_messages_bumps_conversation_updated_at() {
    let fx = make_space_with_world();
    let conv = uuid_shape(28);
    seed_conversation(&fx, &conv);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv.clone(),
            messages: vec![msg_input(&uuid_shape(29), vec![])],
        },
    )
    .expect("seed one message");

    // Pin a sentinel far in the past — do_append_messages already bumped
    // updated_at to "real now", and a fresh delete could land in the same
    // millisecond; the sentinel makes the before/after difference
    // deterministic.
    let sentinel = "2000-01-01T00:00:00.000Z";
    with_world(&fx, |conn| {
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![sentinel, &conv],
        )?;
        Ok(())
    })
    .expect("pin sentinel updated_at");
    assert_eq!(conv_updated_at(&fx, &conv), sentinel);

    do_delete_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &DeleteMessagesInput {
            conversation_id: conv.clone(),
            ids: vec![uuid_shape(30)],
        },
    )
    .expect("delete (idempotent path still bumps)");

    assert_ne!(
        conv_updated_at(&fx, &conv),
        sentinel,
        "updated_at must be bumped by delete_messages"
    );
}

#[test]
fn delete_messages_unknown_conversation_is_not_found() {
    let fx = make_space_with_world();
    // Deliberately NOT seeding the conversation.
    let err = do_delete_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &DeleteMessagesInput {
            conversation_id: uuid_shape(31),
            ids: vec![uuid_shape(32)],
        },
    )
    .expect_err("missing conversation must be rejected");
    assert!(
        matches!(err, DbError::NotFound("Conversation", _)),
        "expected NotFound(\"Conversation\", _), got {err:?}"
    );
    assert_eq!(count(&fx, "messages"), 0);
}

#[test]
fn delete_messages_is_idempotent_for_unknown_ids() {
    let fx = make_space_with_world();
    let conv = uuid_shape(33);
    seed_conversation(&fx, &conv);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv,
            messages: vec![msg_input(&uuid_shape(34), vec![])],
        },
    )
    .expect("seed one message");

    // A never-existed message id inside an EXISTING conversation is not an
    // error — contrast with the missing-conversation case above.
    do_delete_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &DeleteMessagesInput {
            conversation_id: uuid_shape(33),
            ids: vec![uuid_shape(35)],
        },
    )
    .expect("unknown message id must not error");

    assert_eq!(
        count(&fx, "messages"),
        1,
        "the real message row is untouched"
    );
}

// ─── update_message ─────────────────────────────────────────────────────────

#[test]
fn update_message_replaces_body_and_preserves_provenance() {
    let fx = make_space_with_world();
    let conv = uuid_shape(40);
    seed_conversation(&fx, &conv);

    let msg = uuid_shape(41);
    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv,
            // Seed with a distinct created_at + usage set — all three must
            // survive the body replacement untouched.
            messages: vec![MessageInput {
                id: msg.clone(),
                body: serde_json::json!({ "role": "assistant", "content": "old text" }),
                created_at: "2026-01-01T00:00:09.000Z".to_string(),
                usage_input_tokens: Some(101),
                usage_output_tokens: Some(202),
                attachments: vec![],
            }],
        },
    )
    .expect("seed message with usage + distinct created_at");

    let new_body = serde_json::json!({ "role": "assistant", "content": "edited text" });
    do_update_message(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &UpdateMessageInput {
            conversation_id: uuid_shape(40),
            id: msg.clone(),
            body: new_body.clone(),
        },
    )
    .expect("update message body");

    let row: (String, String, Option<i64>, Option<i64>) = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT body, created_at, usage_input_tokens, usage_output_tokens
                  FROM messages WHERE id = ?1",
            params![&msg],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?)
    })
    .expect("read message row back");
    let (body_str, created_at, usage_in, usage_out) = row;

    let body: serde_json::Value =
        serde_json::from_str(&body_str).expect("stored body is valid JSON");
    assert_eq!(body, new_body, "body fully replaced");
    assert_eq!(
        created_at, "2026-01-01T00:00:09.000Z",
        "created_at preserved — an edit changes content, not provenance"
    );
    assert_eq!(usage_in, Some(101), "usage_input_tokens preserved");
    assert_eq!(usage_out, Some(202), "usage_output_tokens preserved");
}

#[test]
fn update_message_bumps_conversation_updated_at() {
    let fx = make_space_with_world();
    let conv = uuid_shape(42);
    seed_conversation(&fx, &conv);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv.clone(),
            messages: vec![msg_input(&uuid_shape(43), vec![])],
        },
    )
    .expect("seed one message");

    // Pin a sentinel far in the past — mirrors the delete_messages variant:
    // a fresh update could land in the same millisecond as the append bump.
    let sentinel = "2000-01-01T00:00:00.000Z";
    with_world(&fx, |conn| {
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![sentinel, &conv],
        )?;
        Ok(())
    })
    .expect("pin sentinel updated_at");
    assert_eq!(conv_updated_at(&fx, &conv), sentinel);

    do_update_message(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &UpdateMessageInput {
            conversation_id: conv.clone(),
            id: uuid_shape(43),
            body: serde_json::json!({ "role": "user", "content": "edited" }),
        },
    )
    .expect("update message");

    assert_ne!(
        conv_updated_at(&fx, &conv),
        sentinel,
        "updated_at must be bumped by update_message"
    );
}

#[test]
fn update_message_unknown_message_id_is_not_found() {
    let fx = make_space_with_world();
    let conv = uuid_shape(44);
    seed_conversation(&fx, &conv);

    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: conv.clone(),
            messages: vec![msg_input(&uuid_shape(45), vec![])],
        },
    )
    .expect("seed one message");

    // An unknown message id inside an EXISTING conversation is a NotFound —
    // contrast with delete_messages' per-id idempotency.
    let err = do_update_message(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &UpdateMessageInput {
            conversation_id: conv.clone(),
            id: uuid_shape(46),
            body: serde_json::json!({ "role": "user", "content": "edited" }),
        },
    )
    .expect_err("unknown message id must be rejected");
    assert!(
        matches!(err, DbError::NotFound("Message", _)),
        "expected NotFound(\"Message\", _), got {err:?}"
    );
    assert_eq!(
        count(&fx, "messages"),
        1,
        "the real message row is untouched"
    );
}

#[test]
fn update_message_unknown_conversation_is_not_found() {
    let fx = make_space_with_world();
    // Deliberately NOT seeding the conversation.
    let err = do_update_message(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &UpdateMessageInput {
            conversation_id: uuid_shape(47),
            id: uuid_shape(48),
            body: serde_json::json!({ "role": "user", "content": "edited" }),
        },
    )
    .expect_err("missing conversation must be rejected");
    // The composite WHERE (conversation_id AND id) matches zero rows, so the
    // single-UPDATE path surfaces it as a Message NotFound.
    assert!(
        matches!(err, DbError::NotFound("Message", _)),
        "expected NotFound(\"Message\", _), got {err:?}"
    );
    assert_eq!(count(&fx, "messages"), 0);
}
