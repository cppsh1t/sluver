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

    let bytes = do_get_message_attachment(&fx.mgr, &fx.space_id, &fx.world_id, &att_id)
        .expect("fetch attachment");
    assert_eq!(bytes, PNG_MAGIC.to_vec(), "byte-identical round-trip");
}

#[test]
fn get_message_attachment_missing_is_not_found() {
    let fx = make_space_with_world();
    let missing = uuid_shape(23);
    let err = do_get_message_attachment(&fx.mgr, &fx.space_id, &fx.world_id, &missing)
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

    let metas = do_list_message_attachments(&fx.mgr, &fx.space_id, &fx.world_id, &msg_id)
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
    let metas = do_list_message_attachments(&fx.mgr, &fx.space_id, &fx.world_id, &uuid_shape(28))
        .expect("unknown message must not throw");
    assert!(metas.is_empty());
}
