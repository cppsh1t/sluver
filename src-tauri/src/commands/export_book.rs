//! `export_novel` IPC command — aggregates a full Novel tree (novel row +
//! chapters + scenes + scene images + cover) from the world DB inside a single
//! `with_world` closure, then hands the in-memory tree to the pure generators
//! in [`crate::export`] (`generate_txt` / `generate_epub`) and writes the file
//! to disk.
//!
//! Mirrors [`crate::commands::diagnostics::export_logs`]: the DB lock is held
//! only for the aggregation step (released before any file I/O), all fallible
//! paths map to [`DbError`], and the success log carries only structural
//! metadata (format, counts, bytes, duration) — NEVER creative content (title,
//! author, description, prose, summary) per AGENTS.md's "❌ NEVER log" red line.
//!
//! # Column nullability
//!
//! - `novels.image_blob` / `novels.image_mime` (WORLD_MIGRATION_006) are
//!   **nullable** (`ALTER TABLE ADD COLUMN` without `NOT NULL`) → read as
//!   `Option<Vec<u8>>` / `Option<String>`. The cover is `Some` iff BOTH are
//!   present.
//! - `scene_images.image_blob` / `scene_images.image_mime` (WORLD_MIGRATION_008)
//!   are `NOT NULL` → read as `Vec<u8>` / `String` directly.

use std::collections::HashMap;
use std::io::{BufWriter, Write};

use rusqlite::params;
use serde::Deserialize;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::export::{
    CoverImage, ExportedChapter, ExportedImage, ExportedNovel, ExportedScene,
};

// ─── ExportFormat ───────────────────────────────────────────────────────────

/// Output format for [`export_novel`]. Serde's externally-tagged enum
/// representation serializes unit variants as a **bare string** — so the
/// frontend sends `"epub"` or `"txt"` (not `{"epub": null}`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Epub,
    Txt,
}

impl ExportFormat {
    /// Lowercase wire form, matching the frontend IPC string. Use this in
    /// log fields so Rust and TypeScript emit the same value (ADR-0016).
    fn as_str(&self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Txt => "txt",
        }
    }
}

// ─── export_novel command ───────────────────────────────────────────────────

/// Aggregate the full novel tree and write it to `output_path` as TXT or EPUB.
///
/// Flow (mirrors `commands::diagnostics::export_logs`):
///   1. Load the full [`ExportedNovel`] tree inside ONE `with_world` closure —
///      the DB lock is released before any file I/O.
///   2. Dispatch on `format`:
///      - `Txt` → [`crate::export::generate_txt`] → `std::fs::write`.
///      - `Epub` → [`crate::export::generate_epub`] into a `BufWriter<File>`.
///   3. On success, emit `tracing::info!("novel.exported", …)` with structural
///      metadata only (format, chapter/scene counts, byte size, duration).
///
/// # Logging (ADR-0014 / ADR-0016)
///
/// Only structural metadata is ever logged. Title, author, description, scene
/// prose, and chapter summaries are creative content (AGENTS.md "❌ NEVER log"
/// tier) and never appear in any field.
#[tracing::instrument(skip(state), fields(entity_id = %novel_id))]
#[tauri::command]
pub fn export_novel(
    space_id: String,
    world_id: String,
    novel_id: String,
    format: ExportFormat,
    output_path: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    let start = std::time::Instant::now();

    // (1) Aggregate inside a single DB closure; the lock is released before
    // any file I/O begins. `with_world` takes a `FnOnce(&mut Connection)`;
    // `load_exported_novel` accepts `&Connection` (Rust auto-reborrows).
    let novel_data = state.with_world(&space_id, &world_id, |conn| {
        load_exported_novel(conn, &novel_id)
    })?;

    let chapter_count = novel_data.chapters.len();
    let scene_count: usize = novel_data.chapters.iter().map(|c| c.scenes.len()).sum();

    // (2) Render + write. The pure generators don't touch the DB.
    // On any failure, remove the partial output file so the user never
    // finds a truncated/unreadable file at their chosen path.
    let render_result = match format {
        ExportFormat::Txt => {
            let text = crate::export::generate_txt(&novel_data);
            std::fs::write(&output_path, text.as_bytes())
                .map_err(|e| DbError::NovelExportFailed(format!("write file: {e}")))
        }
        ExportFormat::Epub => {
            let file = std::fs::File::create(&output_path)
                .map_err(|e| DbError::NovelExportFailed(format!("create file: {e}")))?;
            let mut writer = BufWriter::new(file);
            crate::export::generate_epub(&novel_data, &mut writer)
                .map_err(|e| DbError::NovelExportFailed(format!("epub generation: {e}")))?;
            writer
                .flush()
                .map_err(|e| DbError::NovelExportFailed(format!("flush: {e}")))
        }
    };
    if let Err(e) = render_result {
        let _ = std::fs::remove_file(&output_path);
        return Err(e);
    }

    // (3) Success — structural metadata only (AGENTS.md red line).
    let output_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let duration_ms = start.elapsed().as_millis();
    tracing::info!(
        format = format.as_str(),
        chapter_count,
        scene_count,
        output_bytes,
        duration_ms,
        "novel.exported"
    );

    Ok(())
}

// ─── load_exported_novel helper ─────────────────────────────────────────────

/// Aggregate the full novel tree into an [`ExportedNovel`] for the pure
/// generators. Runs inside a single `with_world` closure so all rows come from
/// one connection; the lock is released before file I/O begins.
///
/// Ordering: chapters by `position`, scenes by `position` within each chapter,
/// `scene_images` by `position` within each scene.
///
/// Batch strategy (mirrors `list_chapters` / `list_scenes` in
/// `commands/novel.rs`): chapters in one query, ALL scenes for those chapters
/// in one `IN (...)` query grouped by `chapter_id`, ALL scene_images for those
/// scenes in one `IN (...)` query grouped by `scene_id`. Three SQL round-trips
/// total, regardless of novel size.
fn load_exported_novel(
    conn: &rusqlite::Connection,
    novel_id: &str,
) -> Result<ExportedNovel, DbError> {
    // (a) Novel row + cover. `image_blob` / `image_mime` are nullable
    //     (WORLD_MIGRATION_006) → read as Option. Cover is Some iff BOTH are
    //     present.
    let (title, author, description, cover) = conn
        .query_row(
            "SELECT title, author, description, image_blob, image_mime
             FROM novels WHERE id = ?1",
            params![novel_id],
            |row| {
                let title: String = row.get(0)?;
                let author: String = row.get(1)?;
                let description: String = row.get(2)?;
                let blob: Option<Vec<u8>> = row.get(3)?;
                let mime: Option<String> = row.get(4)?;
                // Only build a cover when both halves are present; a lone
                // blob/mime pair would be malformed data and the EPUB
                // renderer needs both anyway.
                let cover = blob.and_then(|bytes| {
                    mime.map(|m| CoverImage { bytes, mime: m })
                });
                Ok((title, author, description, cover))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DbError::NotFound("Novel", novel_id.to_string())
            }
            other => DbError::Sqlite(other),
        })?;

    // (b) Chapters (ordered by position).
    let chapter_rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, title FROM chapters WHERE novel_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![novel_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // Early return for a chapter-less novel — the batch `IN ()` queries below
    // would be invalid SQL with an empty placeholder list.
    if chapter_rows.is_empty() {
        return Ok(ExportedNovel {
            title,
            author,
            description,
            chapters: Vec::new(),
            cover,
        });
    }

    // (c) Batch-load scenes for ALL chapters in one query, grouped by
    //     chapter_id (mirrors `list_chapters` in commands/novel.rs).
    let chapter_ids: Vec<String> = chapter_rows.iter().map(|(id, _)| id.clone()).collect();
    let placeholders = (1..=chapter_ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let scenes_sql = format!(
        "SELECT chapter_id, id, content FROM scenes WHERE chapter_id IN ({placeholders}) ORDER BY position"
    );
    let mut sc_stmt = conn.prepare(&scenes_sql)?;
    let all_scenes: Vec<(String, String, String)> = sc_stmt
        .query_map(rusqlite::params_from_iter(chapter_ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?, // chapter_id
                row.get::<_, String>(1)?, // scene_id
                row.get::<_, String>(2)?, // content
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut scenes_by_chapter: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (ch_id, sc_id, content) in all_scenes {
        scenes_by_chapter
            .entry(ch_id)
            .or_default()
            .push((sc_id, content));
    }

    // (d) Batch-load scene_images for ALL scenes in one query, grouped by
    //     scene_id. `image_blob` / `image_mime` are NOT NULL here
    //     (WORLD_MIGRATION_008) → read as owned values, not Option.
    let all_scene_ids: Vec<String> = scenes_by_chapter
        .values()
        .flat_map(|v| v.iter().map(|(sid, _)| sid.clone()))
        .collect();

    let mut images_by_scene: HashMap<String, Vec<ExportedImage>> = HashMap::new();
    if !all_scene_ids.is_empty() {
        let img_placeholders = (1..=all_scene_ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let images_sql = format!(
            "SELECT scene_id, image_blob, image_mime FROM scene_images WHERE scene_id IN ({img_placeholders}) ORDER BY position"
        );
        let mut img_stmt = conn.prepare(&images_sql)?;
        let all_images: Vec<(String, Vec<u8>, String)> = img_stmt
            .query_map(rusqlite::params_from_iter(all_scene_ids.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,  // scene_id
                    row.get::<_, Vec<u8>>(1)?, // image_blob (NOT NULL)
                    row.get::<_, String>(2)?,  // image_mime (NOT NULL)
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        for (scene_id, bytes, mime) in all_images {
            images_by_scene
                .entry(scene_id)
                .or_default()
                .push(ExportedImage { bytes, mime });
        }
    }

    // (e) Assemble the ExportedNovel, preserving chapter order. The
    //     `scenes_by_chapter` / `images_by_scene` maps are drained in
    //     chapter/scene order so the result is fully ordered without a
    //     separate sort pass.
    let chapters: Vec<ExportedChapter> = chapter_rows
        .into_iter()
        .map(|(ch_id, ch_title)| {
            let scene_pairs = scenes_by_chapter.remove(&ch_id).unwrap_or_default();
            let scenes: Vec<ExportedScene> = scene_pairs
                .into_iter()
                .map(|(sc_id, content)| {
                    let images = images_by_scene.remove(&sc_id).unwrap_or_default();
                    ExportedScene { content, images }
                })
                .collect();
            ExportedChapter {
                title: ch_title,
                scenes,
            }
        })
        .collect();

    Ok(ExportedNovel {
        title,
        author,
        description,
        chapters,
        cover,
    })
}
