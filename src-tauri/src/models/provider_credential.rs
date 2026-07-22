use serde::{Deserialize, Serialize};

/// A configured AI provider credential stored in `space.db` (ADR-0012).
///
/// `provider_id` aligns with models.dev's provider id (e.g. `"anthropic"`,
/// `"openai"`). Per ADR-0013 the `api_key` is stored as plaintext — the
/// threat model and upgrade path are documented there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredential {
    pub id: String,
    pub provider_id: String,
    pub api_key: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for `set_provider_credential` (UPSERT by `provider_id`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderCredentialInput {
    pub provider_id: String,
    pub api_key: String,
}
