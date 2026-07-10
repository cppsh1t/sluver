use serde::{Deserialize, Serialize};

use crate::models::character::CharacterRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub world_id: String,
    pub name: String,
    pub description: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub character_refs: Vec<CharacterRef>,
    pub location_id: Option<String>,
    pub notes: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub character_refs: Vec<CharacterRef>,
    #[serde(default)]
    pub location_id: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEventInput {
    pub name: String,
    pub description: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub character_refs: Vec<CharacterRef>,
    pub location_id: Option<String>,
    pub notes: String,
    pub tags: Vec<String>,
}
