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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub body: serde_json::Value,
    pub created_at: String,
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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub body: serde_json::Value,
    pub created_at: String,
}

/// Input for `append_messages` — a batch of messages plus the target
/// conversation id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessagesInput {
    pub conversation_id: String,
    pub messages: Vec<MessageInput>,
}
