//! Match-centric full-corpus retrieval IPC for the agent-chat tool surface
//! (ADR-0035).
//!
//! Division of labor with `world_search.rs` (entity-centric): the `search_*`
//! commands answer "WHICH entities match a keyword" and return entity
//! summaries; `grep` answers "WHERE does this text occur across the World"
//! and returns field-grouped occurrence evidence — match count, context
//! snippets, and redundant entity identity — so the model can judge usage
//! without a second `get_*` call. Find entities with `search_*`; find where
//! text occurs with `grep`. That boundary is load-bearing (ADR-0035: a
//! blurred one makes models double-call both for the same question).
//!
//! Implementation: per-table SQL `LIKE` prefilter (plain `%{query}%` pattern,
//! same as `world_search.rs` — no escaping, so the prefilter is intentionally
//! a superset: `%`/`_` in the query act as wildcards and ASCII folding may
//! admit rows the literal scan rejects), followed by an in-memory Rust scan
//! that applies the literal semantics, counts NON-overlapping occurrences,
//! and extracts UTF-8-boundary-safe snippets. JSON-array columns
//! (`aliases` / `tags`) prefilter via `json_each` ELEMENT matching rather
//! than raw column `LIKE` — serde-escaped element text (`\"`, `\\`) would
//! otherwise hide queries spanning those characters and break the superset
//! invariant (ADR-0035 §6; see {@link json_array_prefilter}).
//!
//! Logging (ADR-0014 / ADR-0016): `query` is user creative content and is
//! NEVER logged at any level; snippet content never leaves the IPC response.
//! The command records only `world_id`, `entity_types`, and the aggregate
//! `group_count` / `truncated` outcome.

use std::collections::HashSet;

use rusqlite::{params, Connection};
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::{GrepMatchGroup, GrepResult, GrepSnippet};

/// Soft ceiling on match groups returned PER PAGE (ADR-0035 §5, amended).
/// A broader query still reports its full `group_count` and the model
/// paginates via `offset` — the deterministic sort makes pages stable, so
/// completeness costs more tool calls, not bigger context payloads.
const MAX_GROUPS: usize = 50;

/// Context snippets kept per group. Three suffice to judge the surrounding
/// usage; anything deeper is a `get_*` call away (ADR-0035 §3).
const SNIPPETS_PER_GROUP: usize = 3;

/// Context window on each side of a match, measured in CHARS (not bytes —
/// the primary language of this app's content is Chinese). Excludes marker
/// glyphs by design (ADR-0035 §4).
const SNIPPET_CONTEXT_CHARS: usize = 40;

/// The 9 entity types of the grep corpus in fixed order. Doubles as (a) the
/// tie-break order for deterministic sorting (ADR-0035 §5) and (b) the
/// known-values filter for the `entity_types` argument.
const ALL_ENTITY_TYPES: [&str; 9] = [
    "character",
    "phase",
    "location",
    "item",
    "lore",
    "event",
    "novel",
    "chapter",
    "scene",
];

// ─── matching helpers ────────────────────────────────────────────────────────

/// Wrap a user query in SQL LIKE wildcards. Mirrors `world_search.rs` — no
/// escaping; the prefilter is a superset and literal semantics come from the
/// Rust scan. The query itself is never logged.
///
/// `pub(crate)`: shared with `commands/note.rs::grep_notes` (ADR-0037
/// amendment applies ADR-0035 semantics to the notes corpus) — semantics
/// must stay identical.
pub(crate) fn like_pattern(query: &str) -> String {
    format!("%{query}%")
}

/// SQL prefilter predicate for a JSON-array column: any ELEMENT matches.
///
/// Raw column `LIKE` is WRONG here: serde_json escapes `"` → `\"` and `\` →
/// `\\` inside the stored JSON TEXT, so a query spanning an escaped
/// character (alias `6"9" 身高`, query `9" 身`) would miss the row at the
/// prefilter stage — a false negative that breaks the prefilter-is-a-
/// superset invariant (ADR-0035 §6). `json_each` matches against the
/// UNESCAPED element text instead. The `json_valid` CASE degrades malformed
/// JSON (NULL / corrupt text) to an empty array — `json_each` on invalid
/// JSON would error the whole statement, while the Rust-side
/// `serde_json … unwrap_or_default()` already tolerates the same rows.
fn json_array_prefilter(col: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid({col}) THEN {col} ELSE '[]' END) \
         WHERE json_each.value LIKE ?1)"
    )
}

/// ASCII-only case folding: lowercase ASCII letters, every other char
/// untouched. This matches SQLite's `LIKE` folding exactly (ADR-0035 §6) —
/// `str::to_lowercase` would apply Unicode folding and create false
/// negatives between the SQL prefilter and this scan.
///
/// The fold is byte-length preserving (ASCII chars stay single bytes,
/// multi-byte sequences pass through), so char boundaries — and therefore
/// `str::find` byte offsets — coincide between the folded and original
/// strings: offsets found in the folded haystack are safe slicing offsets
/// into the original.
///
/// `pub(crate)`: shared with `commands/note.rs::grep_notes` — the SQL
/// prefilter / Rust scan folding agreement is load-bearing there too.
pub(crate) fn fold_ascii(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c })
        .collect()
}

/// Up to `max_chars` CHARS of `s` immediately before byte offset `end`
/// (exclusive). Walks back over char boundaries, so it never slices mid
/// UTF-8 sequence. `end` must itself be a char boundary (all call sites pass
/// a match offset from `find` on the byte-length-preserving folded string).
fn context_before(s: &str, end: usize, max_chars: usize) -> String {
    let mut start = end;
    let mut taken = 0usize;
    while start > 0 && taken < max_chars {
        let mut prev = start - 1;
        while prev > 0 && !s.is_char_boundary(prev) {
            prev -= 1;
        }
        start = prev;
        taken += 1;
    }
    s[start..end].to_string()
}

/// Scan one plain-text field: ASCII-folded, NON-overlapping substring
/// occurrences. Counts every match (uncapped — the "mentioned 50 times"
/// signal survives the snippet sample) and turns the first
/// `SNIPPETS_PER_GROUP` occurrences into context snippets. Returns `None`
/// when the field has zero matches (no group is emitted).
///
/// `pub(crate)`: shared with `commands/note.rs::grep_notes`, which maps
/// the returned `GrepSnippet`s onto its `NoteSnippet` (identical shape) —
/// one tested implementation of the tricky UTF-8-boundary scan, no drift.
pub(crate) fn scan_text_field(haystack: &str, folded_needle: &str) -> Option<(i64, Vec<GrepSnippet>)> {
    let folded_haystack = fold_ascii(haystack);
    let mut count: i64 = 0;
    let mut snippets = Vec::new();
    let mut search_from = 0usize;
    while let Some(relative) = folded_haystack[search_from..].find(folded_needle) {
        let start = search_from + relative;
        let end = start + folded_needle.len();
        if snippets.len() < SNIPPETS_PER_GROUP {
            snippets.push(GrepSnippet {
                before: context_before(haystack, start, SNIPPET_CONTEXT_CHARS),
                r#match: haystack[start..end].to_string(),
                after: haystack[end..]
                    .chars()
                    .take(SNIPPET_CONTEXT_CHARS)
                    .collect(),
            });
        }
        count += 1;
        // Advance past the whole match → non-overlapping counting.
        search_from = end;
    }
    if count > 0 {
        Some((count, snippets))
    } else {
        None
    }
}

/// Scan one JSON-array field (`aliases` / `tags`): the raw JSON TEXT is
/// deserialized first and ELEMENTS are matched individually — a raw LIKE on
/// the stored JSON column would hit JSON syntax noise (ADR-0035 §2). Each
/// matching element counts once and becomes a whole-element snippet with no
/// context: the element itself is the unit. Returns `None` when no element
/// matches.
fn scan_json_array_field(raw: &str, folded_needle: &str) -> Option<(i64, Vec<GrepSnippet>)> {
    let elements: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
    let mut count: i64 = 0;
    let mut snippets = Vec::new();
    for element in &elements {
        if fold_ascii(element).contains(folded_needle) {
            if snippets.len() < SNIPPETS_PER_GROUP {
                snippets.push(GrepSnippet {
                    before: String::new(),
                    r#match: element.clone(),
                    after: String::new(),
                });
            }
            count += 1;
        }
    }
    if count > 0 {
        Some((count, snippets))
    } else {
        None
    }
}

/// Fixed entity-type rank for deterministic tie-breaking (ADR-0035 §5):
/// character=0 … scene=8, mirroring `ALL_ENTITY_TYPES` order. Unreachable
/// `u8::MAX` arm exists only because the type string is dynamic.
fn entity_type_rank(entity_type: &str) -> u8 {
    ALL_ENTITY_TYPES
        .iter()
        .position(|t| *t == entity_type)
        .map_or(u8::MAX, |i| i as u8)
}

/// Result shape shared by the defensive early returns (blank query / empty
/// entity-type selection after normalization): zero groups, not truncated.
fn empty_result(query: String) -> GrepResult {
    GrepResult {
        query,
        groups: Vec::new(),
        group_count: 0,
        truncated: false,
    }
}

/// Deterministic pagination over the SORTED groups (ADR-0035 §5, amended):
/// keep one page of `MAX_GROUPS` starting at `offset`. Negative offsets are
/// clamped to 0 (the model may misremember its page position); an offset
/// past the end yields an empty page with `has_more = false`. Returns
/// `(page, total_group_count, has_more)`.
///
/// Correctness rests on the caller having applied the full deterministic
/// sort first: same input → same ordering → stable pages across calls, so
/// the model can walk `offset` 0, 50, 100, … without duplicates or gaps
/// (concurrent edits between fetches can shift boundaries — inherent to any
/// offset scheme, acceptable at desktop scale).
fn paginate(sorted: Vec<GrepMatchGroup>, offset: i64) -> (Vec<GrepMatchGroup>, i64, bool) {
    let total = sorted.len() as i64;
    let offset = offset.max(0) as usize;
    let page: Vec<GrepMatchGroup> = sorted.into_iter().skip(offset).take(MAX_GROUPS).collect();
    let has_more = offset + page.len() < total as usize;
    (page, total, has_more)
}

// ─── command ─────────────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, query), fields(world_id = %world_id))]
#[tauri::command]
pub fn grep(
    space_id: String,
    world_id: String,
    query: String,
    entity_types: Option<Vec<String>>,
    offset: Option<i64>,
    state: State<'_, DbManager>,
) -> Result<GrepResult, DbError> {
    // Defensive: a whitespace query would build a `'%…%'` pattern that
    // matches (nearly) every row and then match nothing literally — a full
    // table sweep for an empty result. Bail before touching SQLite.
    if query.trim().is_empty() {
        return Ok(empty_result(query));
    }

    // Normalize the entity-type filter: `None` = full corpus; unknown values
    // are silently dropped. An empty selection (explicit empty vec, or only
    // unknown values supplied) short-circuits to the empty result.
    let selected: HashSet<&str> = match &entity_types {
        None => ALL_ENTITY_TYPES.iter().copied().collect(),
        Some(types) => types
            .iter()
            .map(String::as_str)
            .filter(|t| ALL_ENTITY_TYPES.contains(t))
            .collect(),
    };
    if selected.is_empty() {
        return Ok(empty_result(query));
    }

    let pat = like_pattern(&query);
    let needle = fold_ascii(&query);

    let mut groups = state.with_world(&space_id, &world_id, |conn| {
        let mut groups = Vec::new();
        if selected.contains("character") {
            groups.extend(scan_characters(conn, &pat, &needle)?);
        }
        if selected.contains("phase") {
            groups.extend(scan_phases(conn, &pat, &needle)?);
        }
        if selected.contains("location") {
            groups.extend(scan_locations(conn, &pat, &needle)?);
        }
        if selected.contains("item") {
            groups.extend(scan_items(conn, &pat, &needle)?);
        }
        if selected.contains("lore") {
            groups.extend(scan_lores(conn, &pat, &needle)?);
        }
        if selected.contains("event") {
            groups.extend(scan_events(conn, &pat, &needle)?);
        }
        if selected.contains("novel") {
            groups.extend(scan_novels(conn, &pat, &needle)?);
        }
        if selected.contains("chapter") {
            groups.extend(scan_chapters(conn, &pat, &needle)?);
        }
        if selected.contains("scene") {
            groups.extend(scan_scenes(conn, &pat, &needle)?);
        }
        Ok(groups)
    })?;

    // Deterministic ordering (ADR-0035 §5): match_count desc → fixed
    // entity-type order → title asc. entity_id as the final stabilizer
    // guards same-shape ties (e.g. same-title chapters in different novels)
    // against SQLite's unspecified row order — same input, same output.
    groups.sort_by(|a, b| {
        b.match_count
            .cmp(&a.match_count)
            .then_with(|| {
                entity_type_rank(&a.entity_type).cmp(&entity_type_rank(&b.entity_type))
            })
            .then_with(|| a.entity_title.cmp(&b.entity_title))
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });

    let (page, group_count, truncated) = paginate(groups, offset.unwrap_or(0));

    let result = GrepResult {
        query,
        groups: page,
        group_count,
        truncated,
    };
    tracing::debug!(
        group_count = %result.group_count,
        truncated = result.truncated,
        "grep completed"
    );
    Ok(result)
}

// ─── per-table scans ─────────────────────────────────────────────────────────
//
// Each scan runs the SQL LIKE prefilter and hands surviving rows' text
// fields to the Rust matcher. Tables not selected by `entity_types` are
// skipped wholesale by the command above.

/// One candidate field of a row, classified by storage shape.
enum Field<'a> {
    /// Plain-text column — scanned as one haystack.
    Text(&'a str, &'a str),
    /// JSON-array column (`aliases` / `tags`) — matched per element, never
    /// against the raw JSON TEXT.
    JsonArray(&'a str, &'a str),
}

/// Scan one row's fields against the folded needle, appending one group per
/// field with ≥1 match. `character` carries the redundant owner identity and
/// is `Some` only for phase rows (ADR-0035 §3).
fn push_field_groups(
    groups: &mut Vec<GrepMatchGroup>,
    entity_type: &str,
    entity_id: &str,
    entity_title: &str,
    character: Option<(&str, &str)>,
    fields: &[Field<'_>],
    folded_needle: &str,
) {
    for field in fields {
        let (field_name, scanned) = match field {
            Field::Text(name, value) => (*name, scan_text_field(value, folded_needle)),
            Field::JsonArray(name, value) => (*name, scan_json_array_field(value, folded_needle)),
        };
        if let Some((match_count, snippets)) = scanned {
            groups.push(GrepMatchGroup {
                entity_type: entity_type.to_string(),
                entity_id: entity_id.to_string(),
                entity_title: entity_title.to_string(),
                character_id: character.map(|(id, _)| id.to_string()),
                character_name: character.map(|(_, name)| name.to_string()),
                field_name: field_name.to_string(),
                match_count,
                snippets,
            });
        }
    }
}

/// Characters: `aliases` + `tags` are JSON arrays; the rest is plain text.
fn scan_characters(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<GrepMatchGroup>, DbError> {
    let sql = format!(
        "SELECT id, name, aliases, description, notes, tags FROM characters
         WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1
            OR {} OR {}",
        json_array_prefilter("aliases"),
        json_array_prefilter("tags")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut groups = Vec::new();
    let mut rows = stmt.query(params![pat])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get("id")?;
        let name: String = row.get("name")?;
        let aliases: String = row.get("aliases")?;
        let description: String = row.get("description")?;
        let notes: String = row.get("notes")?;
        let tags: String = row.get("tags")?;
        push_field_groups(
            &mut groups,
            "character",
            &id,
            &name,
            None,
            &[
                Field::Text("name", &name),
                Field::JsonArray("aliases", &aliases),
                Field::Text("description", &description),
                Field::Text("notes", &notes),
                Field::JsonArray("tags", &tags),
            ],
            needle,
        );
    }
    Ok(groups)
}

/// Phases are the blind spot of `search_characters` (independent table) —
/// grep covers their four author-written fields (ADR-0035 §2). The JOIN
/// resolves the redundant owner identity so the model can act on a phase
/// hit without a second `get_*` call. `entity_id` is the PHASE id.
fn scan_phases(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<GrepMatchGroup>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT p.id AS phase_id, p.name AS phase_name, p.appearance,
                p.description, p.conversation_style,
                p.character_id, c.name AS character_name
         FROM character_phases p
         JOIN characters c ON c.id = p.character_id
         WHERE p.name LIKE ?1 OR p.appearance LIKE ?1
            OR p.description LIKE ?1 OR p.conversation_style LIKE ?1",
    )?;
    let mut groups = Vec::new();
    let mut rows = stmt.query(params![pat])?;
    while let Some(row) = rows.next()? {
        let phase_id: String = row.get("phase_id")?;
        let phase_name: String = row.get("phase_name")?;
        let appearance: String = row.get("appearance")?;
        let description: String = row.get("description")?;
        let conversation_style: String = row.get("conversation_style")?;
        let character_id: String = row.get("character_id")?;
        let character_name: String = row.get("character_name")?;
        push_field_groups(
            &mut groups,
            "phase",
            &phase_id,
            &phase_name,
            Some((&character_id, &character_name)),
            &[
                Field::Text("name", &phase_name),
                Field::Text("appearance", &appearance),
                Field::Text("description", &description),
                Field::Text("conversation_style", &conversation_style),
            ],
            needle,
        );
    }
    Ok(groups)
}

// ─── Location / Item / Lore (shared shape: name, description, notes, tags) ───
//
// The three "element" tables share identical SELECT columns and predicates
// for this use case, so we generate the scan per table via one macro
// instantiated 3× — the same pattern as `impl_element_summary_commands!` in
// `world_search.rs`.

macro_rules! impl_element_grep_scan {
    ($scan:ident, $table:literal, $entity_type:literal) => {
        fn $scan(
            conn: &Connection,
            pat: &str,
            needle: &str,
        ) -> Result<Vec<GrepMatchGroup>, DbError> {
            let sql = format!(
                "SELECT id, name, description, notes, tags FROM {}
                 WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1 OR {}",
                $table,
                json_array_prefilter("tags")
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut groups = Vec::new();
            let mut rows = stmt.query(params![pat])?;
            while let Some(row) = rows.next()? {
                let id: String = row.get("id")?;
                let name: String = row.get("name")?;
                let description: String = row.get("description")?;
                let notes: String = row.get("notes")?;
                let tags: String = row.get("tags")?;
                push_field_groups(
                    &mut groups,
                    $entity_type,
                    &id,
                    &name,
                    None,
                    &[
                        Field::Text("name", &name),
                        Field::Text("description", &description),
                        Field::Text("notes", &notes),
                        Field::JsonArray("tags", &tags),
                    ],
                    needle,
                );
            }
            Ok(groups)
        }
    };
}

impl_element_grep_scan!(scan_locations, "locations", "location");
impl_element_grep_scan!(scan_items, "items", "item");
impl_element_grep_scan!(scan_lores, "lores", "lore");

/// Events: `start_at` / `end_at` are deliberately NOT searched — timestamps
/// are not creative text (ADR-0035 §2), unlike `search_events` which does
/// match them for entity discovery.
fn scan_events(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<GrepMatchGroup>, DbError> {
    let sql = format!(
        "SELECT id, name, description, notes, tags FROM events
         WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1 OR {}",
        json_array_prefilter("tags")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut groups = Vec::new();
    let mut rows = stmt.query(params![pat])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get("id")?;
        let name: String = row.get("name")?;
        let description: String = row.get("description")?;
        let notes: String = row.get("notes")?;
        let tags: String = row.get("tags")?;
        push_field_groups(
            &mut groups,
            "event",
            &id,
            &name,
            None,
            &[
                Field::Text("name", &name),
                Field::Text("description", &description),
                Field::Text("notes", &notes),
                Field::JsonArray("tags", &tags),
            ],
            needle,
        );
    }
    Ok(groups)
}

/// Novels: `title` (not `name`) + `description` + `author` + `tags`.
fn scan_novels(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<GrepMatchGroup>, DbError> {
    let sql = format!(
        "SELECT id, title, description, author, tags FROM novels
         WHERE title LIKE ?1 OR description LIKE ?1 OR author LIKE ?1 OR {}",
        json_array_prefilter("tags")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut groups = Vec::new();
    let mut rows = stmt.query(params![pat])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get("id")?;
        let title: String = row.get("title")?;
        let description: String = row.get("description")?;
        let author: String = row.get("author")?;
        let tags: String = row.get("tags")?;
        push_field_groups(
            &mut groups,
            "novel",
            &id,
            &title,
            None,
            &[
                Field::Text("title", &title),
                Field::Text("description", &description),
                Field::Text("author", &author),
                Field::JsonArray("tags", &tags),
            ],
            needle,
        );
    }
    Ok(groups)
}

/// Chapters: `title` + `summary` — no tags column on this table.
fn scan_chapters(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<GrepMatchGroup>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, summary FROM chapters WHERE title LIKE ?1 OR summary LIKE ?1",
    )?;
    let mut groups = Vec::new();
    let mut rows = stmt.query(params![pat])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get("id")?;
        let title: String = row.get("title")?;
        let summary: String = row.get("summary")?;
        push_field_groups(
            &mut groups,
            "chapter",
            &id,
            &title,
            None,
            &[
                Field::Text("title", &title),
                Field::Text("summary", &summary),
            ],
            needle,
        );
    }
    Ok(groups)
}

/// Scenes: `content` is the largest creative payload in the schema and the
/// grep corpus's heaviest table — the SQL prefilter matters most here
/// (only surviving rows' content reaches the in-memory scan).
fn scan_scenes(
    conn: &Connection,
    pat: &str,
    needle: &str,
) -> Result<Vec<GrepMatchGroup>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, title, summary, content FROM scenes
         WHERE title LIKE ?1 OR summary LIKE ?1 OR content LIKE ?1",
    )?;
    let mut groups = Vec::new();
    let mut rows = stmt.query(params![pat])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get("id")?;
        let title: String = row.get("title")?;
        let summary: String = row.get("summary")?;
        let content: String = row.get("content")?;
        push_field_groups(
            &mut groups,
            "scene",
            &id,
            &title,
            None,
            &[
                Field::Text("title", &title),
                Field::Text("summary", &summary),
                Field::Text("content", &content),
            ],
            needle,
        );
    }
    Ok(groups)
}

// ─── tests ───────────────────────────────────────────────────────────────────
//
// The prefilter SQL is runtime text — `cargo check` cannot catch a malformed
// `json_each` predicate — so these tests exercise the scan fns against an
// in-memory SQLite, focusing on the JSON-array prefilter invariant
// (ADR-0035 §6: the prefilter must be a superset of the literal scan, which
// raw column `LIKE` breaks for serde-escaped element text).

#[cfg(test)]
#[path = "tests/grep.rs"]
mod tests;
