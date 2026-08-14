//! Timeline — derived chronological projection of a World's Events and Scenes
//! (ADR-0033).
//!
//! Pure read-only aggregation: no dedicated table, no persistence, no
//! authoring. The single `query_timeline` command serves both the Timeline UI
//! route and the `timeline_lookup` agent tool via the same response shape
//! (the contract).
//!
//! Per ADR-0033, every Event and Scene is returned at its own `start_at` —
//! the UI's visual "absorption" rule is intentionally NOT applied here
//! (chronological truth over visual de-duplication).
//!
//! Logging (ADR-0014 / ADR-0016): `state` + `input` are skipped (input may
//! carry creative content / filter values); `space_id` / `world_id` are
//! metadata and recorded as fields. Only counts are logged at the end.

use std::collections::HashMap;

use rusqlite::params_from_iter;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::timeline::{TimelineEntry, TimelineLane, TimelineQueryInput, TimelineResponse};

/// Default result ceiling. The agent tool + UI rarely need more, but the
/// clamp keeps a pathologically large request bounded.
const DEFAULT_LIMIT: i64 = 50;
const MIN_LIMIT: i64 = 1;
const MAX_LIMIT: i64 = 100;

/// Run a `SELECT <key>, <name> ... WHERE <key> IN (...)` query and group the
/// `(key, name)` pairs into a `HashMap<String, Vec<String>>`. Used to
/// batch-resolve participants and cross-reference NAMES for a set of entry
/// ids, avoiding N+1 queries. `sql_prefix` must end immediately before the
/// ` IN (...)` clause (e.g. `"SELECT DISTINCT ecr.event_id, c.name FROM ... \
/// JOIN characters c ON c.id = ecr.character_id WHERE ecr.event_id"`).
fn group_names_by_key(
    conn: &rusqlite::Connection,
    sql_prefix: &str,
    ids: &[String],
) -> Result<HashMap<String, Vec<String>>, DbError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (1..=ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("{sql_prefix} IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(ids.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for r in rows {
        let (key, name) = r?;
        map.entry(key).or_default().push(name);
    }
    Ok(map)
}

/// One flat, time-ordered list of Event + Scene entries for a World
/// (ADR-0033).
///
/// Implemented inside a single `with_world` closure. Filters (`from`/`to`/
/// `location_id`/`character_id`/`novel_id`) are applied per-source via
/// dynamic WHERE clauses; `start_at` range uses ISO 8601 string comparison
/// (lexicographically sortable). Participants, location names, description
/// excerpts, and cross-references (`scene_event_refs`) are batch-resolved
/// after the main fetch, then the union is sorted (`start_at` ASC NULLS LAST)
/// and truncated to `limit`.
#[tracing::instrument(skip(state, input), fields(space_id, world_id))]
#[tauri::command]
pub fn query_timeline(
    space_id: String,
    world_id: String,
    input: TimelineQueryInput,
    state: State<'_, DbManager>,
) -> Result<TimelineResponse, DbError> {
    let limit = input.limit.unwrap_or(DEFAULT_LIMIT).clamp(MIN_LIMIT, MAX_LIMIT);

    state.with_world(&space_id, &world_id, |conn| {
        // ── (1) EVENTS subset ──────────────────────────────────────────────
        struct EventRow {
            id: String,
            name: String,
            start_at: Option<String>,
            end_at: Option<String>,
            location_name: Option<String>,
            excerpt: Option<String>,
        }

        let mut event_sql = String::from(
            "SELECT e.id, e.name, e.start_at, e.end_at,
                    loc.name AS location_name,
                    SUBSTR(e.description, 1, 200) AS excerpt
             FROM events e
             LEFT JOIN locations loc ON loc.id = e.location_id
             WHERE 1=1",
        );
        let mut event_params: Vec<String> = Vec::new();
        if let Some(ref v) = input.from {
            event_sql.push_str(" AND e.start_at >= ?");
            event_params.push(v.clone());
        }
        if let Some(ref v) = input.to {
            event_sql.push_str(" AND e.start_at < ?");
            event_params.push(v.clone());
        }
        if let Some(ref v) = input.location_id {
            event_sql.push_str(" AND e.location_id = ?");
            event_params.push(v.clone());
        }
        if let Some(ref v) = input.character_id {
            event_sql.push_str(
                " AND EXISTS (SELECT 1 FROM event_character_refs ecr \
                 WHERE ecr.event_id = e.id AND ecr.character_id = ?)",
            );
            event_params.push(v.clone());
        }

        // NOTE: `event_stmt` is declared at closure scope (not in a sub-block)
        // so the `MappedRows` borrow outlives `.collect()` — putting the
        // collect as a block tail trips E0597 (the `?` temporary's drop order).
        // This matches the established pattern in `commands/novel.rs`.
        let mut event_stmt = conn.prepare(&event_sql)?;
        let event_rows: Vec<EventRow> = event_stmt
            .query_map(params_from_iter(event_params.iter()), |row| {
                let excerpt: Option<String> = row.get("excerpt")?;
                Ok(EventRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    start_at: row.get("start_at")?,
                    end_at: row.get("end_at")?,
                    location_name: row.get("location_name")?,
                    excerpt: excerpt.filter(|s| !s.is_empty()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // ── (2) SCENES subset (optional) ───────────────────────────────────
        struct SceneRow {
            id: String,
            name: String,
            start_at: Option<String>,
            end_at: Option<String>,
            location_name: Option<String>,
            excerpt: Option<String>,
            novel_title: String,
            novel_id: String,
            chapter_id: String,
        }

        let scene_rows: Vec<SceneRow> = if input.include_scenes {
            let mut scene_sql = String::from(
                "SELECT s.id, s.title AS name, s.start_at, s.end_at,
                        loc.name AS location_name,
                        SUBSTR(s.summary, 1, 200) AS excerpt,
                        n.title AS novel_title,
                        ch.novel_id AS novel_id,
                        s.chapter_id AS chapter_id
                 FROM scenes s
                 JOIN chapters ch ON ch.id = s.chapter_id
                 JOIN novels n ON n.id = ch.novel_id
                 LEFT JOIN locations loc ON loc.id = s.location_id
                 WHERE 1=1",
            );
            let mut scene_params: Vec<String> = Vec::new();
            if let Some(ref v) = input.from {
                scene_sql.push_str(" AND s.start_at >= ?");
                scene_params.push(v.clone());
            }
            if let Some(ref v) = input.to {
                scene_sql.push_str(" AND s.start_at < ?");
                scene_params.push(v.clone());
            }
            if let Some(ref v) = input.location_id {
                scene_sql.push_str(" AND s.location_id = ?");
                scene_params.push(v.clone());
            }
            if let Some(ref v) = input.character_id {
                scene_sql.push_str(
                    " AND EXISTS (SELECT 1 FROM scene_character_refs scr \
                     WHERE scr.scene_id = s.id AND scr.character_id = ?)",
                );
                scene_params.push(v.clone());
            }
            if let Some(ref v) = input.novel_id {
                scene_sql.push_str(" AND ch.novel_id = ?");
                scene_params.push(v.clone());
            }
            if let Some(ref v) = input.item_id {
                // Scenes-only: events have no items per the domain model
                // (CONTEXT.md), so this filter is never applied to the events
                // subset. Junction: `scene_item_refs (scene_id, item_id)`.
                scene_sql.push_str(
                    " AND EXISTS (SELECT 1 FROM scene_item_refs sir \
                     WHERE sir.scene_id = s.id AND sir.item_id = ?)",
                );
                scene_params.push(v.clone());
            }

            // Bind the collected Vec to a named local (`rows`) rather than
            // making `.collect()?` the branch tail — same E0597 avoidance as
            // the events query above (the `?` temporary must drop before
            // `scene_stmt`).
            let mut scene_stmt = conn.prepare(&scene_sql)?;
            let rows = scene_stmt
                .query_map(params_from_iter(scene_params.iter()), |row| {
                    let excerpt: Option<String> = row.get("excerpt")?;
                    Ok(SceneRow {
                        id: row.get("id")?,
                        name: row.get("name")?,
                        start_at: row.get("start_at")?,
                        end_at: row.get("end_at")?,
                        location_name: row.get("location_name")?,
                        excerpt: excerpt.filter(|s| !s.is_empty()),
                        novel_title: row.get("novel_title")?,
                        novel_id: row.get("novel_id")?,
                        chapter_id: row.get("chapter_id")?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        } else {
            Vec::new()
        };

        // ── (3) Batch-resolve NAMES: participants + cross-refs ─────────────
        // DISTINCT collapses a character appearing via multiple phases; the
        // `scene_event_refs` junction has a composite PK so no dup pairs there.
        let event_ids: Vec<String> = event_rows.iter().map(|r| r.id.clone()).collect();
        let scene_ids: Vec<String> = scene_rows.iter().map(|r| r.id.clone()).collect();

        let mut event_participants = group_names_by_key(
            conn,
            "SELECT DISTINCT ecr.event_id, c.name \
             FROM event_character_refs ecr \
             JOIN characters c ON c.id = ecr.character_id \
             WHERE ecr.event_id",
            &event_ids,
        )?;
        let mut scene_participants = group_names_by_key(
            conn,
            "SELECT DISTINCT scr.scene_id, c.name \
             FROM scene_character_refs scr \
             JOIN characters c ON c.id = scr.character_id \
             WHERE scr.scene_id",
            &scene_ids,
        )?;
        // Events → scenes that narrate them.
        let mut event_narrated_by = group_names_by_key(
            conn,
            "SELECT DISTINCT ser.event_id, s.title \
             FROM scene_event_refs ser \
             JOIN scenes s ON s.id = ser.scene_id \
             WHERE ser.event_id",
            &event_ids,
        )?;
        // Scenes → events they narrate.
        let mut scene_narrates = group_names_by_key(
            conn,
            "SELECT DISTINCT ser.scene_id, e.name \
             FROM scene_event_refs ser \
             JOIN events e ON e.id = ser.event_id \
             WHERE ser.scene_id",
            &scene_ids,
        )?;

        // ── (4) Assemble entries ───────────────────────────────────────────
        let mut entries: Vec<TimelineEntry> =
            Vec::with_capacity(event_rows.len() + scene_rows.len());

        for r in event_rows {
            // `.remove()` (not `.get().cloned()`) — each id appears once, so
            // this avoids an extra clone per row.
            let participants = event_participants.remove(&r.id).unwrap_or_default();
            let narrated_by = event_narrated_by.remove(&r.id).unwrap_or_default();
            entries.push(TimelineEntry {
                kind: "event".to_string(),
                id: r.id,
                name: r.name,
                start_at: r.start_at,
                end_at: r.end_at,
                location_name: r.location_name,
                participants,
                description_excerpt: r.excerpt,
                narrated_by_scene_names: Some(narrated_by),
                narrated_event_names: None,
                novel_title: None,
                novel_id: None,
                chapter_id: None,
            });
        }
        for r in scene_rows {
            let participants = scene_participants.remove(&r.id).unwrap_or_default();
            let narrates = scene_narrates.remove(&r.id).unwrap_or_default();
            entries.push(TimelineEntry {
                kind: "scene".to_string(),
                id: r.id,
                name: r.name,
                start_at: r.start_at,
                end_at: r.end_at,
                location_name: r.location_name,
                participants,
                description_excerpt: r.excerpt,
                narrated_by_scene_names: None,
                narrated_event_names: Some(narrates),
                novel_title: Some(r.novel_title),
                novel_id: Some(r.novel_id),
                chapter_id: Some(r.chapter_id),
            });
        }

        // ── (5) Sort ascending by start_at, NULLS LAST ─────────────────────
        entries.sort_by(|a, b| match (&a.start_at, &b.start_at) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });

        // ── (6) total (before limit) → truncate → truncated ────────────────
        let total = entries.len() as i64;
        entries.truncate(limit as usize);
        let truncated = (total as usize) > entries.len();

        tracing::debug!(
            entries = entries.len(),
            total = total,
            "timeline queried"
        );

        Ok(TimelineResponse {
            entries,
            total,
            truncated,
        })
    })
}

/// List every Character in the World with a Timeline participation count —
/// the number of DISTINCT Events (via `event_character_refs`) plus DISTINCT
/// Scenes (via `scene_character_refs`) they appear in. A character appearing
/// in one Event via two phases counts as 1 (the per-source subqueries are
/// `DISTINCT`).
///
/// Companion to `query_timeline`: drives the UI's default lane set (lanes
/// with `participation_count > 2` are auto-shown) and the character
/// multiselect. UI-only — the agent tool surface does not consume lanes.
///
/// Characters with zero participation are EXCLUDED (INNER JOIN on the union
/// of refs): they'd never satisfy the `> 2` default and would only clutter
/// the multiselect. Results are sorted by `participation_count` DESC, then
/// `name` ASC for a stable, scannable order.
#[tracing::instrument(skip(state), fields(space_id, world_id))]
#[tauri::command]
pub fn list_timeline_lanes(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<TimelineLane>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        // Per-source DISTINCT collapses the phase dimension: a character in
        // one event/scene via N phases contributes 1, not N. UNION ALL (not
        // UNION) preserves both source sets — event_id and scene_id live in
        // disjoint ID spaces, so cross-source dedup would be a no-op anyway
        // and ALL keeps the intent explicit. The INNER JOIN on `characters`
        // naturally drops zero-participation characters (they have no rows
        // in the union).
        let mut stmt = conn.prepare(
            "SELECT c.id AS character_id, c.name AS name, COUNT(*) AS participation_count
             FROM (
                 SELECT DISTINCT character_id, event_id FROM event_character_refs
                 UNION ALL
                 SELECT DISTINCT character_id, scene_id FROM scene_character_refs
             ) u
             JOIN characters c ON c.id = u.character_id
             GROUP BY c.id, c.name
             ORDER BY participation_count DESC, c.name ASC",
        )?;
        let lanes = stmt
            .query_map([], |row| {
                Ok(TimelineLane {
                    character_id: row.get("character_id")?,
                    name: row.get("name")?,
                    participation_count: row.get("participation_count")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        tracing::debug!(
            lane_count = lanes.len(),
            "timeline lanes listed"
        );

        Ok(lanes)
    })
}
