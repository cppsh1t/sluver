use serde::Serialize;

/// Top-level response of the `grep` command (ADR-0035) — a match-centric,
/// field-grouped sweep across all author-written text of one World.
///
/// Carries the query back verbatim so the response is self-describing in
/// tool transcripts. Note the query is IPC payload only — it is never
/// logged (ADR-0016 never-log applies to query text at any level).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResult {
    /// Echoes the caller's query verbatim.
    pub query: String,
    /// Match groups, sorted by `match_count` desc (ties → fixed entity-type
    /// order, then `entity_title` asc), capped at 50 entries.
    pub groups: Vec<GrepMatchGroup>,
    /// Full group count BEFORE the 50-group cap was applied.
    pub group_count: i64,
    /// `true` when `group_count > groups.len()` — the model should re-query
    /// with a narrower `entityTypes` or a more specific query.
    pub truncated: bool,
}

/// One match group: every occurrence of the query within ONE field of ONE
/// entity, collapsed to a count plus up to 3 snippets (ADR-0035 §3 — a
/// protagonist name appearing 50× in one scene stays one group, not 50
/// occurrence records).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatchGroup {
    /// One of the 9 grep corpus types (`"character"`, `"phase"`, …).
    pub entity_type: String,
    /// Directly usable by the `get_*` family. For phase groups this is the
    /// PHASE id — never an overloaded `character` + non-null phase id
    /// encoding (ADR-0035 §3).
    pub entity_id: String,
    /// The entity's `name` (or `title` for novel/chapter/scene); for phase
    /// groups, the phase's own name.
    pub entity_title: String,
    /// PHASE groups only: the owning character's id. `None` otherwise.
    pub character_id: Option<String>,
    /// PHASE groups only: the owning character's name. `None` otherwise.
    pub character_name: Option<String>,
    /// The field the matches live in (e.g. `"content"`, `"aliases"`, `"tags"`).
    pub field_name: String,
    /// Total non-overlapping occurrences (plain-text fields) or matching
    /// elements (JSON-array fields) — uncapped; preserves the "mentioned
    /// 50 times" signal beyond the snippet sample.
    pub match_count: i64,
    /// The first `SNIPPETS_PER_GROUP` occurrences as context snippets.
    pub snippets: Vec<GrepSnippet>,
}

/// Three-part context snippet around one occurrence (ADR-0035 §4): up to 40
/// CHARS per side, no `...`/`【】` marker glyphs — markers collide with
/// characters that occur in prose and mislead the model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepSnippet {
    /// Up to 40 chars immediately before the match (`""` when none).
    pub before: String,
    /// The matched text, original case. `match` is a Rust keyword, hence
    /// the raw identifier — serde still emits the field as `"match"`.
    pub r#match: String,
    /// Up to 40 chars immediately after the match (`""` when none).
    pub after: String,
}
