//! Lightweight world-entity list/search IPC for the agent-chat tool surface.
//!
//! These 16 commands (`list_*_summaries` + `search_*`) sit *alongside* the
//! existing full-field `list_*` commands — they return narrow `*Summary`
//! structs (id / name / tags + a few identity fields) so agent-tool payloads
//! stay small and never leak creative content (descriptions, scene bodies,
//! notes) into the model's context. The UI keeps using the full `list_*`
//! commands; this module is the agent-only fast path.
//!
//! Pagination (`search_*` only, aligned with `commands/grep.rs::paginate`):
//! every search command takes an optional `offset` (omitted → 0, negative →
//! clamped to 0) and returns a [`SearchPage`] — one page of
//! [`DEFAULT_LIMIT`] rows under the unchanged deterministic ORDER BY, the
//! full matching-row `COUNT(*)`, and `truncated = (offset + page_len) <
//! total_count`. The agent walks `offset` 0, 50, 100, … without duplicates
//! or gaps; an offset past the end yields an empty page with
//! `truncated = false`. The `list_*_summaries` commands (recency views,
//! LIMIT 200) remain unpaginated.
//!
//! Logging (ADR-0014 / ADR-0016): list commands skip only `state`;
//! search commands additionally skip `query` (user creative content —
//! must never reach the log file). Entity IDs and `space_id` / `world_id`
//! are metadata and auto-recorded by `#[tracing::instrument]`; `offset`
//! may be auto-recorded (grep precedent).

use rusqlite::{params, Connection, Row};
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::CharacterSummary;
use crate::models::event::EventSummary;
use crate::models::item::ItemSummary;
use crate::models::location::LocationSummary;
use crate::models::lore::LoreSummary;
use crate::models::novel::{ChapterSummary, NovelSummary, SceneSummary};
use crate::models::SearchPage;

/// Page size for `search_*` results. Bounded so a pathologically broad
/// query can't flood the model's context; completeness comes from walking
/// `offset` over the reported `total_count` instead (see [`SearchPage`]).
const DEFAULT_LIMIT: u32 = 50;

/// Wrap a user query in SQL LIKE wildcards. The query itself is never logged.
fn like_pattern(query: &str) -> String {
    format!("%{query}%")
}

/// Shared search-pagination core — `commands/grep.rs::paginate` semantics in
/// SQL form: one COUNT for the full match set, then one page of
/// [`DEFAULT_LIMIT`] rows at `offset`. Negative offsets are clamped to 0
/// BEFORE the SELECT, so [`SearchPage::new`] derives `truncated` from the
/// applied offset. `count_sql` binds `?1` = LIKE pattern; `select_sql`
/// binds `?1` = pattern, `?2` = LIMIT, `?3` = OFFSET. Callers build both
/// statements from ONE shared WHERE clause so COUNT and page can never
/// drift apart.
fn fetch_page<T>(
    conn: &Connection,
    count_sql: &str,
    select_sql: &str,
    pat: &str,
    offset: i64,
    map_row: impl Fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<SearchPage<T>, DbError> {
    let total_count: i64 = conn.query_row(count_sql, params![pat], |row| row.get(0))?;
    let offset = offset.max(0);
    let mut stmt = conn.prepare(select_sql)?;
    let results = stmt
        .query_map(params![pat, DEFAULT_LIMIT as i64, offset], map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SearchPage::new(results, total_count, offset))
}

// ─── Location / Item / Lore (shared shape: id, name, tags) ───────────────────
//
// The three "element" tables share identical SELECT columns and search
// predicates for the summary use case, so we generate both commands per
// table via one macro instantiated 3× — the same pattern as
// `impl_element_image_commands!` in `commands/element.rs`.

macro_rules! impl_element_summary_commands {
    ($table:literal, $fn_list:ident, $fn_search:ident, $do_search:ident, $Summary:ident) => {
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
            offset: Option<i64>,
            state: State<'_, DbManager>,
        ) -> Result<SearchPage<$Summary>, DbError> {
            $do_search(
                &state,
                &space_id,
                &world_id,
                &query,
                offset.unwrap_or(0).max(0),
            )
        }

        /// Testable core of the search command — repo `do_*` convention
        /// (no `State` / Tauri types; tests call this directly).
        pub(crate) fn $do_search(
            mgr: &DbManager,
            space_id: &str,
            world_id: &str,
            query: &str,
            offset: i64,
        ) -> Result<SearchPage<$Summary>, DbError> {
            let pat = like_pattern(query);
            mgr.with_world(space_id, world_id, |conn| {
                // One WHERE clause feeds BOTH statements — the COUNT and
                // the paginated SELECT can never drift apart.
                let where_sql =
                    " WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1 OR tags LIKE ?1";
                let count_sql = format!("SELECT COUNT(*) FROM {}{where_sql}", $table);
                let select_sql = format!(
                    "SELECT id, name, tags FROM {}{where_sql} ORDER BY name LIMIT ?2 OFFSET ?3",
                    $table
                );
                fetch_page(conn, &count_sql, &select_sql, &pat, offset, |row| {
                    let tags_json: String = row.get("tags")?;
                    Ok($Summary {
                        id: row.get("id")?,
                        name: row.get("name")?,
                        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    })
                })
            })
        }
    };
}

impl_element_summary_commands!(
    "locations",
    list_location_summaries,
    search_locations,
    do_search_locations,
    LocationSummary
);
impl_element_summary_commands!(
    "items",
    list_item_summaries,
    search_items,
    do_search_items,
    ItemSummary
);
impl_element_summary_commands!(
    "lores",
    list_lore_summaries,
    search_lores,
    do_search_lores,
    LoreSummary
);

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
        let mut stmt =
            conn.prepare("SELECT id, name, tags FROM characters ORDER BY created_at LIMIT 200")?;
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
    offset: Option<i64>,
    state: State<'_, DbManager>,
) -> Result<SearchPage<CharacterSummary>, DbError> {
    do_search_characters(
        &state,
        &space_id,
        &world_id,
        &query,
        offset.unwrap_or(0).max(0),
    )
}

/// Testable core of `search_characters` — repo `do_*` convention (no `State`
/// / Tauri types; tests call this directly).
pub(crate) fn do_search_characters(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    query: &str,
    offset: i64,
) -> Result<SearchPage<CharacterSummary>, DbError> {
    let pat = like_pattern(query);
    mgr.with_world(space_id, world_id, |conn| {
        let where_sql = " WHERE name LIKE ?1 OR aliases LIKE ?1 OR description LIKE ?1
             OR notes LIKE ?1 OR tags LIKE ?1";
        let count_sql = format!("SELECT COUNT(*) FROM characters{where_sql}");
        let select_sql = format!(
            "SELECT id, name, tags FROM characters{where_sql}
             ORDER BY name LIMIT ?2 OFFSET ?3"
        );
        fetch_page(conn, &count_sql, &select_sql, &pat, offset, |row| {
            let tags_json: String = row.get("tags")?;
            Ok(CharacterSummary {
                id: row.get("id")?,
                name: row.get("name")?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            })
        })
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
    offset: Option<i64>,
    state: State<'_, DbManager>,
) -> Result<SearchPage<EventSummary>, DbError> {
    do_search_events(
        &state,
        &space_id,
        &world_id,
        &query,
        offset.unwrap_or(0).max(0),
    )
}

/// Testable core of `search_events` — repo `do_*` convention (no `State` /
/// Tauri types; tests call this directly).
pub(crate) fn do_search_events(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    query: &str,
    offset: i64,
) -> Result<SearchPage<EventSummary>, DbError> {
    let pat = like_pattern(query);
    mgr.with_world(space_id, world_id, |conn| {
        let where_sql = " WHERE name LIKE ?1 OR description LIKE ?1 OR notes LIKE ?1
             OR tags LIKE ?1 OR start_at LIKE ?1 OR end_at LIKE ?1";
        let count_sql = format!("SELECT COUNT(*) FROM events{where_sql}");
        let select_sql = format!(
            "SELECT id, name, tags, start_at, end_at FROM events{where_sql}
             ORDER BY name LIMIT ?2 OFFSET ?3"
        );
        fetch_page(conn, &count_sql, &select_sql, &pat, offset, |row| {
            let tags_json: String = row.get("tags")?;
            Ok(EventSummary {
                id: row.get("id")?,
                name: row.get("name")?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                start_at: row.get("start_at")?,
                end_at: row.get("end_at")?,
            })
        })
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
        let mut stmt = conn
            .prepare("SELECT id, title, tags, author FROM novels ORDER BY created_at LIMIT 200")?;
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
    offset: Option<i64>,
    state: State<'_, DbManager>,
) -> Result<SearchPage<NovelSummary>, DbError> {
    do_search_novels(
        &state,
        &space_id,
        &world_id,
        &query,
        offset.unwrap_or(0).max(0),
    )
}

/// Testable core of `search_novels` — repo `do_*` convention (no `State` /
/// Tauri types; tests call this directly).
pub(crate) fn do_search_novels(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    query: &str,
    offset: i64,
) -> Result<SearchPage<NovelSummary>, DbError> {
    let pat = like_pattern(query);
    mgr.with_world(space_id, world_id, |conn| {
        let where_sql =
            " WHERE title LIKE ?1 OR description LIKE ?1 OR author LIKE ?1 OR tags LIKE ?1";
        let count_sql = format!("SELECT COUNT(*) FROM novels{where_sql}");
        let select_sql = format!(
            "SELECT id, title, tags, author FROM novels{where_sql}
             ORDER BY title LIMIT ?2 OFFSET ?3"
        );
        fetch_page(conn, &count_sql, &select_sql, &pat, offset, |row| {
            let tags_json: String = row.get("tags")?;
            Ok(NovelSummary {
                id: row.get("id")?,
                title: row.get("title")?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                author: row.get("author")?,
            })
        })
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
    offset: Option<i64>,
    state: State<'_, DbManager>,
) -> Result<SearchPage<ChapterSummary>, DbError> {
    do_search_chapters(
        &state,
        &space_id,
        &world_id,
        &query,
        offset.unwrap_or(0).max(0),
    )
}

/// Testable core of `search_chapters` — repo `do_*` convention (no `State` /
/// Tauri types; tests call this directly).
pub(crate) fn do_search_chapters(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    query: &str,
    offset: i64,
) -> Result<SearchPage<ChapterSummary>, DbError> {
    let pat = like_pattern(query);
    mgr.with_world(space_id, world_id, |conn| {
        let where_sql = " WHERE title LIKE ?1 OR summary LIKE ?1";
        let count_sql = format!("SELECT COUNT(*) FROM chapters{where_sql}");
        let select_sql = format!(
            "SELECT id, title FROM chapters{where_sql}
             ORDER BY title LIMIT ?2 OFFSET ?3"
        );
        fetch_page(conn, &count_sql, &select_sql, &pat, offset, |row| {
            Ok(ChapterSummary {
                id: row.get("id")?,
                title: row.get("title")?,
            })
        })
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
    offset: Option<i64>,
    state: State<'_, DbManager>,
) -> Result<SearchPage<SceneSummary>, DbError> {
    do_search_scenes(
        &state,
        &space_id,
        &world_id,
        &query,
        offset.unwrap_or(0).max(0),
    )
}

/// Testable core of `search_scenes` — repo `do_*` convention (no `State` /
/// Tauri types; tests call this directly).
pub(crate) fn do_search_scenes(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    query: &str,
    offset: i64,
) -> Result<SearchPage<SceneSummary>, DbError> {
    let pat = like_pattern(query);
    mgr.with_world(space_id, world_id, |conn| {
        let where_sql = " WHERE title LIKE ?1 OR summary LIKE ?1 OR content LIKE ?1
             OR start_at LIKE ?1 OR end_at LIKE ?1";
        let count_sql = format!("SELECT COUNT(*) FROM scenes{where_sql}");
        let select_sql = format!(
            "SELECT id, title FROM scenes{where_sql}
             ORDER BY title LIMIT ?2 OFFSET ?3"
        );
        fetch_page(conn, &count_sql, &select_sql, &pat, offset, |row| {
            Ok(SceneSummary {
                id: row.get("id")?,
                title: row.get("title")?,
            })
        })
    })
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "tests/world_search.rs"]
mod tests;
