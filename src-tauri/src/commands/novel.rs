use rusqlite::params;
use std::collections::HashMap;
use tauri::{AppHandle, State};

use crate::commands::events::emit_entity_changed;
use crate::db::{DbError, DbManager};
use crate::models::character::CharacterRef;
use crate::models::novel::{
    Chapter, ChapterOverview, CreateChapterInput, CreateNovelInput, CreateSceneInput, Novel,
    Scene, SceneImageMeta, SceneOverview, UpdateChapterInput, UpdateNovelInput, UpdateSceneInput,
};
use crate::util::{decode_and_validate_image, new_id, normalize_iso, now_iso};

/// Correlated scalar subquery computing a novel's `word_count`: the
/// non-whitespace character count summed over all scene contents, computed
/// per query (read-only, no stored counter). Shared by `load_novel` and
/// `list_novels` — if the definition ever changes, it must change in both,
/// so both SELECTs splice this single const.
///
/// Near-parity with the frontend's `src/lib/word-count.ts`
/// (`content.replace(/\s/g, "").length`): strips the 6 practically-relevant
/// whitespace codepoints (space, tab, LF, CR, U+3000 ideographic space,
/// U+00A0 nbsp); exotic Unicode whitespace (U+2000–U+200A etc.) is
/// deliberately not stripped.
///
/// Known divergence: JS `.length` counts UTF-16 code units while SQLite
/// `LENGTH()` counts code points (`LENGTH(TEXT)` counts characters, not
/// bytes), so astral-plane characters (CJK Extension B U+20000–U+2FFFF,
/// plausible in historical Chinese names; also emoji) count as 2 in
/// per-scene frontend counts but 1 here.
const WORD_COUNT_SQL: &str = "(SELECT COALESCE(SUM(LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(s.content, ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), CHAR(0x3000), ''), CHAR(0xA0), ''))), 0) FROM scenes s JOIN chapters c ON s.chapter_id = c.id WHERE c.novel_id = novels.id) AS word_count";

// ─── helpers ────────────────────────────────────────────────────────────────

fn load_novel(conn: &rusqlite::Connection, id: &str, world_id: &str) -> Result<Novel, DbError> {
    let (title, description, author, tags_json, created_at, updated_at, has_image, word_count) =
        conn.query_row(
            // word_count: see WORD_COUNT_SQL
            &format!(
                "SELECT title, description, author, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image, {WORD_COUNT_SQL} FROM novels WHERE id = ?1"
            ),
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>("title")?,
                    row.get::<_, String>("description")?,
                    row.get::<_, String>("author")?,
                    row.get::<_, String>("tags")?,
                    row.get::<_, String>("created_at")?,
                    row.get::<_, String>("updated_at")?,
                    row.get::<_, bool>("has_image")?,
                    row.get::<_, i64>("word_count")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Novel", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    let chapter_ids: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT id FROM chapters WHERE novel_id = ?1 ORDER BY position")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(Novel {
        id: id.to_string(),
        world_id: world_id.to_string(),
        title,
        description,
        author,
        chapter_ids,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        created_at,
        updated_at,
        has_image,
        word_count,
    })
}

fn load_chapter(conn: &rusqlite::Connection, id: &str) -> Result<Chapter, DbError> {
    let (novel_id, title, summary, created_at, updated_at) = conn
        .query_row(
            "SELECT novel_id, title, summary, created_at, updated_at FROM chapters WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>("novel_id")?,
                    row.get::<_, String>("title")?,
                    row.get::<_, String>("summary")?,
                    row.get::<_, String>("created_at")?,
                    row.get::<_, String>("updated_at")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Chapter", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    let scene_ids: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT id FROM scenes WHERE chapter_id = ?1 ORDER BY position")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(Chapter {
        id: id.to_string(),
        novel_id,
        title,
        summary,
        scene_ids,
        created_at,
        updated_at,
    })
}

fn load_scene(conn: &rusqlite::Connection, id: &str) -> Result<Scene, DbError> {
    let (
        chapter_id,
        title,
        summary,
        content,
        start_at,
        end_at,
        location_id,
        created_at,
        updated_at,
    ) = conn
        .query_row(
            "SELECT chapter_id, title, summary, content, start_at, end_at, location_id, created_at, updated_at
             FROM scenes WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>("chapter_id")?,
                    row.get::<_, String>("title")?,
                    row.get::<_, String>("summary")?,
                    row.get::<_, String>("content")?,
                    row.get::<_, Option<String>>("start_at")?,
                    row.get::<_, Option<String>>("end_at")?,
                    row.get::<_, Option<String>>("location_id")?,
                    row.get::<_, String>("created_at")?,
                    row.get::<_, String>("updated_at")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Scene", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    let character_refs: Vec<CharacterRef> = {
        let mut stmt = conn.prepare(
            "SELECT character_id, phase_id FROM scene_character_refs WHERE scene_id = ?1",
        )?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(CharacterRef {
                character_id: row.get(0)?,
                phase_id: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let item_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT item_id FROM scene_item_refs WHERE scene_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let event_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT event_id FROM scene_event_refs WHERE scene_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let lore_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT lore_id FROM scene_lore_refs WHERE scene_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(Scene {
        id: id.to_string(),
        chapter_id,
        title,
        summary,
        content,
        start_at,
        end_at,
        character_refs,
        location_id,
        item_ids,
        event_ids,
        lore_ids,
        created_at,
        updated_at,
    })
}

// ─── Novel CRUD ────────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_novel(
    space_id: String,
    world_id: String,
    input: CreateNovelInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Novel, DbError> {
    let novel = do_create_novel(&state, &space_id, &world_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", novel.id.as_str());
    Ok(novel)
}

/// Testable core of [`create_novel`]: takes `&DbManager` + `Option<&AppHandle>`
/// so integration tests bypass `State<'_, _>` / the Tauri runtime (this crate
/// has no mock runtime — see `commands/space.rs::do_delete_space` for the
/// pattern). Event emission runs only `if let Some(app)`.
pub(crate) fn do_create_novel(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    input: &CreateNovelInput,
    app: Option<&AppHandle>,
) -> Result<Novel, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        conn.execute(
            "INSERT INTO novels (id, title, description, author, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.title, input.description, input.author, tags_json, now, now],
        )?;
        load_novel(conn, &id, world_id)
    });
    if let (Ok(ref entity), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "novel",
            Some(entity.id.clone()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_novel(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Novel, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_novel(conn, &id, &world_id)
    })
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_novels(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Novel>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        // (a) Batch-load ALL novel rows (raw fields, no chapter IDs yet).
        // `word_count` on NovelRaw mirrors `has_image`: a computed column
        // from a correlated scalar subquery — see WORD_COUNT_SQL.
        struct NovelRaw {
            id: String,
            title: String,
            description: String,
            author: String,
            tags_json: String,
            created_at: String,
            updated_at: String,
            has_image: bool,
            word_count: i64,
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT id, title, description, author, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image, {WORD_COUNT_SQL} FROM novels ORDER BY created_at"
        ))?;
        let raws: Vec<NovelRaw> = stmt
            .query_map([], |row| {
                Ok(NovelRaw {
                    id: row.get("id")?,
                    title: row.get("title")?,
                    description: row.get("description")?,
                    author: row.get("author")?,
                    tags_json: row.get("tags")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    has_image: row.get("has_image")?,
                    word_count: row.get("word_count")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        if raws.is_empty() {
            return Ok(Vec::new());
        }

        // (b) Batch-load ALL chapter IDs for these novels in one query.
        let ids: Vec<String> = raws.iter().map(|r| r.id.clone()).collect();
        let placeholders = (1..=ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
        "SELECT novel_id, id FROM chapters WHERE novel_id IN ({placeholders}) ORDER BY position"
    );
        let mut ch_stmt = conn.prepare(&sql)?;
        let all_chapters: Vec<(String, String)> = ch_stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((
                    row.get::<_, String>("novel_id")?,
                    row.get::<_, String>("id")?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // (c) Group chapter IDs by novel_id.
        let mut ch_map: HashMap<String, Vec<String>> = HashMap::new();
        for (novel_id, ch_id) in all_chapters {
            ch_map.entry(novel_id).or_default().push(ch_id);
        }

        // (d) Assemble results.
        let result: Vec<Novel> = raws
            .into_iter()
            .map(|raw| {
                let chapter_ids = ch_map.remove(&raw.id).unwrap_or_default();
                let tags: Vec<String> = serde_json::from_str(&raw.tags_json).unwrap_or_default();
                Novel {
                    id: raw.id,
                    world_id: world_id.to_string(),
                    title: raw.title,
                    description: raw.description,
                    author: raw.author,
                    chapter_ids,
                    tags,
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                    has_image: raw.has_image,
                    word_count: raw.word_count,
                }
            })
            .collect();

        Ok(result)
    })
}

/// Batch-load all chapters of a novel (with scene IDs), avoiding N+1.
#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_chapters(
    space_id: String,
    world_id: String,
    novel_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Chapter>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        // (a) Batch-load ALL chapter rows for this novel.
        struct ChapterRaw {
            id: String,
            title: String,
            summary: String,
            created_at: String,
            updated_at: String,
        }
        let mut stmt = conn.prepare(
            "SELECT id, title, summary, created_at, updated_at
         FROM chapters WHERE novel_id = ?1 ORDER BY position",
        )?;
        let raws: Vec<ChapterRaw> = stmt
            .query_map(params![&novel_id], |row| {
                Ok(ChapterRaw {
                    id: row.get("id")?,
                    title: row.get("title")?,
                    summary: row.get("summary")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        if raws.is_empty() {
            return Ok(Vec::new());
        }

        // (b) Batch-load ALL scene IDs for these chapters.
        let ids: Vec<String> = raws.iter().map(|r| r.id.clone()).collect();
        let placeholders = (1..=ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
        "SELECT chapter_id, id FROM scenes WHERE chapter_id IN ({placeholders}) ORDER BY position"
    );
        let mut sc_stmt = conn.prepare(&sql)?;
        let all_scenes: Vec<(String, String)> = sc_stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((
                    row.get::<_, String>("chapter_id")?,
                    row.get::<_, String>("id")?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // (c) Group scene IDs by chapter_id.
        let mut sc_map: HashMap<String, Vec<String>> = HashMap::new();
        for (ch_id, sc_id) in all_scenes {
            sc_map.entry(ch_id).or_default().push(sc_id);
        }

        // (d) Assemble results.
        let result: Vec<Chapter> = raws
            .into_iter()
            .map(|raw| {
                let scene_ids = sc_map.remove(&raw.id).unwrap_or_default();
                Chapter {
                    id: raw.id,
                    novel_id: novel_id.clone(),
                    title: raw.title,
                    summary: raw.summary,
                    scene_ids,
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                }
            })
            .collect();

        Ok(result)
    })
}

/// Batch-load all scenes of a chapter (with all junction refs), avoiding N+1.
#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_scenes(
    space_id: String,
    world_id: String,
    chapter_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Scene>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
    // (a) Batch-load ALL scene rows for this chapter.
    struct SceneRaw {
        id: String,
        title: String,
        summary: String,
        content: String,
        start_at: Option<String>,
        end_at: Option<String>,
        location_id: Option<String>,
        created_at: String,
        updated_at: String,
    }
    let mut stmt = conn.prepare(
        "SELECT id, title, summary, content, start_at, end_at, location_id, created_at, updated_at
         FROM scenes WHERE chapter_id = ?1 ORDER BY position",
    )?;
    let raws: Vec<SceneRaw> = stmt
        .query_map(params![&chapter_id], |row| {
            Ok(SceneRaw {
                id: row.get("id")?,
                title: row.get("title")?,
                summary: row.get("summary")?,
                content: row.get("content")?,
                start_at: row.get("start_at")?,
                end_at: row.get("end_at")?,
                location_id: row.get("location_id")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if raws.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<String> = raws.iter().map(|r| r.id.clone()).collect();
    let placeholders = (1..=ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");

    // (b) Batch-load ALL character refs.
    let char_sql = format!(
        "SELECT scene_id, character_id, phase_id FROM scene_character_refs WHERE scene_id IN ({placeholders})"
    );
    let mut char_stmt = conn.prepare(&char_sql)?;
    let all_char_refs: Vec<(String, CharacterRef)> = char_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                CharacterRef {
                    character_id: row.get("character_id")?,
                    phase_id: row.get("phase_id")?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (c) Batch-load ALL item refs.
    let item_sql = format!(
        "SELECT scene_id, item_id FROM scene_item_refs WHERE scene_id IN ({placeholders})"
    );
    let mut item_stmt = conn.prepare(&item_sql)?;
    let all_item_refs: Vec<(String, String)> = item_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                row.get::<_, String>("item_id")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (d) Batch-load ALL event refs.
    let event_sql = format!(
        "SELECT scene_id, event_id FROM scene_event_refs WHERE scene_id IN ({placeholders})"
    );
    let mut event_stmt = conn.prepare(&event_sql)?;
    let all_event_refs: Vec<(String, String)> = event_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                row.get::<_, String>("event_id")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (e) Batch-load ALL lore refs.
    let lore_sql = format!(
        "SELECT scene_id, lore_id FROM scene_lore_refs WHERE scene_id IN ({placeholders})"
    );
    let mut lore_stmt = conn.prepare(&lore_sql)?;
    let all_lore_refs: Vec<(String, String)> = lore_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                row.get::<_, String>("lore_id")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (f) Group refs by scene_id.
    let mut char_map: HashMap<String, Vec<CharacterRef>> = HashMap::new();
    for (sc_id, r) in all_char_refs {
        char_map.entry(sc_id).or_default().push(r);
    }
    let mut item_map: HashMap<String, Vec<String>> = HashMap::new();
    for (sc_id, item_id) in all_item_refs {
        item_map.entry(sc_id).or_default().push(item_id);
    }
    let mut event_map: HashMap<String, Vec<String>> = HashMap::new();
    for (sc_id, event_id) in all_event_refs {
        event_map.entry(sc_id).or_default().push(event_id);
    }
    let mut lore_map: HashMap<String, Vec<String>> = HashMap::new();
    for (sc_id, lore_id) in all_lore_refs {
        lore_map.entry(sc_id).or_default().push(lore_id);
    }

    // (g) Assemble results.
    let result: Vec<Scene> = raws
        .into_iter()
        .map(|raw| {
            let character_refs = char_map.remove(&raw.id).unwrap_or_default();
            let item_ids = item_map.remove(&raw.id).unwrap_or_default();
            let event_ids = event_map.remove(&raw.id).unwrap_or_default();
            let lore_ids = lore_map.remove(&raw.id).unwrap_or_default();
            Scene {
                id: raw.id,
                chapter_id: chapter_id.clone(),
                title: raw.title,
                summary: raw.summary,
                content: raw.content,
                start_at: raw.start_at,
                end_at: raw.end_at,
                character_refs,
                location_id: raw.location_id,
                item_ids,
                event_ids,
                lore_ids,
                created_at: raw.created_at,
                updated_at: raw.updated_at,
            }
        })
        .collect();

    Ok(result)
})
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_novel(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateNovelInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Novel, DbError> {
    do_update_novel(&state, &space_id, &world_id, &id, &input, Some(&app))
}

/// Testable core of [`update_novel`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_update_novel(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateNovelInput,
    app: Option<&AppHandle>,
) -> Result<Novel, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn.execute(
        "UPDATE novels SET title = ?1, description = ?2, author = ?3, tags = ?4, updated_at = ?5 WHERE id = ?6",
        params![input.title, input.description, input.author, tags_json, now, id],
    )?;
        if updated == 0 {
            return Err(DbError::NotFound("Novel", id.to_string()));
        }
        load_novel(conn, id, world_id)
    });
    if let (Ok(ref entity), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "novel",
            Some(entity.id.clone()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_novel(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_novel(&state, &space_id, &world_id, &id, Some(&app))
}

/// Testable core of [`delete_novel`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_delete_novel(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM novels WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Novel", id.to_string()));
        }
        Ok(())
    });
    if let (Ok(()), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "novel",
            Some(id.to_string()),
            space_id,
            Some(world_id),
        );
    }
    result
}

// ─── Chapter CRUD ──────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_chapter(
    space_id: String,
    world_id: String,
    novel_id: String,
    input: CreateChapterInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Chapter, DbError> {
    let chapter = do_create_chapter(&state, &space_id, &world_id, &novel_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", chapter.id.as_str());
    Ok(chapter)
}

/// Testable core of [`create_chapter`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_create_chapter(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    novel_id: &str,
    input: &CreateChapterInput,
    app: Option<&AppHandle>,
) -> Result<Chapter, DbError> {
    let id = new_id();
    let now = now_iso();

    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        let next_pos: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM chapters WHERE novel_id = ?1",
            params![novel_id],
            |row| row.get(0),
        )?;

        tx.execute(
            "INSERT INTO chapters (id, novel_id, title, summary, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, novel_id, input.title, input.summary, next_pos, now, now],
        )?;
        tx.commit()?;

        load_chapter(conn, &id)
    });
    if let (Ok(ref entity), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "chapter",
            Some(entity.id.clone()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_chapter(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Chapter, DbError> {
    state.with_world(&space_id, &world_id, |conn| load_chapter(conn, &id))
}

/// Load a chapter with all its scenes' overviews (no `content` body) in one
/// trip. Used by the agent `get_chapter_overview` tool so the model can grasp
/// what happens in a chapter and which worldbook entities are referenced
/// without transferring every scene's prose. Mirrors `list_scenes`' batch
/// junction-ref loading, but omits the `content` column from the scene SELECT.
fn load_chapter_overview(conn: &rusqlite::Connection, id: &str) -> Result<ChapterOverview, DbError> {
    let chapter = load_chapter(conn, id)?;

    // (a) Batch-load ALL scene rows for this chapter — WITHOUT `content`.
    struct SceneOverviewRaw {
        id: String,
        title: String,
        summary: String,
        start_at: Option<String>,
        end_at: Option<String>,
        location_id: Option<String>,
        created_at: String,
        updated_at: String,
    }
    let mut stmt = conn.prepare(
        "SELECT id, title, summary, start_at, end_at, location_id, created_at, updated_at
         FROM scenes WHERE chapter_id = ?1 ORDER BY position",
    )?;
    let raws: Vec<SceneOverviewRaw> = stmt
        .query_map(params![id], |row| {
            Ok(SceneOverviewRaw {
                id: row.get("id")?,
                title: row.get("title")?,
                summary: row.get("summary")?,
                start_at: row.get("start_at")?,
                end_at: row.get("end_at")?,
                location_id: row.get("location_id")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if raws.is_empty() {
        return Ok(ChapterOverview {
            chapter,
            scenes: Vec::new(),
        });
    }

    let ids: Vec<String> = raws.iter().map(|r| r.id.clone()).collect();
    let placeholders = (1..=ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");

    // (b) Batch-load ALL character refs.
    let char_sql = format!(
        "SELECT scene_id, character_id, phase_id FROM scene_character_refs WHERE scene_id IN ({placeholders})"
    );
    let mut char_stmt = conn.prepare(&char_sql)?;
    let all_char_refs: Vec<(String, CharacterRef)> = char_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                CharacterRef {
                    character_id: row.get("character_id")?,
                    phase_id: row.get("phase_id")?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (c) Batch-load ALL item refs.
    let item_sql = format!(
        "SELECT scene_id, item_id FROM scene_item_refs WHERE scene_id IN ({placeholders})"
    );
    let mut item_stmt = conn.prepare(&item_sql)?;
    let all_item_refs: Vec<(String, String)> = item_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                row.get::<_, String>("item_id")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (d) Batch-load ALL event refs.
    let event_sql = format!(
        "SELECT scene_id, event_id FROM scene_event_refs WHERE scene_id IN ({placeholders})"
    );
    let mut event_stmt = conn.prepare(&event_sql)?;
    let all_event_refs: Vec<(String, String)> = event_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                row.get::<_, String>("event_id")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (e) Batch-load ALL lore refs.
    let lore_sql = format!(
        "SELECT scene_id, lore_id FROM scene_lore_refs WHERE scene_id IN ({placeholders})"
    );
    let mut lore_stmt = conn.prepare(&lore_sql)?;
    let all_lore_refs: Vec<(String, String)> = lore_stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>("scene_id")?,
                row.get::<_, String>("lore_id")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // (f) Group refs by scene_id.
    let mut char_map: HashMap<String, Vec<CharacterRef>> = HashMap::new();
    for (sc_id, r) in all_char_refs {
        char_map.entry(sc_id).or_default().push(r);
    }
    let mut item_map: HashMap<String, Vec<String>> = HashMap::new();
    for (sc_id, item_id) in all_item_refs {
        item_map.entry(sc_id).or_default().push(item_id);
    }
    let mut event_map: HashMap<String, Vec<String>> = HashMap::new();
    for (sc_id, event_id) in all_event_refs {
        event_map.entry(sc_id).or_default().push(event_id);
    }
    let mut lore_map: HashMap<String, Vec<String>> = HashMap::new();
    for (sc_id, lore_id) in all_lore_refs {
        lore_map.entry(sc_id).or_default().push(lore_id);
    }

    // (g) Assemble results.
    let scenes: Vec<SceneOverview> = raws
        .into_iter()
        .map(|raw| {
            let character_refs = char_map.remove(&raw.id).unwrap_or_default();
            let item_ids = item_map.remove(&raw.id).unwrap_or_default();
            let event_ids = event_map.remove(&raw.id).unwrap_or_default();
            let lore_ids = lore_map.remove(&raw.id).unwrap_or_default();
            SceneOverview {
                id: raw.id,
                chapter_id: id.to_string(),
                title: raw.title,
                summary: raw.summary,
                start_at: raw.start_at,
                end_at: raw.end_at,
                character_refs,
                location_id: raw.location_id,
                item_ids,
                event_ids,
                lore_ids,
                created_at: raw.created_at,
                updated_at: raw.updated_at,
            }
        })
        .collect();

    Ok(ChapterOverview { chapter, scenes })
}

/// Get a chapter with all its scenes' overviews (summary, timeline, entity
/// references) in a single call — scene prose (`content`) is excluded so the
/// agent can quickly understand the chapter's structure and references.
#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_chapter_overview(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<ChapterOverview, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        load_chapter_overview(conn, &id)
    })
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_chapter(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateChapterInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Chapter, DbError> {
    do_update_chapter(&state, &space_id, &world_id, &id, &input, Some(&app))
}

/// Testable core of [`update_chapter`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_update_chapter(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateChapterInput,
    app: Option<&AppHandle>,
) -> Result<Chapter, DbError> {
    let now = now_iso();

    let result = mgr.with_world(space_id, world_id, |conn| {
        let updated = conn.execute(
            "UPDATE chapters SET title = ?1, summary = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.title, input.summary, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Chapter", id.to_string()));
        }
        load_chapter(conn, id)
    });
    if let (Ok(ref entity), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "chapter",
            Some(entity.id.clone()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_chapter(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_chapter(&state, &space_id, &world_id, &id, Some(&app))
}

/// Testable core of [`delete_chapter`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_delete_chapter(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM chapters WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Chapter", id.to_string()));
        }
        Ok(())
    });
    if let (Ok(()), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "chapter",
            Some(id.to_string()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, chapter_ids, app))]
#[tauri::command]
pub fn reorder_chapters(
    space_id: String,
    world_id: String,
    novel_id: String,
    chapter_ids: Vec<String>,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_reorder_chapters(
        &state,
        &space_id,
        &world_id,
        &novel_id,
        &chapter_ids,
        Some(&app),
    )
}

/// Testable core of [`reorder_chapters`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_reorder_chapters(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    novel_id: &str,
    chapter_ids: &[String],
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        // Shift to a temporary range to avoid UNIQUE(novel_id, position) violations
        // during per-row updates.
        tx.execute(
            "UPDATE chapters SET position = position + 1000000 WHERE novel_id = ?1",
            params![novel_id],
        )?;

        for (i, ch_id) in chapter_ids.iter().enumerate() {
            let pos = i as i64;
            let affected = tx.execute(
                "UPDATE chapters SET position = ?1 WHERE id = ?2 AND novel_id = ?3",
                params![pos, ch_id, novel_id],
            )?;
            if affected == 0 {
                return Err(DbError::NotFound("Chapter", ch_id.clone()));
            }
        }

        tx.commit()?;
        Ok(())
    });
    if let (Ok(()), Some(app)) = (&result, app) {
        emit_entity_changed(app, "chapter", None, space_id, Some(world_id));
    }
    result
}

// ─── Scene CRUD ──────────────────────────────────────────────────────────────

#[tracing::instrument(skip(state, input, app), fields(entity_id))]
#[tauri::command]
pub fn create_scene(
    space_id: String,
    world_id: String,
    chapter_id: String,
    input: CreateSceneInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Scene, DbError> {
    let scene = do_create_scene(&state, &space_id, &world_id, &chapter_id, &input, Some(&app))?;
    tracing::Span::current().record("entity_id", scene.id.as_str());
    Ok(scene)
}

/// Testable core of [`create_scene`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_create_scene(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    chapter_id: &str,
    input: &CreateSceneInput,
    app: Option<&AppHandle>,
) -> Result<Scene, DbError> {
    let id = new_id();
    let now = now_iso();
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    let result = mgr.with_world(space_id, world_id, |conn| {
    let tx = conn.transaction()?;

    let next_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM scenes WHERE chapter_id = ?1",
            params![chapter_id],
            |row| row.get(0),
        )?;

    tx.execute(
        "INSERT INTO scenes (id, chapter_id, title, summary, content, start_at, end_at, location_id, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            chapter_id,
            input.title,
            input.summary,
            input.content,
            start_at,
            end_at,
            input.location_id,
            next_pos,
            now,
            now,
        ],
    )?;

    for r in &input.character_refs {
        tx.execute(
            "INSERT INTO scene_character_refs (scene_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
            params![id, r.character_id, r.phase_id],
        )?;
    }

    for item_id in &input.item_ids {
        tx.execute(
            "INSERT INTO scene_item_refs (scene_id, item_id) VALUES (?1, ?2)",
            params![id, item_id],
        )?;
    }

    for event_id in &input.event_ids {
        tx.execute(
            "INSERT INTO scene_event_refs (scene_id, event_id) VALUES (?1, ?2)",
            params![id, event_id],
        )?;
    }

    for lore_id in &input.lore_ids {
        tx.execute(
            "INSERT INTO scene_lore_refs (scene_id, lore_id) VALUES (?1, ?2)",
            params![id, lore_id],
        )?;
    }

    tx.commit()?;
    load_scene(conn, &id)
});
    if let (Ok(ref entity), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "scene",
            Some(entity.id.clone()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_scene(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Scene, DbError> {
    state.with_world(&space_id, &world_id, |conn| load_scene(conn, &id))
}

#[tracing::instrument(skip(state, input, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn update_scene(
    space_id: String,
    world_id: String,
    id: String,
    input: UpdateSceneInput,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<Scene, DbError> {
    do_update_scene(&state, &space_id, &world_id, &id, &input, Some(&app))
}

/// Testable core of [`update_scene`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_update_scene(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    input: &UpdateSceneInput,
    app: Option<&AppHandle>,
) -> Result<Scene, DbError> {
    let now = now_iso();
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    let result = mgr.with_world(space_id, world_id, |conn| {
    let tx = conn.transaction()?;

    let affected = tx.execute(
        "UPDATE scenes SET title = ?1, summary = ?2, content = ?3, start_at = ?4, end_at = ?5, location_id = ?6, updated_at = ?7
         WHERE id = ?8",
        params![
            input.title,
            input.summary,
            input.content,
            start_at,
            end_at,
            input.location_id,
            now,
            id,
        ],
    )?;
    if affected == 0 {
        return Err(DbError::NotFound("Scene", id.to_string()));
    }

    tx.execute(
        "DELETE FROM scene_character_refs WHERE scene_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM scene_item_refs WHERE scene_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM scene_event_refs WHERE scene_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM scene_lore_refs WHERE scene_id = ?1",
        params![id],
    )?;

    for r in &input.character_refs {
        tx.execute(
            "INSERT INTO scene_character_refs (scene_id, character_id, phase_id) VALUES (?1, ?2, ?3)",
            params![id, r.character_id, r.phase_id],
        )?;
    }

    for item_id in &input.item_ids {
        tx.execute(
            "INSERT INTO scene_item_refs (scene_id, item_id) VALUES (?1, ?2)",
            params![id, item_id],
        )?;
    }

    for event_id in &input.event_ids {
        tx.execute(
            "INSERT INTO scene_event_refs (scene_id, event_id) VALUES (?1, ?2)",
            params![id, event_id],
        )?;
    }

    for lore_id in &input.lore_ids {
        tx.execute(
            "INSERT INTO scene_lore_refs (scene_id, lore_id) VALUES (?1, ?2)",
            params![id, lore_id],
        )?;
    }

    tx.commit()?;
    load_scene(conn, id)
});
    if let (Ok(ref entity), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "scene",
            Some(entity.id.clone()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_scene(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_delete_scene(&state, &space_id, &world_id, &id, Some(&app))
}

/// Testable core of [`delete_scene`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_delete_scene(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let deleted = conn.execute("DELETE FROM scenes WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Scene", id.to_string()));
        }
        Ok(())
    });
    if let (Ok(()), Some(app)) = (&result, app) {
        emit_entity_changed(
            app,
            "scene",
            Some(id.to_string()),
            space_id,
            Some(world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, scene_ids, app))]
#[tauri::command]
pub fn reorder_scenes(
    space_id: String,
    world_id: String,
    chapter_id: String,
    scene_ids: Vec<String>,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    do_reorder_scenes(
        &state,
        &space_id,
        &world_id,
        &chapter_id,
        &scene_ids,
        Some(&app),
    )
}

/// Testable core of [`reorder_scenes`] — see [`do_create_novel`] for the
/// `&DbManager` + `Option<&AppHandle>` pattern.
pub(crate) fn do_reorder_scenes(
    mgr: &DbManager,
    space_id: &str,
    world_id: &str,
    chapter_id: &str,
    scene_ids: &[String],
    app: Option<&AppHandle>,
) -> Result<(), DbError> {
    let result = mgr.with_world(space_id, world_id, |conn| {
        let tx = conn.transaction()?;

        // Shift to a temporary range to avoid UNIQUE(chapter_id, position) violations
        // during per-row updates.
        tx.execute(
            "UPDATE scenes SET position = position + 1000000 WHERE chapter_id = ?1",
            params![chapter_id],
        )?;

        for (i, sc_id) in scene_ids.iter().enumerate() {
            let pos = i as i64;
            let affected = tx.execute(
                "UPDATE scenes SET position = ?1 WHERE id = ?2 AND chapter_id = ?3",
                params![pos, sc_id, chapter_id],
            )?;
            if affected == 0 {
                return Err(DbError::NotFound("Scene", sc_id.clone()));
            }
        }

        tx.commit()?;
        Ok(())
    });
    if let (Ok(()), Some(app)) = (&result, app) {
        emit_entity_changed(app, "scene", None, space_id, Some(world_id));
    }
    result
}

// ─── Per-entity image commands (Novel) ──────────────────────────────────────
//
// The `image_blob` / `image_mime` columns on the `novels` table are added by
// `WORLD_MIGRATION_006`. Image bytes flow ONLY through these dedicated
// commands — the `Novel` struct and `list_novels` / `get_novel` queries never
// touch the columns (avoids a serde Vec<u8> → JSON-number-array encoding trap
// and keeps list payloads light).
//
// Logging (ADR-0014 / ADR-0016): only metadata (entity_id, byte length, mime)
// is ever logged — the bytes themselves are creative content. update + clear
// are INFO; get is DEBUG because it fires on every novel card render.

#[tracing::instrument(
    skip(state, image_base64, app),
    fields(entity_id = %id)
)]
#[tauri::command]
pub fn update_novel_image(
    space_id: String,
    world_id: String,
    id: String,
    image_base64: String,
    image_mime: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    let bytes = decode_and_validate_image(&image_base64, &image_mime)?;
    let now = now_iso();
    tracing::info!(
        entity_id = %id,
        image_bytes_len = bytes.len(),
        image_mime = %image_mime,
        "image updated"
    );
    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE novels SET image_blob = ?1, image_mime = ?2, updated_at = ?3 WHERE id = ?4",
            params![&bytes, &image_mime, now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Novel", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "novel",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id, app), fields(entity_id = %id))]
#[tauri::command]
pub fn clear_novel_image(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    let now = now_iso();
    tracing::info!(entity_id = %id, "image cleared");
    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE novels SET image_blob = NULL, image_mime = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, &id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Novel", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "novel",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_novel_image(
    space_id: String,
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<tauri::ipc::Response, DbError> {
    tracing::debug!(entity_id = %id, "image fetched");
    let bytes: Option<Vec<u8>> = state.with_world(&space_id, &world_id, |conn| {
        conn.query_row(
            "SELECT image_blob FROM novels WHERE id = ?1",
            params![&id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Image", id.clone()),
            other => DbError::Sqlite(other),
        })
    })?;
    let bytes = bytes.ok_or_else(|| DbError::NotFound("Image", id))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ─── Scene gallery image commands (1:N) ─────────────────────────────────────
//
// The `scene_images` sidecar table is created by `WORLD_MIGRATION_008`. Unlike
// the single-image columns on the other "imageable" tables (WORLD_MIGRATION_006),
// a Scene owns an ordered 1:N gallery. Image bytes flow ONLY through
// `add_scene_image` / `get_scene_image` — the `Scene` struct, `load_scene`, and
// `list_scenes` never touch the `scene_images` table (avoids the serde Vec<u8>
// → JSON-number-array encoding trap and keeps scene payloads light). The
// `SceneImageMeta` struct returned by `add_scene_image` / `list_scene_image_ids`
// carries metadata only — NO `image_blob` field.
//
// Logging (ADR-0014 / ADR-0016): only metadata (entity_id, scene_id, byte
// length, mime, counts) is ever logged — the bytes themselves are creative
// content. add + delete + reorder are INFO; get + list are DEBUG because they
// fire on every scene render.

#[tracing::instrument(
    skip(state, image_base64, app),
    fields(entity_id, scene_id = %scene_id)
)]
#[tauri::command]
pub fn add_scene_image(
    space_id: String,
    world_id: String,
    scene_id: String,
    image_base64: String,
    image_mime: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<SceneImageMeta, DbError> {
    let bytes = decode_and_validate_image(&image_base64, &image_mime)?;
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    tracing::info!(
        entity_id = %id,
        scene_id = %scene_id,
        image_bytes_len = bytes.len(),
        image_mime = %image_mime,
        "scene image added"
    );
    let result = state.with_world(&space_id, &world_id, |conn| {
        // Verify the parent scene exists first — a plain FK violation on
        // INSERT would surface as an opaque SQLite error, but the contract
        // here is a business-level NotFound so the frontend can branch on it.
        conn.query_row(
            "SELECT 1 FROM scenes WHERE id = ?1",
            params![&scene_id],
            |_| Ok(()),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Scene", scene_id.clone()),
            other => DbError::Sqlite(other),
        })?;

        let next_pos: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM scene_images WHERE scene_id = ?1",
            params![&scene_id],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO scene_images (id, scene_id, position, image_blob, image_mime, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&id, &scene_id, next_pos, &bytes, &image_mime, &now, &now],
        )?;

        let meta = conn.query_row(
            "SELECT id, scene_id, position, created_at, updated_at FROM scene_images WHERE id = ?1",
            params![&id],
            |row| {
                Ok(SceneImageMeta {
                    id: row.get(0)?,
                    scene_id: row.get(1)?,
                    position: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )?;
        Ok(meta)
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "scene",
            Some(scene_id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state, app), fields(entity_id = %image_id))]
#[tauri::command]
pub fn delete_scene_image(
    space_id: String,
    world_id: String,
    image_id: String,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    tracing::info!(entity_id = %image_id, "scene image deleted");
    // Closure returns the parent scene_id so we can emit a targeted
    // entity-changed event after success. Mapped back to `()` below.
    let result = state.with_world(&space_id, &world_id, |conn| {
        // Capture scene_id before delete so siblings can be renumbered.
        let scene_id: String = conn
            .query_row(
                "SELECT scene_id FROM scene_images WHERE id = ?1",
                params![&image_id],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Image", image_id.clone()),
                other => DbError::Sqlite(other),
            })?;

        let tx = conn.transaction()?;
        let deleted = tx.execute("DELETE FROM scene_images WHERE id = ?1", params![&image_id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Image", image_id.clone()));
        }

        // Renumber remaining siblings to keep positions contiguous (0..N-1).
        // No UNIQUE(scene_id, position) constraint exists, so we can update
        // rows in place without the temporary-shift dance reorder_scenes needs.
        let remaining_ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM scene_images WHERE scene_id = ?1 ORDER BY position ASC",
            )?;
            let rows = stmt.query_map(params![&scene_id], |row| row.get::<_, String>(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        };
        for (i, rid) in remaining_ids.iter().enumerate() {
            tx.execute(
                "UPDATE scene_images SET position = ?1 WHERE id = ?2",
                params![i as i64, rid],
            )?;
        }
        tx.commit()?;
        Ok(scene_id)
    });
    if let Ok(ref scene_id) = result {
        emit_entity_changed(
            &app,
            "scene",
            Some(scene_id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result.map(|_| ())
}

#[tracing::instrument(skip(state, image_ids, app), fields(scene_id = %scene_id))]
#[tauri::command]
pub fn reorder_scene_images(
    space_id: String,
    world_id: String,
    scene_id: String,
    image_ids: Vec<String>,
    state: State<'_, DbManager>,
    app: AppHandle,
) -> Result<(), DbError> {
    let result = state.with_world(&space_id, &world_id, |conn| {
        let tx = conn.transaction()?;
        // No UNIQUE(scene_id, position) constraint, so per-row updates can run
        // directly without the temporary-shift that reorder_scenes needs.
        for (i, img_id) in image_ids.iter().enumerate() {
            let pos = i as i64;
            let affected = tx.execute(
                "UPDATE scene_images SET position = ?1 WHERE id = ?2 AND scene_id = ?3",
                params![pos, img_id, &scene_id],
            )?;
            if affected == 0 {
                return Err(DbError::NotFound("Image", img_id.clone()));
            }
        }
        tx.commit()?;
        tracing::info!(
            scene_id = %scene_id,
            image_count = image_ids.len(),
            "scene images reordered"
        );
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "scene",
            Some(scene_id.clone()),
            &space_id,
            Some(&world_id),
        );
    }
    result
}

#[tracing::instrument(skip(state), fields(entity_id = %image_id))]
#[tauri::command]
pub fn get_scene_image(
    space_id: String,
    world_id: String,
    image_id: String,
    state: State<'_, DbManager>,
) -> Result<tauri::ipc::Response, DbError> {
    tracing::debug!(entity_id = %image_id, "scene image fetched");
    let bytes: Option<Vec<u8>> = state.with_world(&space_id, &world_id, |conn| {
        conn.query_row(
            "SELECT image_blob FROM scene_images WHERE id = ?1",
            params![&image_id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Image", image_id.clone()),
            other => DbError::Sqlite(other),
        })
    })?;
    let bytes = bytes.ok_or_else(|| DbError::NotFound("Image", image_id))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tracing::instrument(skip(state), fields(scene_id = %scene_id))]
#[tauri::command]
pub fn list_scene_image_ids(
    space_id: String,
    world_id: String,
    scene_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<SceneImageMeta>, DbError> {
    let metas = state.with_world(&space_id, &world_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, scene_id, position, created_at, updated_at
             FROM scene_images
             WHERE scene_id = ?1
             ORDER BY position ASC",
        )?;
        let rows = stmt.query_map(params![&scene_id], |row| {
            Ok(SceneImageMeta {
                id: row.get(0)?,
                scene_id: row.get(1)?,
                position: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        tracing::debug!(
            scene_id = %scene_id,
            image_count = out.len(),
            "scene images listed"
        );
        Ok(out)
    })?;
    Ok(metas)
}

// ─── tests ──────────────────────────────────────────────────────────────────

/// Command-level integration tests over the `do_*` helpers, following the
/// bootstrap pattern from `db/manager.rs::stress_tests` via `crate::testutil`
/// (no `State<'_, _>`, no `AppHandle` — this crate has no mock runtime).
/// DB state is asserted via raw SQL SELECTs inside `with_world`, not just via
/// the entities the helpers return.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{make_space_with_world, with_world, WorldFixture, uuid_shape};

    const NOW: &str = "2026-01-01T00:00:00.000Z";

    /// Sum of one scene's rows across all four junction tables.
    const SCENE_JUNCTION_SUM: &str = "SELECT
        (SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1) +
        (SELECT COUNT(*) FROM scene_item_refs    WHERE scene_id = ?1) +
        (SELECT COUNT(*) FROM scene_event_refs   WHERE scene_id = ?1) +
        (SELECT COUNT(*) FROM scene_lore_refs    WHERE scene_id = ?1)";

    /// Sum of the junction rows of every scene under one chapter.
    const CHAPTER_JUNCTION_SUM: &str = "SELECT
        (SELECT COUNT(*) FROM scene_character_refs r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1) +
        (SELECT COUNT(*) FROM scene_item_refs    r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1) +
        (SELECT COUNT(*) FROM scene_event_refs   r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1) +
        (SELECT COUNT(*) FROM scene_lore_refs    r JOIN scenes s ON r.scene_id = s.id WHERE s.chapter_id = ?1)";

    /// Sum of ALL junction rows in the world db (the fixture world is
    /// isolated, so global counts are exact for single-novel setups).
    const ALL_JUNCTION_SUM: &str = "SELECT
        (SELECT COUNT(*) FROM scene_character_refs) +
        (SELECT COUNT(*) FROM scene_item_refs) +
        (SELECT COUNT(*) FROM scene_event_refs) +
        (SELECT COUNT(*) FROM scene_lore_refs)";

    // ─── input builders ─────────────────────────────────────────────────────

    fn novel_input(title: &str) -> CreateNovelInput {
        CreateNovelInput {
            title: title.into(),
            description: String::new(),
            author: String::new(),
            tags: Vec::new(),
        }
    }

    fn chapter_input(title: &str) -> CreateChapterInput {
        CreateChapterInput {
            title: title.into(),
            summary: String::new(),
        }
    }

    fn char_ref(character_id: String, phase_id: String) -> CharacterRef {
        CharacterRef {
            character_id,
            phase_id,
        }
    }

    fn scene_input(
        title: &str,
        character_refs: Vec<CharacterRef>,
        item_ids: Vec<String>,
        event_ids: Vec<String>,
        lore_ids: Vec<String>,
    ) -> CreateSceneInput {
        CreateSceneInput {
            title: title.into(),
            summary: String::new(),
            content: String::new(),
            start_at: None,
            end_at: None,
            character_refs,
            location_id: None,
            item_ids,
            event_ids,
            lore_ids,
        }
    }

    /// Same shape as `scene_input` but for the full-replacement update path
    /// (`UpdateSceneInput` has no serde defaults — every field is required).
    fn scene_update(
        title: &str,
        character_refs: Vec<CharacterRef>,
        item_ids: Vec<String>,
        event_ids: Vec<String>,
        lore_ids: Vec<String>,
    ) -> UpdateSceneInput {
        UpdateSceneInput {
            title: title.into(),
            summary: String::new(),
            content: String::new(),
            start_at: None,
            end_at: None,
            character_refs,
            location_id: None,
            item_ids,
            event_ids,
            lore_ids,
        }
    }

    // ─── raw-SQL fixtures ───────────────────────────────────────────────────

    /// Insert a character + one phase via raw SQL; returns (character_id,
    /// phase_id). Column lists mirror the WORLD_SQL DDL (aliases/tags are JSON
    /// '[]'; NOT NULL columns are all satisfied).
    fn insert_character_with_phase(fx: &WorldFixture, n: u64) -> (String, String) {
        let cid = uuid_shape(n);
        let pid = uuid_shape(n + 5000);
        with_world(fx, |conn| {
            conn.execute(
                "INSERT INTO characters (id, name, aliases, description, notes, tags, created_at, updated_at)
                 VALUES (?1, ?2, '[]', '', '', '[]', ?3, ?3)",
                params![&cid, format!("char-{n}"), NOW],
            )?;
            conn.execute(
                "INSERT INTO character_phases (id, character_id, name, appearance, description, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', '', 0, ?4, ?4)",
                params![&pid, &cid, format!("phase-{n}"), NOW],
            )?;
            Ok(())
        })
        .expect("insert character + phase");
        (cid, pid)
    }

    /// Insert an item row; returns its id.
    fn insert_item(fx: &WorldFixture, n: u64) -> String {
        insert_named(fx, "items", n)
    }

    /// Insert an event row; returns its id.
    fn insert_event(fx: &WorldFixture, n: u64) -> String {
        insert_named(fx, "events", n)
    }

    /// Insert a lore row; returns its id.
    fn insert_lore(fx: &WorldFixture, n: u64) -> String {
        insert_named(fx, "lores", n)
    }

    /// Shared INSERT for the identically-shaped items/events/lores tables
    /// (events' extra start_at/end_at/location_id columns are nullable).
    fn insert_named(fx: &WorldFixture, table: &str, n: u64) -> String {
        let id = uuid_shape(n + 10000);
        let sql = format!(
            "INSERT INTO {table} (id, name, description, notes, tags, created_at, updated_at)
             VALUES (?1, ?2, '', '', '[]', ?3, ?3)"
        );
        with_world(fx, |conn| {
            conn.execute(&sql, params![&id, format!("{table}-{n}"), NOW])?;
            Ok(())
        })
        .expect("insert world entity row");
        id
    }

    /// Bootstrap novel → chapter → scene-with-all-four-ref-kinds via the
    /// `do_*` helpers themselves. Returns (novel, chapter, scene).
    fn novel_chapter_scene(fx: &WorldFixture) -> (Novel, Chapter, Scene) {
        let novel = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("N"), None)
            .expect("create novel");
        let chapter = do_create_chapter(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &novel.id,
            &chapter_input("C"),
            None,
        )
        .expect("create chapter");
        let (cid, pid) = insert_character_with_phase(fx, 10);
        let item_id = insert_item(fx, 11);
        let event_id = insert_event(fx, 12);
        let lore_id = insert_lore(fx, 13);
        let scene = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &chapter.id,
            &scene_input(
                "S",
                vec![char_ref(cid, pid)],
                vec![item_id],
                vec![event_id],
                vec![lore_id],
            ),
            None,
        )
        .expect("create scene");
        (novel, chapter, scene)
    }

    // ─── assertion helpers ──────────────────────────────────────────────────

    /// Run a scalar COUNT/SELECT-int query and expect success.
    fn count(fx: &WorldFixture, sql: &str, args: &[&dyn rusqlite::ToSql]) -> i64 {
        with_world(fx, |conn| {
            Ok(conn.query_row(sql, args, |row| row.get::<_, i64>(0))?)
        })
        .expect("count query")
    }

    /// Read the `position` column of one row in `chapters` / `scenes`.
    fn position_of(fx: &WorldFixture, table: &str, id: &str) -> i64 {
        let sql = format!("SELECT position FROM {table} WHERE id = ?1");
        with_world(fx, |conn| {
            Ok(conn.query_row(&sql, params![id], |row| row.get::<_, i64>(0))?)
        })
        .expect("read position")
    }

    /// Assert `err` is a SQLite constraint violation (UNIQUE / FK / PK) —
    /// the raw `DbError::Sqlite` shape, since novels have no DuplicateName
    /// business variant.
    fn assert_constraint_violation(err: &DbError) {
        match err {
            DbError::Sqlite(rusqlite::Error::SqliteFailure(e, _)) => {
                assert_eq!(
                    e.code,
                    rusqlite::ErrorCode::ConstraintViolation,
                    "expected ConstraintViolation, got {:?}",
                    e.code
                );
            }
            other => panic!("expected DbError::Sqlite, got {other:?}"),
        }
    }

    // ─── create_scene: junction writes + position assignment ────────────────

    /// `do_create_scene` writes the scene row plus all four junction tables
    /// in one shot, and assigns position = MAX+1 within the chapter (the
    /// first scene gets 0, the second gets 1).
    #[test]
    fn create_scene_writes_row_and_all_junction_tables() {
        let fx = make_space_with_world();
        let (_novel, chapter, scene) = novel_chapter_scene(&fx);

        with_world(&fx, |conn| {
            let (title, position): (String, i64) = conn
                .query_row(
                    "SELECT title, position FROM scenes WHERE id = ?1",
                    params![scene.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("scene row must exist");
            assert_eq!(title, "S");
            assert_eq!(position, 0, "first scene in chapter gets position 0");
            Ok(())
        })
        .expect("assert scene row");

        let r = &scene.character_refs[0];
        let n_chars = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1 AND character_id = ?2 AND phase_id = ?3",
            &[&scene.id, &r.character_id, &r.phase_id],
        );
        assert_eq!(n_chars, 1, "character ref row written");
        let n_items = count(
            &fx,
            "SELECT COUNT(*) FROM scene_item_refs WHERE scene_id = ?1",
            &[&scene.id],
        );
        assert_eq!(n_items, 1, "item ref row written");
        let n_events = count(
            &fx,
            "SELECT COUNT(*) FROM scene_event_refs WHERE scene_id = ?1",
            &[&scene.id],
        );
        assert_eq!(n_events, 1, "event ref row written");
        let n_lores = count(
            &fx,
            "SELECT COUNT(*) FROM scene_lore_refs WHERE scene_id = ?1",
            &[&scene.id],
        );
        assert_eq!(n_lores, 1, "lore ref row written");

        // Second scene in the SAME chapter → position = MAX(position)+1.
        let scene2 = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &chapter.id,
            &scene_input("S2", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect("create second scene");
        let pos2 = position_of(&fx, "scenes", &scene2.id);
        assert_eq!(pos2, 1, "second scene gets MAX(position)+1");
    }

    // ─── update_scene: full-replacement junction rewrite ────────────────────

    /// `do_update_scene` is full-replacement on the junction tables: the old
    /// ref rows are deleted and the new set inserted (old gone, new present).
    #[test]
    fn update_scene_replaces_junction_refs() {
        let fx = make_space_with_world();
        let novel = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("N"), None)
            .expect("create novel");
        let chapter = do_create_chapter(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &novel.id,
            &chapter_input("C"),
            None,
        )
        .expect("create chapter");
        let (cid_a, pid_a) = insert_character_with_phase(&fx, 20);
        let (cid_b, pid_b) = insert_character_with_phase(&fx, 21);
        let item_a = insert_item(&fx, 22);
        let item_b = insert_item(&fx, 23);
        let event_b = insert_event(&fx, 24);
        let lore_b = insert_lore(&fx, 25);

        let scene = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &chapter.id,
            &scene_input(
                "Old",
                vec![char_ref(cid_a.clone(), pid_a.clone())],
                vec![item_a.clone()],
                vec![],
                vec![],
            ),
            None,
        )
        .expect("create scene");

        do_update_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &scene.id,
            &scene_update(
                "New",
                vec![char_ref(cid_b.clone(), pid_b.clone())],
                vec![item_b.clone()],
                vec![event_b.clone()],
                vec![lore_b.clone()],
            ),
            None,
        )
        .expect("update scene refs");

        let old_char = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1 AND character_id = ?2 AND phase_id = ?3",
            &[&scene.id, &cid_a, &pid_a],
        );
        assert_eq!(old_char, 0, "old character ref must be gone");
        let new_char = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1 AND character_id = ?2 AND phase_id = ?3",
            &[&scene.id, &cid_b, &pid_b],
        );
        assert_eq!(new_char, 1, "new character ref must be present");
        let old_item = count(
            &fx,
            "SELECT COUNT(*) FROM scene_item_refs WHERE scene_id = ?1 AND item_id = ?2",
            &[&scene.id, &item_a],
        );
        assert_eq!(old_item, 0, "old item ref must be gone");
        let new_item = count(
            &fx,
            "SELECT COUNT(*) FROM scene_item_refs WHERE scene_id = ?1 AND item_id = ?2",
            &[&scene.id, &item_b],
        );
        assert_eq!(new_item, 1, "new item ref must be present");
        let new_event = count(
            &fx,
            "SELECT COUNT(*) FROM scene_event_refs WHERE scene_id = ?1 AND event_id = ?2",
            &[&scene.id, &event_b],
        );
        assert_eq!(new_event, 1, "new event ref must be present");
        let new_lore = count(
            &fx,
            "SELECT COUNT(*) FROM scene_lore_refs WHERE scene_id = ?1 AND lore_id = ?2",
            &[&scene.id, &lore_b],
        );
        assert_eq!(new_lore, 1, "new lore ref must be present");

        let title: String = with_world(&fx, |conn| {
            Ok(conn.query_row(
                "SELECT title FROM scenes WHERE id = ?1",
                params![scene.id],
                |row| row.get(0),
            )?)
        })
        .expect("read scene title");
        assert_eq!(title, "New");
    }

    /// Transaction atomicity: an update_scene input containing a nonexistent
    /// character_id fails on the FK constraint during the junction INSERT
    /// loop (after the DELETEs already ran), and the whole transaction rolls
    /// back — the old refs AND the old field values must be fully intact.
    #[test]
    fn update_scene_fk_violation_rolls_back() {
        let fx = make_space_with_world();
        let (_novel, _chapter, scene) = novel_chapter_scene(&fx);

        let ghost_character = uuid_shape(9999);
        let original_phase = scene.character_refs[0].phase_id.clone();
        let err = do_update_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &scene.id,
            &scene_update("New", vec![char_ref(ghost_character, original_phase)], vec![], vec![], vec![]),
            None,
        )
        .expect_err("nonexistent character_id must reject");
        assert_constraint_violation(&err);

        // Old refs fully intact (one row in each of the four junction tables).
        let junctions = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
        assert_eq!(junctions, 4, "old refs must survive the rollback");

        // The field UPDATE rolled back together with the junction writes.
        let title: String = with_world(&fx, |conn| {
            Ok(conn.query_row(
                "SELECT title FROM scenes WHERE id = ?1",
                params![scene.id],
                |row| row.get(0),
            )?)
        })
        .expect("read scene title");
        assert_eq!(title, "S", "field UPDATE must roll back with the junctions");
    }

    /// Composite-PK set semantics: the same (character_id, phase_id) pair
    /// twice in one update_scene input trips PRIMARY KEY(scene_id,
    /// character_id, phase_id) on the second INSERT; the transaction rolls
    /// back and the pre-update refs stay intact.
    #[test]
    fn update_scene_duplicate_ref_pair_rejects() {
        let fx = make_space_with_world();
        let (_novel, _chapter, scene) = novel_chapter_scene(&fx);

        let original = &scene.character_refs[0];
        let err = do_update_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &scene.id,
            &scene_update(
                "New",
                vec![
                    char_ref(original.character_id.clone(), original.phase_id.clone()),
                    char_ref(original.character_id.clone(), original.phase_id.clone()),
                ],
                vec![],
                vec![],
                vec![],
            ),
            None,
        )
        .expect_err("duplicate ref pair must reject");
        assert_constraint_violation(&err);

        let n_chars = count(
            &fx,
            "SELECT COUNT(*) FROM scene_character_refs WHERE scene_id = ?1",
            &[&scene.id],
        );
        assert_eq!(n_chars, 1, "old character ref must be intact after rollback");
        let junctions = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
        assert_eq!(junctions, 4, "old refs must be intact after rollback");
    }

    // ─── reorder: temp-shift semantics ──────────────────────────────────────

    /// Reorder temp-shift semantics: swapping two chapters [B, A] must not
    /// trip UNIQUE(novel_id, position) — the +1000000 shift dance exists for
    /// exactly this. A chapter id belonging to a DIFFERENT novel matches zero
    /// rows in the novel-scoped UPDATE → NotFound, and the failed transaction
    /// (including its temp-shift) rolls back.
    #[test]
    fn reorder_chapters_swaps_and_rejects_foreign_chapter() {
        let fx = make_space_with_world();
        let novel_a = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("A"), None)
            .expect("create novel A");
        let novel_b = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("B"), None)
            .expect("create novel B");
        let a1 = do_create_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &novel_a.id, &chapter_input("A1"), None)
            .expect("create chapter A1");
        let a2 = do_create_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &novel_a.id, &chapter_input("A2"), None)
            .expect("create chapter A2");
        let b1 = do_create_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &novel_b.id, &chapter_input("B1"), None)
            .expect("create chapter B1");

        assert_eq!(position_of(&fx, "chapters", &a1.id), 0);
        assert_eq!(position_of(&fx, "chapters", &a2.id), 1);

        // Swap: [A2, A1] — without the temp-shift this would violate
        // UNIQUE(novel_id, position) on the first per-row update.
        do_reorder_chapters(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &novel_a.id,
            &[a2.id.clone(), a1.id.clone()],
            None,
        )
        .expect("swap chapters");
        assert_eq!(position_of(&fx, "chapters", &a2.id), 0);
        assert_eq!(position_of(&fx, "chapters", &a1.id), 1);

        // A chapter of another novel: the scoped UPDATE matches 0 rows.
        let err = do_reorder_chapters(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &novel_a.id,
            std::slice::from_ref(&b1.id),
            None,
        )
        .expect_err("foreign chapter must be rejected");
        assert!(matches!(err, DbError::NotFound("Chapter", _)));

        // The rejected reorder (and its temp-shift) rolled back.
        assert_eq!(
            position_of(&fx, "chapters", &a1.id),
            1,
            "failed reorder must not corrupt positions"
        );
        assert_eq!(
            position_of(&fx, "chapters", &a2.id),
            0,
            "failed reorder must not corrupt positions"
        );
        assert_eq!(position_of(&fx, "chapters", &b1.id), 0);
    }

    /// Same reorder semantics scoped to a chapter: swapping scenes must not
    /// trip UNIQUE(chapter_id, position); a scene of a DIFFERENT chapter is
    /// NotFound and the failed attempt leaves positions untouched.
    #[test]
    fn reorder_scenes_swaps_and_rejects_foreign_scene() {
        let fx = make_space_with_world();
        let novel = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("N"), None)
            .expect("create novel");
        let c1 = do_create_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &novel.id, &chapter_input("C1"), None)
            .expect("create chapter C1");
        let c2 = do_create_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &novel.id, &chapter_input("C2"), None)
            .expect("create chapter C2");
        let s1 = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &c1.id,
            &scene_input("S1", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect("create scene S1");
        let s2 = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &c1.id,
            &scene_input("S2", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect("create scene S2");
        let s_other = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &c2.id,
            &scene_input("OTHER", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect("create scene in other chapter");

        do_reorder_scenes(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &c1.id,
            &[s2.id.clone(), s1.id.clone()],
            None,
        )
        .expect("swap scenes");
        assert_eq!(position_of(&fx, "scenes", &s2.id), 0);
        assert_eq!(position_of(&fx, "scenes", &s1.id), 1);

        let err = do_reorder_scenes(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &c1.id,
            std::slice::from_ref(&s_other.id),
            None,
        )
        .expect_err("scene of another chapter must be rejected");
        assert!(matches!(err, DbError::NotFound("Scene", _)));

        assert_eq!(
            position_of(&fx, "scenes", &s1.id),
            1,
            "failed reorder must not corrupt positions"
        );
        assert_eq!(
            position_of(&fx, "scenes", &s2.id),
            0,
            "failed reorder must not corrupt positions"
        );
    }

    // ─── cascades ───────────────────────────────────────────────────────────

    /// ON DELETE CASCADE on the junction tables: deleting a scene removes its
    /// rows in all four junction tables (never orphaned).
    #[test]
    fn delete_scene_cascades_junction_rows() {
        let fx = make_space_with_world();
        let (_novel, _chapter, scene) = novel_chapter_scene(&fx);

        let before = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
        assert_eq!(before, 4, "one row per junction table before delete");

        do_delete_scene(&fx.mgr, &fx.space_id, &fx.world_id, &scene.id, None)
            .expect("delete scene");

        let scenes = count(&fx, "SELECT COUNT(*) FROM scenes WHERE id = ?1", &[&scene.id]);
        assert_eq!(scenes, 0, "scene row must be gone");
        let after = count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]);
        assert_eq!(after, 0, "all four junction sets must cascade");
    }

    /// Deleting a chapter cascades to its scenes AND their junction rows.
    #[test]
    fn delete_chapter_cascades_scenes_and_junctions() {
        let fx = make_space_with_world();
        let (novel, chapter, scene) = novel_chapter_scene(&fx);
        let scene2 = do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &chapter.id,
            &scene_input("S2", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect("create second scene");

        let scenes_before =
            count(&fx, "SELECT COUNT(*) FROM scenes WHERE chapter_id = ?1", &[&chapter.id]);
        assert_eq!(scenes_before, 2);
        let junctions_before = count(&fx, CHAPTER_JUNCTION_SUM, &[&chapter.id]);
        assert_eq!(junctions_before, 4, "junction rows of both scenes counted");

        do_delete_chapter(&fx.mgr, &fx.space_id, &fx.world_id, &chapter.id, None)
            .expect("delete chapter");

        let chapters =
            count(&fx, "SELECT COUNT(*) FROM chapters WHERE id = ?1", &[&chapter.id]);
        assert_eq!(chapters, 0, "chapter row must be gone");
        let scenes_after =
            count(&fx, "SELECT COUNT(*) FROM scenes WHERE chapter_id = ?1", &[&chapter.id]);
        assert_eq!(scenes_after, 0, "both scenes must cascade");
        let junctions_after = count(&fx, CHAPTER_JUNCTION_SUM, &[&chapter.id]);
        assert_eq!(junctions_after, 0, "scene junction rows must cascade");
        let junctions_by_scene =
            count(&fx, SCENE_JUNCTION_SUM, &[&scene.id]) + count(&fx, SCENE_JUNCTION_SUM, &[&scene2.id]);
        assert_eq!(junctions_by_scene, 0, "junction rows must be gone per scene too");
        // The novel itself survives.
        let novels = count(&fx, "SELECT COUNT(*) FROM novels WHERE id = ?1", &[&novel.id]);
        assert_eq!(novels, 1, "novel must survive chapter deletion");
    }

    /// Deleting a novel cascades chapters → scenes → junction rows (the full
    /// tree), via the FK ON DELETE CASCADE chain.
    #[test]
    fn delete_novel_cascades_chapters_scenes_junctions() {
        let fx = make_space_with_world();
        let (novel, chapter, _scene) = novel_chapter_scene(&fx);
        // Add a second chapter with its own scene for a wider tree.
        let chapter2 = do_create_chapter(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &novel.id,
            &chapter_input("C2"),
            None,
        )
        .expect("create chapter 2");
        do_create_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &chapter2.id,
            &scene_input("S2", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect("create scene in chapter 2");

        let chapters_before =
            count(&fx, "SELECT COUNT(*) FROM chapters WHERE novel_id = ?1", &[&novel.id]);
        assert_eq!(chapters_before, 2);
        let junctions_before = count(&fx, ALL_JUNCTION_SUM, &[]);
        assert_eq!(junctions_before, 4, "fixture world holds only this novel's junctions");

        do_delete_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel.id, None)
            .expect("delete novel");

        let novels = count(&fx, "SELECT COUNT(*) FROM novels WHERE id = ?1", &[&novel.id]);
        assert_eq!(novels, 0, "novel row must be gone");
        let chapters_after =
            count(&fx, "SELECT COUNT(*) FROM chapters WHERE novel_id = ?1", &[&novel.id]);
        assert_eq!(chapters_after, 0, "chapters must cascade");
        let scenes_of_chapter =
            count(&fx, "SELECT COUNT(*) FROM scenes WHERE chapter_id = ?1", &[&chapter.id]);
        assert_eq!(scenes_of_chapter, 0, "scenes must cascade");
        let junctions_after = count(&fx, ALL_JUNCTION_SUM, &[]);
        assert_eq!(junctions_after, 0, "junction rows must cascade all the way down");
    }

    // ─── uniqueness + NotFound mapping ──────────────────────────────────────

    /// Novel titles are unique per world (`idx_novels_title`); there is no
    /// DuplicateName business variant for novels — the raw UNIQUE violation
    /// surfaces as `DbError::Sqlite` with `ErrorCode::ConstraintViolation`.
    #[test]
    fn create_novel_duplicate_title_rejects() {
        let fx = make_space_with_world();
        do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("Same"), None)
            .expect("first novel with title");
        let err = do_create_novel(&fx.mgr, &fx.space_id, &fx.world_id, &novel_input("Same"), None)
            .expect_err("duplicate title must reject");
        assert_constraint_violation(&err);

        let n = count(&fx, "SELECT COUNT(*) FROM novels", &[]);
        assert_eq!(n, 1, "only the first novel row exists");
    }

    /// `update_scene` on a nonexistent id: the UPDATE affects 0 rows → the
    /// `rows_affected == 0` → `NotFound("Scene", id)` mapping.
    #[test]
    fn update_scene_not_found() {
        let fx = make_space_with_world();
        let ghost = uuid_shape(8888);
        let err = do_update_scene(
            &fx.mgr,
            &fx.space_id,
            &fx.world_id,
            &ghost,
            &scene_update("Ghost", vec![], vec![], vec![], vec![]),
            None,
        )
        .expect_err("update on nonexistent scene must reject");
        match err {
            DbError::NotFound(entity, id) => {
                assert_eq!(entity, "Scene");
                assert_eq!(id, ghost);
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
