use super::*;

/// Minimal schema covering the three prefilter shapes under test:
/// characters (aliases + tags), locations (macro-generated tags shape),
/// novels (title/author + tags).
fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                aliases TEXT NOT NULL, description TEXT NOT NULL,
                notes TEXT NOT NULL, tags TEXT NOT NULL);
             CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                description TEXT NOT NULL, notes TEXT NOT NULL, tags TEXT NOT NULL);
             CREATE TABLE novels (id TEXT PRIMARY KEY, title TEXT NOT NULL,
                description TEXT NOT NULL, author TEXT NOT NULL, tags TEXT NOT NULL);",
    )
    .unwrap();
    conn
}

fn find<'a>(groups: &'a [GrepMatchGroup], field: &str) -> Option<&'a GrepMatchGroup> {
    groups.iter().find(|g| g.field_name == field)
}

/// A query spanning a serde-escaped `"` inside an alias must still be
/// found: the stored JSON TEXT (`6\"9\" 身高`) does not contain the
/// literal `9" 身`, so only the `json_each` element prefilter can pass
/// the row through. This is the exact false-negative raw `LIKE` would
/// produce.
#[test]
fn json_prefilter_finds_queries_spanning_escaped_characters() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO characters (id, name, aliases, description, notes, tags)
             VALUES ('c1', '艾琳', '[\"6\\\"9\\\" 身高\"]', '', '', '[\"北境\"]')",
        [],
    )
    .unwrap();

    let query = "9\" 身";
    let groups = scan_characters(&conn, &like_pattern(query), &fold_ascii(query)).unwrap();

    let alias_group = find(&groups, "aliases").expect("escaped-quote alias must be found");
    assert_eq!(alias_group.match_count, 1);
    assert_eq!(alias_group.snippets[0].r#match, "6\"9\" 身高");
}

/// Tags match per ELEMENT across every table shape that carries them
/// (characters, the element macro via locations, novels) — including
/// when the plain-text columns of the same row do NOT match, proving
/// the json_each predicate is what selected the row.
#[test]
fn json_prefilter_matches_tag_elements_across_table_shapes() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO characters (id, name, aliases, description, notes, tags)
             VALUES ('c1', '艾琳', '[]', '', '', '[\"北境\", \"史诗\"]')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO locations (id, name, description, notes, tags)
             VALUES ('l1', '临冬城', '', '', '[\"北境\"]')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO novels (id, title, description, author, tags)
             VALUES ('n1', '冰与火', '', '', '[\"北境\"]')",
        [],
    )
    .unwrap();

    let query = "北境";
    let pat = like_pattern(query);
    let needle = fold_ascii(query);

    for groups in [
        scan_characters(&conn, &pat, &needle).unwrap(),
        scan_locations(&conn, &pat, &needle).unwrap(),
        scan_novels(&conn, &pat, &needle).unwrap(),
    ] {
        let tag_group = find(&groups, "tags").expect("tag element must be found");
        assert_eq!(tag_group.match_count, 1);
        assert_eq!(tag_group.snippets[0].r#match, "北境");
    }
}

/// Malformed / non-array JSON in a JSON column must degrade to "no
/// matches" — never error the statement (`json_valid` guard) and never
/// panic the Rust scan (`unwrap_or_default`) — while plain-text columns
/// on the same row keep working.
#[test]
fn malformed_json_columns_are_tolerated() {
    let conn = test_conn();
    conn.execute(
        "INSERT INTO locations (id, name, description, notes, tags)
             VALUES ('l1', '北境临冬城', '北境要塞', '', 'not json at all')",
        [],
    )
    .unwrap();

    let query = "北境";
    let groups = scan_locations(&conn, &like_pattern(query), &fold_ascii(query)).unwrap();

    // Row selected via its plain-text columns; the corrupt tags column
    // contributes no group and no error.
    assert!(find(&groups, "name").is_some());
    assert!(find(&groups, "description").is_some());
    assert!(find(&groups, "tags").is_none());
}

/// Offset pagination walks stable pages over the deterministic sort:
/// first page caps at 50 with `has_more`, the tail page lands exactly,
/// past-the-end and negative offsets degrade gracefully (ADR-0035 §5,
/// amended).
#[test]
fn paginate_slices_stable_pages() {
    let groups: Vec<GrepMatchGroup> = (0..60)
        .map(|i| GrepMatchGroup {
            entity_type: "location".to_string(),
            entity_id: format!("id{i:02}"),
            entity_title: format!("loc{i:02}"),
            character_id: None,
            character_name: None,
            field_name: "name".to_string(),
            match_count: 1,
            snippets: Vec::new(),
        })
        .collect();

    let (page, total, has_more) = paginate(groups.clone(), 0);
    assert_eq!((total, page.len(), has_more), (60, 50, true));
    assert_eq!(page[0].entity_id, "id00");
    assert_eq!(page[49].entity_id, "id49");

    let (page, total, has_more) = paginate(groups.clone(), 50);
    assert_eq!((total, page.len(), has_more), (60, 10, false));
    assert_eq!(page[0].entity_id, "id50");
    assert_eq!(page[9].entity_id, "id59");

    // Past the end: empty page, no more.
    let (page, _, has_more) = paginate(groups.clone(), 60);
    assert!((page.is_empty()) && !has_more);
    let (page, _, has_more) = paginate(groups.clone(), 9999);
    assert!((page.is_empty()) && !has_more);

    // Negative offset clamps to page 0.
    let (page, _, has_more) = paginate(groups, -5);
    assert_eq!(page.len(), 50);
    assert!(has_more);
    assert_eq!(page[0].entity_id, "id00");
}
