use serde::{Deserialize, Serialize};

/// Serde default helper for `include_scenes` — `true` so omitting the field
/// keeps Scenes in the timeline (the common case). See ADR-0033.
fn default_true() -> bool {
    true
}

/// Input filter for the `query_timeline` aggregation command (ADR-0033).
///
/// All fields optional; the command is a read-only projection over the
/// existing `events` + `scenes` tables — there is NO dedicated timeline table
/// (ADR-0033: derived, never persisted, never authored).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineQueryInput {
    /// Filter to entries involving this character (across any phase).
    #[serde(default)]
    pub character_id: Option<String>,

    /// Filter to entries at this location.
    #[serde(default)]
    pub location_id: Option<String>,

    /// Inclusive lower bound on `start_at` (ISO 8601 string compare).
    #[serde(default)]
    pub from: Option<String>,

    /// Exclusive upper bound on `start_at`.
    #[serde(default)]
    pub to: Option<String>,

    /// Restrict SCENES to this novel (does NOT affect events).
    #[serde(default)]
    pub novel_id: Option<String>,

    /// Restrict SCENES to those referencing this item (does not affect
    /// events — events have no items).
    #[serde(default)]
    pub item_id: Option<String>,

    /// Default `true`; `false` = events only.
    #[serde(default = "default_true")]
    pub include_scenes: bool,

    /// Default 50, clamped to [1, 100] by the command.
    #[serde(default)]
    pub limit: Option<i64>,
}

/// One chronological entry in the timeline — either an Event or a Scene
/// projected onto a common shape (ADR-0033).
///
/// The agent `timeline_lookup` surface returns every entry at its own
/// `start_at`; the UI's visual "absorption" rule is intentionally NOT applied
/// here (ADR-0033: chronological truth over visual de-duplication — this
/// divergence is the single most surprising property of the design).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    /// `"event"` or `"scene"`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    /// Resolved location name; `None` if the entry has no location.
    pub location_name: Option<String>,
    /// Character NAMES involved (resolved via the `*_character_refs` junction
    /// → `characters.name`). Empty `Vec` when none — never `None`.
    pub participants: Vec<String>,
    /// First ~200 chars of the event `description` / scene `summary`; `None`
    /// if empty.
    pub description_excerpt: Option<String>,
    /// EVENTS ONLY: names of scenes referencing this event via
    /// `scene_event_refs`. `None` for scenes.
    pub narrated_by_scene_names: Option<Vec<String>>,
    /// SCENES ONLY: names of events referenced by this scene via
    /// `scene_event_refs`. `None` for events.
    pub narrated_event_names: Option<Vec<String>>,
    /// SCENES ONLY: the parent novel's title. `None` for events.
    pub novel_title: Option<String>,
}

/// Response from `query_timeline`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResponse {
    /// Sorted ascending by `start_at`; entries with `NULL` `start_at` go LAST.
    pub entries: Vec<TimelineEntry>,
    /// Full match count BEFORE `limit` applied.
    pub total: i64,
    /// `total > entries.len()`.
    pub truncated: bool,
}

/// One row from `list_timeline_lanes` — a Character plus the number of
/// DISTINCT timeline entries (Events via `event_character_refs` + Scenes via
/// `scene_character_refs`) they participate in.
///
/// Drives the Timeline UI's default lane selection: lanes where
/// `participation_count > 2` are auto-shown, the rest populate the character
/// multiselect. Characters with zero participation are excluded by the query
/// (INNER JOIN) — they'd never be default-selected and would only clutter the
/// multiselect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLane {
    pub character_id: String,
    pub name: String,
    pub participation_count: i64,
}
