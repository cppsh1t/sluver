use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::character::CharacterRef;
use crate::models::novel::{
    Chapter, CreateChapterInput, CreateNovelInput, CreateSceneInput, Novel, Scene,
    UpdateChapterInput, UpdateNovelInput, UpdateSceneInput,
};
use crate::util::{new_id, now_iso};

// ─── helpers ────────────────────────────────────────────────────────────────

fn load_novel(
    conn: &rusqlite::Connection,
    id: &str,
    world_id: &str,
) -> Result<Novel, DbError> {
    let (title, description, tags_json, created_at, updated_at) = conn
        .query_row(
            "SELECT title, description, tags, created_at, updated_at FROM novels WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>("title")?,
                    row.get::<_, String>("description")?,
                    row.get::<_, String>("tags")?,
                    row.get::<_, String>("created_at")?,
                    row.get::<_, String>("updated_at")?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::NotFound("Novel", id.to_string()),
            other => DbError::Sqlite(other),
        })?;

    let chapter_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM chapters WHERE novel_id = ?1 ORDER BY position")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(Novel {
        id: id.to_string(),
        world_id: world_id.to_string(),
        title,
        description,
        chapter_ids,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        created_at,
        updated_at,
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
        let mut stmt = conn
            .prepare("SELECT id FROM scenes WHERE chapter_id = ?1 ORDER BY position")?;
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
        let mut stmt = conn
            .prepare("SELECT character_id, phase_id FROM scene_character_refs WHERE scene_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(CharacterRef {
                character_id: row.get(0)?,
                phase_id: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let item_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT item_id FROM scene_item_refs WHERE scene_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let event_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT event_id FROM scene_event_refs WHERE scene_id = ?1")?;
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
        created_at,
        updated_at,
    })
}

// ─── Novel CRUD ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_novel(
    world_id: String,
    input: CreateNovelInput,
    state: State<'_, DbManager>,
) -> Result<Novel, DbError> {
    let id = new_id();
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        conn.execute(
            "INSERT INTO novels (id, title, description, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, input.title, input.description, tags_json, now, now],
        )?;
        load_novel(conn, &id, &world_id)
    })
}

#[tauri::command]
pub fn get_novel(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Novel, DbError> {
    state.with_world(&world_id, |conn| load_novel(conn, &id, &world_id))
}

#[tauri::command]
pub fn list_novels(world_id: String, state: State<'_, DbManager>) -> Result<Vec<Novel>, DbError> {
    state.with_world(&world_id, |conn| {
        // (a) Batch-load ALL novel rows (raw fields, no chapter IDs yet).
        struct NovelRaw {
            id: String,
            title: String,
            description: String,
            tags_json: String,
            created_at: String,
            updated_at: String,
        }
        let mut stmt = conn.prepare(
            "SELECT id, title, description, tags, created_at, updated_at
             FROM novels ORDER BY created_at",
        )?;
        let raws: Vec<NovelRaw> = stmt
            .query_map([], |row| {
                Ok(NovelRaw {
                    id: row.get("id")?,
                    title: row.get("title")?,
                    description: row.get("description")?,
                    tags_json: row.get("tags")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
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
                Ok((row.get::<_, String>("novel_id")?, row.get::<_, String>("id")?))
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
                let tags: Vec<String> =
                    serde_json::from_str(&raw.tags_json).unwrap_or_default();
                Novel {
                    id: raw.id,
                    world_id: world_id.to_string(),
                    title: raw.title,
                    description: raw.description,
                    chapter_ids,
                    tags,
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                }
            })
            .collect();

        Ok(result)
    })
}

/// Batch-load all chapters of a novel (with scene IDs), avoiding N+1.
#[tauri::command]
pub fn list_chapters(
    world_id: String,
    novel_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Chapter>, DbError> {
    state.with_world(&world_id, |conn| {
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
#[tauri::command]
pub fn list_scenes(
    world_id: String,
    chapter_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Scene>, DbError> {
    state.with_world(&world_id, |conn| {
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

        // (e) Group refs by scene_id.
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

        // (f) Assemble results.
        let result: Vec<Scene> = raws
            .into_iter()
            .map(|raw| {
                let character_refs = char_map.remove(&raw.id).unwrap_or_default();
                let item_ids = item_map.remove(&raw.id).unwrap_or_default();
                let event_ids = event_map.remove(&raw.id).unwrap_or_default();
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
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                }
            })
            .collect();

        Ok(result)
    })
}

#[tauri::command]
pub fn update_novel(
    world_id: String,
    id: String,
    input: UpdateNovelInput,
    state: State<'_, DbManager>,
) -> Result<Novel, DbError> {
    let now = now_iso();
    let tags_json = serde_json::to_string(&input.tags)?;

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE novels SET title = ?1, description = ?2, tags = ?3, updated_at = ?4 WHERE id = ?5",
            params![input.title, input.description, tags_json, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Novel", id));
        }
        load_novel(conn, &id, &world_id)
    })
}

#[tauri::command]
pub fn delete_novel(world_id: String, id: String, state: State<'_, DbManager>) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM novels WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Novel", id));
        }
        Ok(())
    })
}

// ─── Chapter CRUD ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_chapter(
    world_id: String,
    novel_id: String,
    input: CreateChapterInput,
    state: State<'_, DbManager>,
) -> Result<Chapter, DbError> {
    let id = new_id();
    let now = now_iso();

    state.with_world(&world_id, |conn| {
        let tx = conn.transaction()?;

        let next_pos: i64 = tx
            .query_row(
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
    })
}

#[tauri::command]
pub fn get_chapter(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Chapter, DbError> {
    state.with_world(&world_id, |conn| load_chapter(conn, &id))
}

#[tauri::command]
pub fn update_chapter(
    world_id: String,
    id: String,
    input: UpdateChapterInput,
    state: State<'_, DbManager>,
) -> Result<Chapter, DbError> {
    let now = now_iso();

    state.with_world(&world_id, |conn| {
        let updated = conn.execute(
            "UPDATE chapters SET title = ?1, summary = ?2, updated_at = ?3 WHERE id = ?4",
            params![input.title, input.summary, now, id],
        )?;
        if updated == 0 {
            return Err(DbError::NotFound("Chapter", id));
        }
        load_chapter(conn, &id)
    })
}

#[tauri::command]
pub fn delete_chapter(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM chapters WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Chapter", id));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_chapters(
    world_id: String,
    novel_id: String,
    chapter_ids: Vec<String>,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
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
    })
}

// ─── Scene CRUD ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_scene(
    world_id: String,
    chapter_id: String,
    input: CreateSceneInput,
    state: State<'_, DbManager>,
) -> Result<Scene, DbError> {
    let id = new_id();
    let now = now_iso();

    state.with_world(&world_id, |conn| {
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
                input.start_at,
                input.end_at,
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

        tx.commit()?;
        load_scene(conn, &id)
    })
}

#[tauri::command]
pub fn get_scene(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<Scene, DbError> {
    state.with_world(&world_id, |conn| load_scene(conn, &id))
}

#[tauri::command]
pub fn update_scene(
    world_id: String,
    id: String,
    input: UpdateSceneInput,
    state: State<'_, DbManager>,
) -> Result<Scene, DbError> {
    let now = now_iso();

    state.with_world(&world_id, |conn| {
        let tx = conn.transaction()?;

        let affected = tx.execute(
            "UPDATE scenes SET title = ?1, summary = ?2, content = ?3, start_at = ?4, end_at = ?5, location_id = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                input.title,
                input.summary,
                input.content,
                input.start_at,
                input.end_at,
                input.location_id,
                now,
                id,
            ],
        )?;
        if affected == 0 {
            return Err(DbError::NotFound("Scene", id));
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

        tx.commit()?;
        load_scene(conn, &id)
    })
}

#[tauri::command]
pub fn delete_scene(
    world_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
        let deleted = conn.execute("DELETE FROM scenes WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(DbError::NotFound("Scene", id));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_scenes(
    world_id: String,
    chapter_id: String,
    scene_ids: Vec<String>,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    state.with_world(&world_id, |conn| {
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
    })
}
