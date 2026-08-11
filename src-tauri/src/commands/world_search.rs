//! Lightweight world-entity list/search IPC for the agent-chat tool surface.
//!
//! These 16 commands (`list_*_summaries` + `search_*`) sit *alongside* the
//! existing full-field `list_*` commands — they return narrow `*Summary`
//! structs (id / name / tags + a few identity fields) so agent-tool payloads
//! stay small and never leak creative content (descriptions, scene bodies,
//! notes) into the model's context. The UI keeps using the full `list_*`
//! commands; this module is the agent-only fast path.
//!
//! Logging (ADR-0014 / ADR-0016): list commands skip only `state`;
//! search commands additionally skip `query` (user creative content —
//! must never reach the log file). Entity IDs and `space_id` / `world_id`
//! are metadata and auto-recorded by `#[tracing::instrument]`.

use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::CharacterSummary;
use crate::models::event::EventSummary;
use crate::models::item::ItemSummary;
use crate::models::location::LocationSummary;
use crate::models::lore::LoreSummary;
use crate::models::novel::{ChapterSummary, NovelSummary, SceneSummary};

/// Soft ceiling on search result rows. Kept generous so the agent rarely
/// needs to paginate, but bounded so a pathologically broad query can't
/// flood the model's context.
const DEFAULT_LIMIT: u32 = 50;

/// Wrap a user query in SQL LIKE wildcards. The query itself is never logged.
fn like_pattern(query: &str) -> String {
    format!("%{query}%")
}

// ─── Location / Item / Lore (shared shape: id, name, tags) ───────────────────
//
// The three "element" tables share identical SELECT columns and search
// predicates for the summary use case, so we generate both commands per
// table via one macro instantiated 3× — the same pattern as
// `impl_element_image_commands!` in `commands/element.rs`.

macro_rules! impl_element_summary_commands {
    ($table:literal, $fn_list:ident, $fn_search:ident, $Summary:ident) => {
        #[tracing::instrument(skip(state))]
        #[tauri::command]
        pub fn $fn_list(
            space_id: String,
            world_id: String,
            state: State<'_, DbManager>,
        ) -> Result<Vec<$Summary>, DbError> {
            state.with_world(&space_id, &world_id, |conn| {
                let mut stmt = conn.prepare(concat!(
                    "SELECT id, name, tags FROM ",
                    $table,
                    " ORDER BY created_at LIMIT 200"
                ))?;
                let rows = stmt
                    .query_map([], |row| {
                        let tags_json: String = row.get("tags")?;
                        Ok($Summary {
                            id: row.get("id")?,
                            name: row.get("name")?,
                            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
        }

        #[tracing::instrument(skip(state, query))]
        #[tauri::command]
        pub fn $fn_search(
            space_id: String,
            world_id: String,
            query: String,
            state: State<'_, DbManager>,
        ) -> Result<Vec<$Summary>, DbError> {
            let pat = like_pattern(&query);
            state.with_world(&space_id, &world_id, |conn| {
                let mut stmt = conn.prepare(concat!(
                    "SELECT id, name, tags FROM ",
                    $table,
                    " WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1 OR tags LIKE ?1",
                    " ORDER BY name LIMIT ?2"
                ))?;
                let rows = stmt
                    .query_map(params![&pat, DEFAULT_LIMIT as i64], |row| {
                        let tags_json: String = row.get("tags")?;
                        Ok($Summary {
                            id: row.get("id")?,
                            name: row.get("name")?,
                            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
        }
    };
}

impl_element_summary_commands!(
    "locations",
    list_location_summaries,
    search_locations,
    LocationSummary
);
impl_element_summary_commands!("items", list_item_summaries, search_items, ItemSummary);
impl_element_summary_commands!("lores", list_lore_summaries, search_lores, LoreSummary);

// ─── Character ───────────────────────────────────────────────────────────────
//
// Characters have an `aliases` column (JSON array) that Locations/Items/Lores
// lack, so the search predicate gains an extra `aliases LIKE ?1` term.

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_character_summaries(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<CharacterSummary>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, tags FROM characters ORDER BY created_at LIMIT 200",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let tags_json: String = row.get("tags")?;
                Ok(CharacterSummary {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, query))]
#[tauri::command]
pub fn search_characters(
    space_id: String,
    world_id: String,
    query: String,
    state: State<'_, DbManager>,
) -> Result<Vec<CharacterSummary>, DbError> {
    let pat = like_pattern(&query);
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, tags FROM characters
             WHERE name LIKE ?1 OR aliases LIKE ?1 OR description LIKE ?1
                OR notes LIKE ?1 OR tags LIKE ?1
             ORDER BY name LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![&pat, DEFAULT_LIMIT as i64], |row| {
                let tags_json: String = row.get("tags")?;
                Ok(CharacterSummary {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ─── Event ───────────────────────────────────────────────────────────────────
//
// EventSummary carries the nullable time window (`start_at` / `end_at`) since
// temporal placement is the primary axis agents disambiguate events on.

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_event_summaries(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<EventSummary>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, tags, start_at, end_at FROM events ORDER BY created_at LIMIT 200",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let tags_json: String = row.get("tags")?;
                Ok(EventSummary {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    start_at: row.get("start_at")?,
                    end_at: row.get("end_at")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, query))]
#[tauri::command]
pub fn search_events(
    space_id: String,
    world_id: String,
    query: String,
    state: State<'_, DbManager>,
) -> Result<Vec<EventSummary>, DbError> {
    let pat = like_pattern(&query);
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, tags, start_at, end_at FROM events
             WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1
                OR tags LIKE ?1 OR start_at LIKE ?1 OR end_at LIKE ?1
             ORDER BY name LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![&pat, DEFAULT_LIMIT as i64], |row| {
                let tags_json: String = row.get("tags")?;
                Ok(EventSummary {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    start_at: row.get("start_at")?,
                    end_at: row.get("end_at")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ─── Novel ───────────────────────────────────────────────────────────────────
//
// NovelSummary uses `title` (not `name`) and adds `author`. Novels also have a
// `description` column (WORLD_MIGRATION_002) used only in the search predicate.

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_novel_summaries(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<NovelSummary>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, tags, author FROM novels ORDER BY created_at LIMIT 200",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let tags_json: String = row.get("tags")?;
                Ok(NovelSummary {
                    id: row.get("id")?,
                    title: row.get("title")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    author: row.get("author")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, query))]
#[tauri::command]
pub fn search_novels(
    space_id: String,
    world_id: String,
    query: String,
    state: State<'_, DbManager>,
) -> Result<Vec<NovelSummary>, DbError> {
    let pat = like_pattern(&query);
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, tags, author FROM novels
             WHERE title LIKE ?1 OR description LIKE ?1 OR author LIKE ?1 OR tags LIKE ?1
             ORDER BY title LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![&pat, DEFAULT_LIMIT as i64], |row| {
                let tags_json: String = row.get("tags")?;
                Ok(NovelSummary {
                    id: row.get("id")?,
                    title: row.get("title")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    author: row.get("author")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ─── Chapter ─────────────────────────────────────────────────────────────────
//
// ChapterSummary is the narrowest shape (id + title only — no tags). List is
// scoped to a novel; search is global across the World.

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_chapter_summaries(
    space_id: String,
    world_id: String,
    novel_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<ChapterSummary>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM chapters WHERE novel_id = ?1 ORDER BY position LIMIT 200",
        )?;
        let rows = stmt
            .query_map(params![&novel_id], |row| {
                Ok(ChapterSummary {
                    id: row.get("id")?,
                    title: row.get("title")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, query))]
#[tauri::command]
pub fn search_chapters(
    space_id: String,
    world_id: String,
    query: String,
    state: State<'_, DbManager>,
) -> Result<Vec<ChapterSummary>, DbError> {
    let pat = like_pattern(&query);
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM chapters
             WHERE title LIKE ?1 OR summary LIKE ?1
             ORDER BY title LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![&pat, DEFAULT_LIMIT as i64], |row| {
                Ok(ChapterSummary {
                    id: row.get("id")?,
                    title: row.get("title")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ─── Scene ───────────────────────────────────────────────────────────────────
//
// SceneSummary mirrors ChapterSummary (id + title). Scene `content` is the
// largest creative payload in the schema — it appears ONLY in the search
// predicate (to match), never in the returned Summary.

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_scene_summaries(
    space_id: String,
    world_id: String,
    chapter_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<SceneSummary>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM scenes WHERE chapter_id = ?1 ORDER BY position LIMIT 200",
        )?;
        let rows = stmt
            .query_map(params![&chapter_id], |row| {
                Ok(SceneSummary {
                    id: row.get("id")?,
                    title: row.get("title")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, query))]
#[tauri::command]
pub fn search_scenes(
    space_id: String,
    world_id: String,
    query: String,
    state: State<'_, DbManager>,
) -> Result<Vec<SceneSummary>, DbError> {
    let pat = like_pattern(&query);
    state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM scenes
             WHERE title LIKE ?1 OR summary LIKE ?1 OR content LIKE ?1
                OR start_at LIKE ?1 OR end_at LIKE ?1
             ORDER BY title LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![&pat, DEFAULT_LIMIT as i64], |row| {
                Ok(SceneSummary {
                    id: row.get("id")?,
                    title: row.get("title")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}
