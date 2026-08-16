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

// ─── helpers ────────────────────────────────────────────────────────────────

fn load_novel(conn: &rusqlite::Connection, id: &str, world_id: &str) -> Result<Novel, DbError> {
    let (title, description, author, tags_json, created_at, updated_at, has_image) = conn
        .query_row(
            "SELECT title, description, author, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image FROM novels WHERE id = ?1",
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
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
        conn.execute(
            "INSERT INTO novels (id, title, description, author, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.title, input.description, input.author, tags_json, now, now],
        )?;
        load_novel(conn, &id, &world_id)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "novel",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
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
        struct NovelRaw {
            id: String,
            title: String,
            description: String,
            author: String,
            tags_json: String,
            created_at: String,
            updated_at: String,
            has_image: bool,
        }
        let mut stmt = conn.prepare(
            "SELECT id, title, description, author, tags, created_at, updated_at, image_blob IS NOT NULL AS has_image
         FROM novels ORDER BY created_at",
        )?;
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
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
        "UPDATE novels SET title = ?1, description = ?2, author = ?3, tags = ?4, updated_at = ?5 WHERE id = ?6",
        params![input.title, input.description, input.author, tags_json, now, id],
    )?;
        if updated == 0 {
            return Err(DbError::NotFound("Novel", id.clone()));
        }
        load_novel(conn, &id, &world_id)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "novel",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM novels WHERE id = ?1", params![id])?;
        if deleted == 0 {
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
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();

    let result = state.with_world(&space_id, &world_id, |conn| {
        let tx = conn.transaction()?;

        let next_pos: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM chapters WHERE novel_id = ?1",
            params![&novel_id],
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
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "chapter",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
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
    let now = now_iso();

    let result = state.with_world(&space_id, &world_id, |conn| {
        let updated = conn.execute(
            "UPDATE chapters SET title = ?1, summary = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.title, input.summary, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Chapter", id.clone()));
        }
        load_chapter(conn, &id)
    });
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "chapter",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM chapters WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Chapter", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "chapter",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
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
    let result = state.with_world(&space_id, &world_id, |conn| {
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
    if result.is_ok() {
        emit_entity_changed(&app, "chapter", None, &space_id, Some(&world_id));
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
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    let now = now_iso();
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    let result = state.with_world(&space_id, &world_id, |conn| {
    let tx = conn.transaction()?;

    let next_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM scenes WHERE chapter_id = ?1",
            params![&chapter_id],
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
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "scene",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
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
    let now = now_iso();
    // Canonicalize timestamps; drop non-ISO values (ADR-0026 — strict ISO contract).
    let start_at = normalize_iso(&input.start_at);
    let end_at = normalize_iso(&input.end_at);

    let result = state.with_world(&space_id, &world_id, |conn| {
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
        return Err(DbError::NotFound("Scene", id.clone()));
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
    load_scene(conn, &id)
});
    if let Ok(ref entity) = result {
        emit_entity_changed(
            &app,
            "scene",
            Some(entity.id.clone()),
            &space_id,
            Some(&world_id),
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
    let result = state.with_world(&space_id, &world_id, |conn| {
        let deleted = conn.execute("DELETE FROM scenes WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Scene", id.clone()));
        }
        Ok(())
    });
    if result.is_ok() {
        emit_entity_changed(
            &app,
            "scene",
            Some(id.clone()),
            &space_id,
            Some(&world_id),
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
    let result = state.with_world(&space_id, &world_id, |conn| {
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
    if result.is_ok() {
        emit_entity_changed(&app, "scene", None, &space_id, Some(&world_id));
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
