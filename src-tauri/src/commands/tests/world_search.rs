use super::*;
use crate::testutil::{make_space_with_world, uuid_shape, with_world, WorldFixture};

/// Needle matching 60 seeded rows — strictly more than one page.
const MANY_NEEDLE: &str = "剑";
/// Needle matching 7 seeded rows — strictly less than one page.
const FEW_NEEDLE: &str = "盾";
const MANY_ROWS: i64 = 60;
const FEW_ROWS: i64 = 7;

/// Deterministic row name/title: zero-padded so lexicographic ORDER BY
/// equals insert order, making page boundaries exactly assertable.
fn row_name(needle: &str, i: i64) -> String {
    format!("{needle} #{i:03}")
}

/// Insert `count` rows named `{needle} #{i:03}` into a name-shaped table
/// (`locations` / `items` / `lores` / `characters` / `events` — schema
/// defaults cover the non-essential columns). Direct SQL keeps 60-row
/// fixtures cheap; `id_base` separates the two needles' id ranges.
fn insert_named(fx: &WorldFixture, table: &str, needle: &str, count: i64, id_base: u64) {
    with_world(fx, |conn| {
        for i in 0..count {
            conn.execute(
                &format!(
                    "INSERT INTO {table} (id, name, created_at, updated_at)
                     VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
                ),
                params![uuid_shape(id_base + i as u64), row_name(needle, i)],
            )?;
        }
        Ok(())
    })
    .unwrap();
}

/// Novels carry `title` (not `name`); everything else matches the
/// name-shaped inserts.
fn insert_novels(fx: &WorldFixture, needle: &str, count: i64, id_base: u64) {
    with_world(fx, |conn| {
        for i in 0..count {
            conn.execute(
                "INSERT INTO novels (id, title, created_at, updated_at)
                 VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                params![uuid_shape(id_base + i as u64), row_name(needle, i)],
            )?;
        }
        Ok(())
    })
    .unwrap();
}

/// Chapters hang off one parent novel whose title deliberately contains
/// neither needle — search is global across the World, so a needle-carrying
/// sibling row would surface as a count mismatch. The parent title embeds
/// `id_base` because `novels.title` is UNIQUE and the helper runs twice
/// (once per needle).
fn insert_chapters(fx: &WorldFixture, needle: &str, count: i64, id_base: u64) {
    with_world(fx, |conn| {
        // Parent ids derive from `id_base` — the helper runs twice (once
        // per needle) inside ONE fixture, so fixed ids would collide.
        let novel_id = uuid_shape(900_000 + id_base);
        conn.execute(
            "INSERT INTO novels (id, title, created_at, updated_at)
             VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![novel_id, format!("卷一-{id_base}")],
        )?;
        for i in 0..count {
            conn.execute(
                "INSERT INTO chapters (id, novel_id, title, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                params![
                    uuid_shape(id_base + i as u64),
                    novel_id,
                    row_name(needle, i),
                    i
                ],
            )?;
        }
        Ok(())
    })
    .unwrap();
}

/// Scenes hang off one novel → chapter chain (both titles needle-free and
/// unique per seeding call — `novels.title` is UNIQUE).
fn insert_scenes(fx: &WorldFixture, needle: &str, count: i64, id_base: u64) {
    with_world(fx, |conn| {
        let novel_id = uuid_shape(900_000 + id_base);
        let chapter_id = uuid_shape(910_000 + id_base);
        conn.execute(
            "INSERT INTO novels (id, title, created_at, updated_at)
             VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![novel_id, format!("卷一-{id_base}")],
        )?;
        conn.execute(
            "INSERT INTO chapters (id, novel_id, title, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![chapter_id, novel_id, format!("第一章-{id_base}")],
        )?;
        for i in 0..count {
            conn.execute(
                "INSERT INTO scenes (id, chapter_id, title, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                params![
                    uuid_shape(id_base + i as u64),
                    chapter_id,
                    row_name(needle, i),
                    i
                ],
            )?;
        }
        Ok(())
    })
    .unwrap();
}

/// Exercise the four grep-aligned pagination semantics
/// (`commands/grep.rs::paginate`) against one freshly seeded `do_search_*`
/// core: `seed` populates the fixture with the two needle row sets, `search`
/// runs the core fn directly (no `State` / Tauri types — repo `do_*`
/// convention), `names` extracts row names/titles so ordering assertions
/// work across the different Summary shapes.
///
/// (a) matching rows < page size → single page, exact `total_count`,
///     `truncated = false`
/// (b) 60 matching rows → offset 0 returns 50 + `truncated = true` +
///     `total_count = 60`; offset 50 returns the remaining 10 without a
///     truncation flag
/// (c) offset past the end → empty results, `truncated = false`
/// (d) negative offset → clamped to page 0
fn assert_pagination<T>(
    seed: impl FnOnce(&WorldFixture),
    search: impl Fn(&DbManager, &str, &str, &str, i64) -> Result<SearchPage<T>, DbError>,
    names: impl Fn(&[T]) -> Vec<String>,
) {
    let fx = make_space_with_world();
    seed(&fx);
    let run = |needle: &str, offset: i64| {
        search(&fx.mgr, &fx.space_id, &fx.world_id, needle, offset).unwrap()
    };

    // (a) Sub-limit match set: one page carries everything.
    let page = run(FEW_NEEDLE, 0);
    assert_eq!(page.results.len(), FEW_ROWS as usize);
    assert_eq!(page.total_count, FEW_ROWS);
    assert!(!page.truncated);

    // (b) Over-limit match set: page 0 caps at DEFAULT_LIMIT with the FULL
    // count reported; page 1 lands the tail exactly and closes the walk.
    let page = run(MANY_NEEDLE, 0);
    assert_eq!(page.results.len(), DEFAULT_LIMIT as usize);
    assert_eq!(page.total_count, MANY_ROWS);
    assert!(page.truncated);
    assert_eq!(
        names(&page.results),
        (0..DEFAULT_LIMIT as i64)
            .map(|i| row_name(MANY_NEEDLE, i))
            .collect::<Vec<_>>()
    );

    let page = run(MANY_NEEDLE, DEFAULT_LIMIT as i64);
    assert_eq!(
        page.results.len(),
        (MANY_ROWS - DEFAULT_LIMIT as i64) as usize
    );
    assert_eq!(page.total_count, MANY_ROWS);
    assert!(!page.truncated);
    assert_eq!(
        names(&page.results),
        (DEFAULT_LIMIT as i64..MANY_ROWS)
            .map(|i| row_name(MANY_NEEDLE, i))
            .collect::<Vec<_>>()
    );

    // (c) Offset past the end: empty page, no more rows signalled.
    let page = run(MANY_NEEDLE, 9999);
    assert!(page.results.is_empty());
    assert_eq!(page.total_count, MANY_ROWS);
    assert!(!page.truncated);

    // (d) Negative offset clamps to page 0 (grep precedent: the model may
    // misremember its page position).
    let page = run(MANY_NEEDLE, -50);
    assert_eq!(page.results.len(), DEFAULT_LIMIT as usize);
    assert_eq!(page.total_count, MANY_ROWS);
    assert!(page.truncated);
    assert_eq!(
        names(&page.results).first(),
        Some(&row_name(MANY_NEEDLE, 0))
    );
}

// ─── macro-generated element commands ────────────────────────────────────────

#[test]
fn search_locations_paginates() {
    assert_pagination(
        |fx| {
            insert_named(fx, "locations", MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_named(fx, "locations", FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_locations,
        |rows: &[LocationSummary]| rows.iter().map(|s| s.name.clone()).collect(),
    );
}

#[test]
fn search_items_paginates() {
    assert_pagination(
        |fx| {
            insert_named(fx, "items", MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_named(fx, "items", FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_items,
        |rows: &[ItemSummary]| rows.iter().map(|s| s.name.clone()).collect(),
    );
}

#[test]
fn search_lores_paginates() {
    assert_pagination(
        |fx| {
            insert_named(fx, "lores", MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_named(fx, "lores", FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_lores,
        |rows: &[LoreSummary]| rows.iter().map(|s| s.name.clone()).collect(),
    );
}

// ─── handwritten commands ────────────────────────────────────────────────────

#[test]
fn search_characters_paginates() {
    assert_pagination(
        |fx| {
            insert_named(fx, "characters", MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_named(fx, "characters", FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_characters,
        |rows: &[CharacterSummary]| rows.iter().map(|s| s.name.clone()).collect(),
    );
}

#[test]
fn search_events_paginates() {
    assert_pagination(
        |fx| {
            insert_named(fx, "events", MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_named(fx, "events", FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_events,
        |rows: &[EventSummary]| rows.iter().map(|s| s.name.clone()).collect(),
    );
}

#[test]
fn search_novels_paginates() {
    assert_pagination(
        |fx| {
            insert_novels(fx, MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_novels(fx, FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_novels,
        |rows: &[NovelSummary]| rows.iter().map(|s| s.title.clone()).collect(),
    );
}

#[test]
fn search_chapters_paginates() {
    assert_pagination(
        |fx| {
            insert_chapters(fx, MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_chapters(fx, FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_chapters,
        |rows: &[ChapterSummary]| rows.iter().map(|s| s.title.clone()).collect(),
    );
}

#[test]
fn search_scenes_paginates() {
    assert_pagination(
        |fx| {
            insert_scenes(fx, MANY_NEEDLE, MANY_ROWS, 10_000);
            insert_scenes(fx, FEW_NEEDLE, FEW_ROWS, 20_000);
        },
        do_search_scenes,
        |rows: &[SceneSummary]| rows.iter().map(|s| s.title.clone()).collect(),
    );
}
