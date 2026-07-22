use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Slimmed-down view of the models.dev catalog returned to the frontend.
/// Only the fields the UI needs are projected out; unknown fields from the
/// upstream JSON are dropped during parsing (see `RawCatalog`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsDevCatalog {
    pub providers: Vec<CatalogProvider>,
    /// ISO timestamp of the last successful fetch. Empty string if the
    /// local meta file is missing/corrupt (shouldn't happen in normal use).
    pub fetched_at: String,
    /// `true` when the upstream fetch failed and the returned payload is a
    /// previously-cached copy. The frontend surfaces a stale-warning banner.
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvider {
    /// models.dev provider id, e.g. `"anthropic"` (taken from the JSON's
    /// top-level object key).
    pub id: String,
    /// Human-readable name, e.g. `"Anthropic"`. Falls back to `id` if the
    /// upstream row omits `name`.
    pub name: String,
    /// npm package for the AI SDK integration, e.g. `"@ai-sdk/anthropic"`.
    pub npm: Option<String>,
    /// Icon URL (relative or absolute, as upstream provides).
    pub icon_url: Option<String>,
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    /// Model id within the provider, e.g. `"claude-sonnet-5"` (taken from
    /// the inner object key of the upstream `models` map).
    pub id: String,
    /// Human-readable name. Falls back to `id` if upstream omits `name`.
    pub name: String,
}

// ─── intermediate parsing structs (private) ─────────────────────────────────
//
// The upstream `https://models.dev/api.json` shape is:
//   { "<providerId>": { name?, npm?, iconUrl?, models: { "<modelId>": { name?, ... } } } }
//
// Unknown fields are tolerated (serde ignores them by default). Missing
// fields default via `#[serde(default)]` so a row missing `name`/`npm`/
// `iconUrl` parses successfully and the caller falls back to the key.

#[derive(Debug, Deserialize)]
pub(crate) struct RawCatalog(pub HashMap<String, RawProvider>);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawProvider {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) npm: Option<String>,
    #[serde(default)]
    pub(crate) icon_url: Option<String>,
    #[serde(default)]
    pub(crate) models: HashMap<String, RawModel>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawModel {
    #[serde(default)]
    pub(crate) name: Option<String>,
}

/// Persisted alongside the catalog JSON; records when the cached copy was
/// fetched so the 24h TTL check can decide whether a refresh is needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CatalogMeta {
    /// BCP-47 / RFC 3339 timestamp from `now_iso()`.
    #[serde(rename = "fetchedAt")]
    pub(crate) fetched_at: String,
}
