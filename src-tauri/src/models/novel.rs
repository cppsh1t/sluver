use serde::{Deserialize, Serialize};

use crate::models::character::CharacterRef;

/// Novel — a complete novel work. Its content is its chapters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Novel {
    pub id: String,
    pub world_id: String,
    pub title: String,
    pub description: String,
    pub chapter_ids: Vec<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNovelInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNovelInput {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
}

/// Chapter — a chapter in a novel. Position maintained by `position` column.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: String,
    pub novel_id: String,
    pub title: String,
    pub summary: String,
    pub scene_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChapterInput {
    pub title: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChapterInput {
    pub title: String,
    pub summary: String,
}

/// Scene — leaf unit of a novel, minimal AI generation target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub chapter_id: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub character_refs: Vec<CharacterRef>,
    pub location_id: Option<String>,
    pub item_ids: Vec<String>,
    pub event_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSceneInput {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub character_refs: Vec<CharacterRef>,
    #[serde(default)]
    pub location_id: Option<String>,
    #[serde(default)]
    pub item_ids: Vec<String>,
    #[serde(default)]
    pub event_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSceneInput {
    pub title: String,
    pub summary: String,
    pub content: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub character_refs: Vec<CharacterRef>,
    pub location_id: Option<String>,
    pub item_ids: Vec<String>,
    pub event_ids: Vec<String>,
}
