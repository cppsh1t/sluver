use serde::{Deserialize, Serialize};

/// An AI agent stored in `space.db` (ADR-0012). Each Space is seeded with
/// exactly two agents on creation — `explorer` and `writer` (see
/// `commands::space::do_create_space`). Agents cannot be created or deleted
/// by the frontend; only their `model_id` selection is mutable.
///
/// `model_id` is a composite `"{provider_id}/{model_id}"` (e.g.
/// `"anthropic/claude-sonnet-5"`) aligned with models.dev, or `None` when
/// the user hasn't picked a model yet. Deleting a provider credential
/// cascades a NULL-out of any agent whose `model_id` is rooted at that
/// provider (see `commands::ai::do_delete_provider_credential`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub model_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
