use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lore {
    pub id: String,
    pub world_id: String,
    pub name: String,
    pub description: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLoreInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLoreInput {
    pub name: String,
    pub description: String,
    pub notes: String,
    pub tags: Vec<String>,
}

/// Lightweight lore view for agent-tool list/search IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreSummary {
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
}
