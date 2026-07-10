use serde::{Deserialize, Serialize};

/// Reference to a character at a specific phase. Composite key — no duplicates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRef {
    pub character_id: String,
    pub phase_id: String,
}

/// A single period in a character's life.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterPhase {
    pub id: String,
    pub character_id: String,
    pub appearance: String,
    pub changes: String,
    pub trigger_event_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for creating a new phase.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePhaseInput {
    pub appearance: String,
    #[serde(default)]
    pub changes: String,
    #[serde(default)]
    pub trigger_event_id: Option<String>,
}

/// Input for updating a phase (full replacement).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePhaseInput {
    pub appearance: String,
    pub changes: String,
    pub trigger_event_id: Option<String>,
}

/// Character entity with all phases.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub world_id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub phases: Vec<CharacterPhase>,
    pub notes: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for creating a character (requires an initial phase).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCharacterInput {
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub initial_phase: CreatePhaseInput,
}

/// Input for updating a character (full replacement, phases managed separately).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCharacterInput {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub notes: String,
    pub tags: Vec<String>,
}
