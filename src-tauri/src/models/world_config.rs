use serde::{Deserialize, Serialize};

/// TimeMapper configuration stored in the `world_config` KV table.
///
/// Per ADR-0026 the mapper is a user-authored JavaScript function
/// `(iso: string) => string` that renders ISO timestamps into the World's
/// custom time representation at display time. Only the raw source `code`
/// is persisted; it executes in an isolated Web Worker on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeMapperConfig {
    pub code: String,
}
