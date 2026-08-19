use serde::{Deserialize, Serialize};

/// Conversation — one AI chat thread, persisted in `world.db` (ADR-0022).
///
/// Mirrors the pure library's `SessionRecord`. The `meta` JSON field always
/// carries a `kind` discriminator (`"world"` or `"chapter"`, the latter with
/// a `chapterId`). `agent_config_name` is set at creation and immutable; the
/// model is resolved live from the AgentConfig at run time (ADR-0023), so it
/// is NOT snapshotted here.
///
/// `meta` is stored as TEXT (JSON) in SQLite and exposed as
/// `serde_json::Value`; the command helpers (row_to_conversation /
/// create_conversation) perform the string ↔ Value mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub agent_config_name: String,
    pub title: Option<String>,
    pub meta: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// Message — one persisted AI message belonging to a Conversation.
///
/// `body` is the full `ModelMessage` JSON (role + content parts); serde
/// handles the round-trip into the `serde_json::Value` field. IDs come from
/// the client (UUID v4 from the pure lib's `toSessionMessage`); messages are
/// always ordered by `created_at`, never by id (ADR-0022 §2).
///
/// `usage_input_tokens` / `usage_output_tokens` carry the per-turn token
/// usage (ADR-0030). Usage is a turn-level property; per the ADR's "attach
/// to the last assistant message" convention (§2), only ONE row per turn
/// (the last `role = "assistant"`) ever carries non-NULL values — user and
/// tool messages, plus any assistant row that is not the turn's last, stay
/// NULL. Both fields are independently NULL when the provider did not
/// report that half (§4 — preserves "unknown" vs "real zero").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub body: serde_json::Value,
    pub created_at: String,
    /// Per-turn input-token count, attached to the turn's last assistant
    /// message row (ADR-0030 §2). NULL on non-assistant rows, non-last
    /// assistant rows, pre-migration rows, and any turn where the provider
    /// omitted `inputTokens`. A real `0` is stored verbatim (§4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_input_tokens: Option<i64>,
    /// Per-turn output-token count — see {@link usage_input_tokens}.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_output_tokens: Option<i64>,
}

/// Input for `create_conversation`. The server builds `meta` from `kind` +
/// the optional `chapter_id`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationInput {
    pub agent_config_name: String,
    /// Discriminator stored in `meta.kind`: `"world"` or `"chapter"`.
    pub kind: String,
    #[serde(default)]
    pub chapter_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

/// A single message row supplied by the client for `append_messages`. The id
/// is client-generated (UUID v4) and stored verbatim — see ADR-0022 for the
/// v7/v4 id split rationale.
///
/// `usage_input_tokens` / `usage_output_tokens` are present ONLY on the
/// turn's last assistant row (ADR-0030 §2); the client (`TauriSessionStore`)
/// is responsible for attaching them to exactly one row and leaving them
/// absent on the rest. `Option<i64>` mirrors {@link Message}; `None` here
/// means "do not write a value" (the column defaults to NULL).
///
/// `attachments` carries the message's file attachments inline (ADR-0044 /
/// plan D2) — `#[serde(default)]` so payloads from pre-attachment clients
/// (and messages without attachments) deserialize unchanged with an empty
/// vec. Rows are inserted in the same transaction as the message; the bytes
/// are validated server-side before reaching SQLite.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub body: serde_json::Value,
    pub created_at: String,
    #[serde(default)]
    pub usage_input_tokens: Option<i64>,
    #[serde(default)]
    pub usage_output_tokens: Option<i64>,
    #[serde(default)]
    pub attachments: Vec<crate::models::attachment::AttachmentInput>,
}

/// Input for `append_messages` — a batch of messages plus the target
/// conversation id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessagesInput {
    pub conversation_id: String,
    pub messages: Vec<MessageInput>,
}
