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
    pub author: String,
    pub chapter_ids: Vec<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub has_image: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNovelInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNovelInput {
    pub title: String,
    pub description: String,
    pub author: String,
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
    pub lore_ids: Vec<String>,
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
    #[serde(default)]
    pub lore_ids: Vec<String>,
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
    pub lore_ids: Vec<String>,
}

/// SceneImageMeta — metadata for one image in a scene's gallery (1:N
/// sidecar table `scene_images`, added by `WORLD_MIGRATION_008`). The
/// `image_blob` column is deliberately absent: bytes flow only through
/// `get_scene_image` (tauri::ipc::Response), never through this struct —
/// carrying `Vec<u8>` here would hit the serde Vec<u8> → JSON-number-array
/// encoding trap and bloat every list payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneImageMeta {
    pub id: String,
    pub scene_id: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

// ─── Lightweight summary views (agent-tool list/search IPC) ──────────────────
//
// Read-only return types — never deserialized. Each deliberately omits the
// heavy / creative-content fields (descriptions, summaries, scene content,
// junction refs) so agent-tool payloads stay small.

/// Lightweight novel view for agent-tool list/search IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelSummary {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub author: String,
}

/// Lightweight chapter view for agent-tool list/search IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummary {
    pub id: String,
    pub title: String,
}

/// Lightweight scene view for agent-tool list/search IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSummary {
    pub id: String,
    pub title: String,
}

// ─── Overview views (agent chapter-overview tool) ───────────────────────────
//
// A middle tier between the minimal `*Summary` views (id + title) and the full
// entities. `SceneOverview` is a `Scene` with the heavy `content` (正文) field
// stripped — it keeps the summary, timeline, and ALL entity references so an
// agent can understand what happens in a chapter and which worldbook entities
// are involved, without paying the cost of transferring every scene's prose.

/// Scene without its `content` body — keeps summary, timeline, and all refs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOverview {
    pub id: String,
    pub chapter_id: String,
    pub title: String,
    pub summary: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub character_refs: Vec<CharacterRef>,
    pub location_id: Option<String>,
    pub item_ids: Vec<String>,
    pub event_ids: Vec<String>,
    pub lore_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A chapter together with all its scenes' overviews (no scene prose).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterOverview {
    pub chapter: Chapter,
    pub scenes: Vec<SceneOverview>,
}
