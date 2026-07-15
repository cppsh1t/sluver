use serde::Serialize;

/// Number of times a phase (or all of a character's phases) is referenced
/// by other entities. Used to surface impact information before a delete.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefCounts {
    pub events: u64,
    pub scenes: u64,
}
