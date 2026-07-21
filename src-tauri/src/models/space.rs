use serde::{Deserialize, Serialize};

/// Safe frontend view of a Space. Never carries the password hash — the
/// `has_password` flag is derived from whether a hash is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSummary {
    pub id: String,
    pub name: String,
    pub has_password: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for creating a new Space. `password` is the plaintext password to
/// set (argon2id-hashed before storage); `None` means unprotected.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpaceInput {
    pub name: String,
    pub password: Option<String>,
}

/// Input for updating a Space's mutable metadata. Password changes go
/// through `set_space_password`, NOT here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSpaceInput {
    pub name: Option<String>,
}

/// Input for the password lifecycle command.
/// - add:    `current_password = None`, `new_password = Some`
/// - change: `current_password = Some`, `new_password = Some`
/// - remove: `current_password = Some`, `new_password = None`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSpacePasswordInput {
    pub current_password: Option<String>,
    pub new_password: Option<String>,
}

/// Session state persisted in `meta.db` settings KV across restarts.
///
/// Per ADR-0011 (per-Space OS windows) the open/active lists collapsed into
/// a single `last_opened_space_id` (restored on startup). `locked_space_ids`
/// tracks which protected Spaces currently need a password to access content
/// (their cached `space.db` connections have been dropped — see ADR-0008).
///
/// `deny_unknown_fields` is REQUIRED for transparent migration from the
/// pre-ADR-0011 format (`openSpaceIds` + `activeSpaceId`): without it, serde
/// would silently accept old JSON (ignoring the extra fields) and
/// `last_opened_space_id` would default to `None`, losing the user's last
/// active Space. With it, old JSON fails deserialization and the migration
/// path in [`crate::commands::session::read_session`] kicks in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionState {
    pub last_opened_space_id: Option<String>,
    pub locked_space_ids: Vec<String>,
}
