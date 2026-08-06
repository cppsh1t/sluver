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
    /// API base URL, e.g. `"https://api.deepseek.com"`. The upstream field
    /// is `api`. Mapped to `apiBaseUrl` in camelCase for the frontend.
    /// Required for `@ai-sdk/openai-compatible` providers (which have no
    /// baked-in default); ignored by providers that hardcode their endpoint.
    pub api_base_url: Option<String>,
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
    /// Maximum context window in tokens, surfaced from the upstream `limit`
    /// field. `None` when upstream omits it. Renamed to `contextWindow` in
    /// the JSON payload (camelCase via `rename_all`) — the frontend cares
    /// about the semantic "how big a context can this model hold," not the
    /// upstream field name. Used by the UI's context-occupancy indicator.
    pub context_window: Option<u64>,
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
    /// Upstream field `api` — the provider's API base URL.
    #[serde(default)]
    pub(crate) api: Option<String>,
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
    /// Upstream models.dev field `limit` — an OBJECT, not a bare number:
    ///   `"limit": { "context": 204800, "output": 131072 }`
    /// `Option` because some upstream rows omit it. The field name is a
    /// single word, so `rename_all = "camelCase"` is a no-op here. See
    /// {@link RawModelLimit} for the inner shape; `parse_catalog` projects
    /// `limit.context` -> `CatalogModel.context_window`.
    #[serde(default)]
    pub(crate) limit: Option<RawModelLimit>,
}

/// Inner shape of the upstream `limit` object. `context` is the maximum
/// context window in tokens (the denominator for the context-occupancy
/// indicator, ADR-0030 §6); `output` is the max completion length. Both
/// `#[serde(default)]` so a row reporting only one half still parses.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawModelLimit {
    #[serde(default)]
    pub(crate) context: Option<u64>,
    /// Max completion length. Currently unread — kept to faithfully mirror
    /// the upstream shape and document that the field exists (useful if a
    /// future output-limit indicator needs it).
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) output: Option<u64>,
}

/// Persisted alongside the catalog JSON; records when the cached copy was
/// fetched so the 24h TTL check can decide whether a refresh is needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CatalogMeta {
    /// BCP-47 / RFC 3339 timestamp from `now_iso()`.
    #[serde(rename = "fetchedAt")]
    pub(crate) fetched_at: String,
}
