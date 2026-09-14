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
                msg_input(
                    &attached,
                    vec![att(
                        &uuid_shape(27),
                        0,
                        "image",
                        "image/png",
                        "pic.png",
                        png,
                    )],
                ),
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

// ─── get_conversation (any kind — subagent drill-in, ADR-0050 D10) ──────────

/// `get_conversation` returns ANY kind of row — including the hidden
/// `kind="subagent"` runs `list_conversations` filters out — with the meta
/// payload intact (the drill-in path needs the parent linkage to round-trip).
#[test]
fn get_conversation_round_trips_subagent_run_meta() {
    let fx = make_space_with_world();
    let parent = uuid_shape(60);
    let created = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "writer".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: Some(parent.clone()),
            parent_tool_call_id: Some(uuid_shape(61)),
            role: Some("writer".into()),
            title: None,
        },
    )
    .expect("create subagent run conversation");

    let fetched = do_get_conversation(&fx.mgr, &fx.space_id, &fx.world_id, &created.id)
        .expect("get the hidden run conversation by id");

    assert_eq!(fetched.id, created.id);
    assert_eq!(fetched.agent_config_name, "writer");
    assert_eq!(
        fetched.meta,
        serde_json::json!({
            "kind": "subagent",
            "parentConversationId": parent,
            "parentToolCallId": uuid_shape(61),
            "role": "writer",
        }),
        "meta (incl. parent linkage) survives the round trip"
    );
}

/// An unknown id is a `NotFound` business error — the drill-in UI relies on
/// this to bail out of replaying a run whose row is gone.
#[test]
fn get_conversation_unknown_id_is_not_found() {
    let fx = make_space_with_world();
    let missing = uuid_shape(62);
    let err = do_get_conversation(&fx.mgr, &fx.space_id, &fx.world_id, &missing)
        .expect_err("missing conversation must be rejected");
    assert!(
        matches!(err, DbError::NotFound("Conversation", ref id) if *id == missing),
        "expected NotFound(\"Conversation\", {missing}), got {err:?}"
    );
}

// ─── create_conversation (kind discrimination) ─────────────────────────────

/// kind="subagent" round-trips the parent linkage + role verbatim through
/// `meta` (ADR-0050 D2): both the returned row AND the persisted column
/// carry all four fields.
#[test]
fn create_conversation_subagent_round_trips_meta() {
    let fx = make_space_with_world();
    let parent = uuid_shape(50);
    let tool_call = uuid_shape(51);

    let created = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "curator".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: Some(parent.clone()),
            parent_tool_call_id: Some(tool_call.clone()),
            role: Some("curator".into()),
            title: None,
        },
    )
    .expect("create subagent run conversation");

    let expected = serde_json::json!({
        "kind": "subagent",
        "parentConversationId": parent,
        "parentToolCallId": tool_call,
        "role": "curator",
    });
    assert_eq!(
        created.meta, expected,
        "returned meta carries the parent linkage + role verbatim"
    );
    assert_eq!(created.agent_config_name, "curator");

    // Prove the persisted column content matches (the helper's read-back
    // already covers the return path; this pins the stored JSON).
    let stored: String = with_world(&fx, |conn| {
        Ok(conn.query_row(
            "SELECT meta FROM conversations WHERE id = ?1",
            params![created.id],
            |r| r.get(0),
        )?)
    })
    .expect("read stored meta");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored).expect("stored meta is valid JSON"),
        expected,
        "persisted meta matches verbatim"
    );
}

/// A subagent kind WITHOUT a parent_conversation_id is rejected before any
/// row is written — mirrors the chapter-kind/chapter_id contract.
#[test]
fn create_conversation_subagent_requires_parent_conversation_id() {
    let fx = make_space_with_world();
    let err = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "scribe".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: None,
            parent_tool_call_id: None,
            role: None,
            title: None,
        },
    )
    .expect_err("subagent kind without parent must be rejected");
    assert!(
        matches!(err, DbError::InvalidInput(ref msg) if msg.contains("parent_conversation_id")),
        "expected InvalidInput mentioning parent_conversation_id, got {err:?}"
    );
    assert_eq!(
        count(&fx, "conversations"),
        0,
        "no row may be persisted on rejection"
    );
}

/// parent_tool_call_id is as load-bearing as the parent conversation id
/// (F5): the frontend's discriminated union requires it non-null for the
/// subagent variant, so a None must be rejected rather than serialized
/// into meta as JSON null.
#[test]
fn create_conversation_subagent_requires_parent_tool_call_id() {
    let fx = make_space_with_world();
    let err = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "scribe".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: Some(uuid_shape(74)),
            parent_tool_call_id: None,
            role: Some("scribe".into()),
            title: None,
        },
    )
    .expect_err("subagent kind without parent_tool_call_id must be rejected");
    assert!(
        matches!(err, DbError::InvalidInput(ref msg) if msg.contains("parent_tool_call_id")),
        "expected InvalidInput mentioning parent_tool_call_id, got {err:?}"
    );
    assert_eq!(
        count(&fx, "conversations"),
        0,
        "no row may be persisted on rejection"
    );
}

/// role completes the subagent meta contract (F5): None is rejected —
/// the run's dispatched role must never persist as JSON null.
#[test]
fn create_conversation_subagent_requires_role() {
    let fx = make_space_with_world();
    let err = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "scribe".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: Some(uuid_shape(75)),
            parent_tool_call_id: Some(uuid_shape(76)),
            role: None,
            title: None,
        },
    )
    .expect_err("subagent kind without role must be rejected");
    assert!(
        matches!(err, DbError::InvalidInput(ref msg) if msg.contains("role")),
        "expected InvalidInput mentioning role, got {err:?}"
    );
    assert_eq!(
        count(&fx, "conversations"),
        0,
        "no row may be persisted on rejection"
    );
}

/// `list_conversations`' `meta->>'kind' = 'world'` filter keeps subagent
/// run rows out of the chat list (ADR-0050 D2) — verified against the
/// exact SQL the command runs. Also sanity-checks that a plain world-kind
/// create still collapses to `{"kind":"world"}`.
#[test]
fn subagent_conversations_stay_hidden_from_list_filter() {
    let fx = make_space_with_world();
    let world_conv = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "orchestrator".into(),
            kind: "world".into(),
            chapter_id: None,
            parent_conversation_id: None,
            parent_tool_call_id: None,
            role: None,
            title: None,
        },
    )
    .expect("create world conversation");
    assert_eq!(
        world_conv.meta,
        serde_json::json!({ "kind": "world" }),
        "world kind still collapses to the bare discriminator"
    );

    let _run = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "historian".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: Some(world_conv.id.clone()),
            parent_tool_call_id: Some(uuid_shape(52)),
            role: Some("historian".into()),
            title: None,
        },
    )
    .expect("create subagent run conversation");
    assert_eq!(count(&fx, "conversations"), 2, "both rows persisted");

    // The exact predicate list_conversations runs.
    let listed: Vec<String> = with_world(&fx, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM conversations
             WHERE meta->>'kind' = 'world'
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("run the list_conversations SQL");

    assert_eq!(
        listed,
        vec![world_conv.id],
        "only the world conversation is listed; the subagent run stays hidden"
    );
}

// ─── delete_conversation (subagent-run cascade, F4) ─────────────────────────

/// F4: deleting a parent conversation must also remove its hidden subagent
/// run rows — the linkage lives inside `meta` JSON, invisible to the FK
/// cascade — together with the runs' messages/attachments (which DO ride
/// the FK chain once the run row itself is deleted).
#[test]
fn delete_conversation_cascades_to_subagent_runs() {
    let fx = make_space_with_world();
    let parent = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "orchestrator".into(),
            kind: "world".into(),
            chapter_id: None,
            parent_conversation_id: None,
            parent_tool_call_id: None,
            role: None,
            title: None,
        },
    )
    .expect("create parent conversation");

    let run = do_create_conversation(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        CreateConversationInput {
            agent_config_name: "writer".into(),
            kind: "subagent".into(),
            chapter_id: None,
            parent_conversation_id: Some(parent.id.clone()),
            parent_tool_call_id: Some(uuid_shape(70)),
            role: Some("writer".into()),
            title: None,
        },
    )
    .expect("create subagent run conversation");

    // A message (+attachment) ON THE RUN — after the parent delete it must
    // be gone without any per-child message cleanup.
    do_append_messages(
        &fx.mgr,
        &fx.space_id,
        &fx.world_id,
        &AppendMessagesInput {
            conversation_id: run.id.clone(),
            messages: vec![msg_input(
                &uuid_shape(71),
                vec![att(
                    &uuid_shape(72),
                    0,
                    "image",
                    "image/png",
                    "pic.png",
                    &[0x89, b'P', b'N', b'G'],
                )],
            )],
        },
    )
    .expect("seed run message + attachment");
    assert_eq!(count(&fx, "conversations"), 2);
    assert_eq!(count(&fx, "messages"), 1);

    do_delete_conversation(&fx.mgr, &fx.space_id, &fx.world_id, &parent.id)
        .expect("delete parent conversation");

    let err = do_get_conversation(&fx.mgr, &fx.space_id, &fx.world_id, &run.id)
        .expect_err("the run row must be gone with its parent");
    assert!(
        matches!(err, DbError::NotFound("Conversation", _)),
        "expected NotFound(\"Conversation\", _), got {err:?}"
    );
    assert_eq!(
        count(&fx, "conversations"),
        0,
        "parent AND run rows both gone"
    );
    assert_eq!(count(&fx, "messages"), 0, "run messages cascaded away");
    assert_eq!(
        count(&fx, "message_attachments"),
        0,
        "run attachment rows cascaded away"
    );
}

/// Regression guard for the pre-F4 paths: a childless delete still works,
/// and re-deleting the now-gone id is still a NotFound — the zero-row
/// children sweep must not mask the parent-existence check.
#[test]
fn delete_conversation_without_children_and_unknown_id() {
    let fx = make_space_with_world();
    let conv = uuid_shape(73);
    seed_conversation(&fx, &conv);

    do_delete_conversation(&fx.mgr, &fx.space_id, &fx.world_id, &conv)
        .expect("childless delete still works");
    assert_eq!(count(&fx, "conversations"), 0);

    let err = do_delete_conversation(&fx.mgr, &fx.space_id, &fx.world_id, &conv)
        .expect_err("unknown id must be rejected");
    assert!(
        matches!(err, DbError::NotFound("Conversation", _)),
        "expected NotFound(\"Conversation\", _), got {err:?}"
    );
}
