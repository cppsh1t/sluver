use serde::{Deserialize, Serialize};

/// Input for one chat message attachment, supplied inline on
/// [`MessageInput`](crate::models::conversation::MessageInput) and written
/// by `append_messages` in the same transaction as the message row
/// (ADR-0044 / plan D2).
///
/// The id is client-minted (UUID v4 from `crypto.randomUUID()` at
/// dehydrate time) and stored verbatim — the exact precedent of
/// `messages.id` (WORLD_MIGRATION_004). This is what makes the
/// single-transaction atomic persist possible: the persisted `body`
/// already references the id as `attachment://{id}` when the row is
/// written, so the server must NOT re-mint it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub id: String,
    /// 0-based order within the message, fixed at send time.
    pub position: i64,
    /// `"image"` or `"text"` — the DB CHECK constraint domain
    /// (WORLD_MIGRATION_013) and the validator's kind discriminator.
    pub kind: String,
    pub mime: String,
    /// Original filename. User creative content — NEVER logged
    /// (redaction policy, ADR-0016).
    pub filename: String,
    /// Standard-alphabet base64 of the raw bytes. Decoded + validated
    /// server-side (`util::decode_and_validate_attachment`) before the
    /// bytes reach SQLite.
    pub data_base64: String,
}

/// Metadata-only view of a stored attachment row — NO blob field. Returned
/// by `list_message_attachments`; the bytes themselves flow only through
/// `get_message_attachment` as a binary IPC response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: String,
    pub message_id: String,
    pub position: i64,
    pub kind: String,
    pub mime: String,
    pub filename: String,
    pub size_bytes: i64,
    pub created_at: String,
}
