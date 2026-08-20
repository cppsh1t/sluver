// Conversation persistence commands (ADR-0022: World-scoped chat history).
//
// Mirrors the pure library's SessionStore interface 1:1:
//   list_conversations  -> listSessions   (kind="world" only; ADR Q6b)
//   create_conversation -> createSession  (server builds meta from kind)
//   delete_conversation -> deleteSession  (FK cascade handles messages)
//   load_messages       -> loadMessages   (ordered ASC; never throws)
//   append_messages     -> appendMessages (single txn; bump updated_at)
//
// All world-scoped, taking (space_id, world_id) first per the house style
// (see commands/novel.rs). IDs: conversations.id = new_id() (UUID v7);
// messages.id arrives from the client (UUID v4) and is stored verbatim.

use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::conversation::{
    AppendMessagesInput, Conversation, CreateConversationInput, Message,
};
use crate::util::{decode_and_validate_attachment, new_id, now_iso};

// ─── row helpers ────────────────────────────────────────────────────────────
//
// `meta` / `body` are TEXT columns holding JSON. `serde_json::Value` does NOT
// impl `FromSql`, so we read each column as a String and parse via serde in
// the helper. `unwrap_or_default()` (→ Value::Null) matches the defensive
// JSON-parsing convention used elsewhere (novel.rs tags handling) — the
// columns are NOT NULL and only ever written from valid JSON, so a parse
// failure indicates corruption rather than a normal empty case.

fn row_to_conversation(row: &rusqlite::Row) -> rusqlite::Result<Conversation> {
    let meta_str: String = row.get("meta")?;
    Ok(Conversation {
        id: row.get("id")?,
        agent_config_name: row.get("agent_config_name")?,
        title: row.get("title")?,
        meta: serde_json::from_str(&meta_str).unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    let body_str: String = row.get("body")?;
    Ok(Message {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        body: serde_json::from_str(&body_str).unwrap_or_default(),
        created_at: row.get("created_at")?,
        // Both columns are nullable INTEGER (ADR-0030 §3); NULL → None,
        // which serde omits from the JSON payload via
        // `skip_serializing_if = "Option::is_none"` on the Message struct.
        usage_input_tokens: row.get("usage_input_tokens")?,
        usage_output_tokens: row.get("usage_output_tokens")?,
    })
}

// ─── commands ───────────────────────────────────────────────────────────────

/// List `kind = "world"` conversations, newest first. Chapter conversations
/// are NOT returned here — they are looked up per-chapter by future commands
/// (ADR Q6b). The `meta->>'kind'` filter uses SQLite's JSON1 extension.
#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_conversations(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Conversation>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, agent_config_name, title, meta, created_at, updated_at
             FROM conversations
             WHERE meta->>'kind' = 'world'
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], row_to_conversation)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Create a conversation row. `meta` is built server-side from `kind` (+ the
/// optional `chapter_id`) — the client never sends raw `meta`.
#[tracing::instrument(skip(state, input), fields(entity_id))]
#[tauri::command]
pub fn create_conversation(
    space_id: String,
    world_id: String,
    input: CreateConversationInput,
    state: State<'_, DbManager>,
) -> Result<Conversation, DbError> {
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();

    // Build meta server-side from the kind discriminator. A chapter
    // conversation carries the chapterId; anything else collapses to "world"
    // (defensive against an unexpected kind value). A chapter kind WITHOUT a
    // chapter_id is rejected — storing `{"chapterId":null}` would violate the
    // frontend's discriminated-union schema (`chapterId` is required for the
    // chapter variant).
    let meta = match input.kind.as_str() {
        "chapter" => {
            let chapter_id = input.chapter_id.ok_or_else(|| {
                DbError::InvalidInput(
                    "kind=\"chapter\" requires a chapter_id".to_string(),
                )
            })?;
            serde_json::json!({
                "kind": "chapter",
                "chapterId": chapter_id,
            })
        }
        _ => serde_json::json!({ "kind": "world" }),
    };
    let meta_str = serde_json::to_string(&meta)?;

    state.with_world(&space_id, &world_id, |conn| {
        conn.execute(
            "INSERT INTO conversations (id, agent_config_name, title, meta, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, input.agent_config_name, input.title, meta_str, now, now],
        )?;
        // Read back the canonical row (house style: read after mutation).
        conn.query_row(
            "SELECT id, agent_config_name, title, meta, created_at, updated_at
             FROM conversations WHERE id = ?1",
            params![id],
            row_to_conversation,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Conversation", id),
            other => DbError::Sqlite(other),
        })
    })
}

/// Delete a conversation. The `messages` rows go away via the FK ON DELETE
/// CASCADE — no separate delete needed.
#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_conversation(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Conversation", id));
        }
        Ok(())
    })
}

/// Load all messages of a conversation, oldest first. Returns an empty vec
/// for a nonexistent conversation — never throws — matching the
/// SessionStore.loadMessages contract.
#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn load_messages(
    space_id: String,
    world_id: String,
    conversation_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Message>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, body, created_at, usage_input_tokens, usage_output_tokens
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map(params![&conversation_id], row_to_message)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Append a batch of messages to a conversation in a single transaction.
/// Each message row carries its client-generated id + body + created_at
/// (stored verbatim — never regenerated server-side). After the inserts the
/// conversation's `updated_at` is bumped so `list_conversations` reorders.
///
/// Each message may carry inline `attachments` (ADR-0044 / plan D2): after
/// the message INSERT, every attachment is validated + decoded
/// (`util::decode_and_validate_attachment`) and inserted into
/// `message_attachments` INSIDE THE SAME TRANSACTION — FK-safe (the parent
/// message row exists first) and atomic (a validation failure on ANY
/// attachment rolls back the WHOLE batch: no message row survives without
/// its attachments and vice versa). There is deliberately no standalone
/// write command — this is the only attachment write path.
#[tracing::instrument(skip(state, input), fields(conversation_id))]
#[tauri::command]
pub fn append_messages(
    space_id: String,
    world_id: String,
    input: AppendMessagesInput,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    tracing::Span::current().record("conversation_id", input.conversation_id.as_str());
    do_append_messages(&state, &space_id, &world_id, &input)
}

/// `append_messages` implementation over a bare `&DbManager` — the
/// `do_*` split per the crate's no-mock-runtime test convention (see
/// `commands/space.rs`). The command wrapper above only adds tracing.
pub(crate) fn do_append_messages(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &AppendMessagesInput,
) -> Result<(), DbError> {
    let now = now_iso();
    let conversation_id = input.conversation_id.clone();

    mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        for m in &input.messages {
            let body_str = serde_json::to_string(&m.body)?;
            tx.execute(
                "INSERT INTO messages (id, conversation_id, body, created_at, usage_input_tokens, usage_output_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    m.id,
                    &conversation_id,
                    body_str,
                    m.created_at,
                    m.usage_input_tokens,
                    m.usage_output_tokens,
                ],
            )?;

            for a in &m.attachments {
                // Validate + decode BEFORE the bytes reach SQLite. A failure
                // returns Err here — `tx` drops uncommitted, rolling back
                // every earlier message + attachment of this batch.
                let bytes = decode_and_validate_attachment(&a.data_base64, &a.mime, &a.kind)?;
                tx.execute(
                    "INSERT INTO message_attachments (id, message_id, position, kind, mime, filename, size_bytes, data_blob, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        a.id,
                        m.id,
                        a.position,
                        a.kind,
                        a.mime,
                        a.filename,
                        bytes.len() as i64,
                        bytes,
                        now,
                    ],
                )?;
                // Metadata only — NEVER the filename or content (they are
                // user creative content; redaction policy, ADR-0016).
                tracing::info!(
                    attachment_id = %a.id,
                    message_id = %m.id,
                    kind = %a.kind,
                    size_bytes = bytes.len(),
                    "attachment stored"
                );
            }
        }

        // Bump the conversation's updated_at so list_conversations reorders.
        tx.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, &conversation_id],
        )?;

        tx.commit()?;
        Ok(())
    })
}

/// Set, replace, or clear a conversation's Plan — the per-Conversation
/// working agenda stored at `meta.plan` (ADR-0028 / ADR-0029 Phase 1).
///
/// `Some(value)` writes `meta.plan` via SQLite `json_set` (other meta fields
/// like `kind` / `chapterId` are preserved); `None` removes the key via
/// `json_remove`. `updated_at` is bumped so `list_conversations` reorders.
/// The Plan payload stays opaque JSON (`serde_json::Value`) — no typed Rust
/// struct, continuing the "meta is opaque JSON" convention.
// `plan` is skipped: it is user creative content (TODO items routinely
// reference entity names, scene/chapter titles, plot points) and the
// redaction policy classifies such content as TRACE-only or NEVER loggable.
// Mirrors `append_messages` skipping `input` (commands/conversation.rs:184).
#[tracing::instrument(skip(state, plan), fields(conversation_id))]
#[tauri::command]
pub fn update_conversation_plan(
    space_id: String,
    world_id: String,
    conversation_id: String,
    plan: Option<serde_json::Value>,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    tracing::Span::current().record("conversation_id", conversation_id.as_str());
    let now = now_iso();

    state.with_world(&space_id, &world_id, |conn| {
        let affected = match &plan {
            Some(value) => {
                let plan_str = serde_json::to_string(value)?;
                conn.execute(
                    "UPDATE conversations
                     SET meta = json_set(meta, '$.plan', ?1), updated_at = ?2
                     WHERE id = ?3",
                    params![plan_str, now, &conversation_id],
                )?
            }
            None => conn.execute(
                "UPDATE conversations
                 SET meta = json_remove(meta, '$.plan'), updated_at = ?2
                 WHERE id = ?3",
                params![now, &conversation_id],
            )?,
        };
        if affected == 0 {
            return Err(DbError::NotFound("Conversation", conversation_id));
        }
        Ok(())
    })
}

/// Rename a conversation — writes the user-facing list label (`title`,
/// nullable: NULL = the frontend falls back to a default label).
///
/// `updated_at` is bumped so `list_conversations` reorders (the list is
/// sorted by `updated_at` DESC).
// `title` is skipped: it is user creative content (titles routinely
// reference entity names, plot points) and the redaction policy classifies
// such content as TRACE-only or NEVER loggable. Mirrors `plan` skipping in
// `update_conversation_plan` above.
#[tracing::instrument(skip(state, title), fields(conversation_id))]
#[tauri::command]
pub fn update_conversation_title(
    space_id: String,
    world_id: String,
    conversation_id: String,
    title: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    tracing::Span::current().record("conversation_id", conversation_id.as_str());
    let now = now_iso();

    state.with_world(&space_id, &world_id, |conn| {
        let affected = conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, &conversation_id],
        )?;
        if affected == 0 {
            return Err(DbError::NotFound("Conversation", conversation_id));
        }
        Ok(())
    })
}

// ─── tests ──────────────────────────────────────────────────────────────────

/// Attachment-persistence integration tests for `append_messages` over the
/// `do_*` helper (no `State<'_, _>`, no `AppHandle` — this crate has no
/// mock runtime). DB state is asserted via raw SQL SELECTs inside
/// `with_world`, mirroring `commands/novel.rs::tests`.
#[cfg(test)]
#[path = "tests/conversation.rs"]
mod attachment_tests;
