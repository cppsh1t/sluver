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
/// `locked_space_ids` is always a subset of `open_space_ids`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub open_space_ids: Vec<String>,
    pub active_space_id: Option<String>,
    pub locked_space_ids: Vec<String>,
}
