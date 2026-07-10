use serde::{Deserialize, Serialize};

/// World entity — top-level container. Source of truth lives in `meta.db`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for creating a new world.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorldInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// Input for updating a world (full replacement).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorldInput {
    pub name: String,
    pub description: String,
}
