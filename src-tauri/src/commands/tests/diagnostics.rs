use super::*;

// ─── parse_log_date ────────────────────────────────────────────────────

#[test]
fn parse_log_date_accepts_canonical_name() {
    assert_eq!(
        parse_log_date("sluver.2026-07-25.log"),
        Some(NaiveDate::from_ymd_opt(2026, 7, 25).unwrap())
    );
}

#[test]
fn parse_log_date_rejects_non_matching_names() {
    assert!(parse_log_date("sluver-2026-07-25.log").is_none()); // dash, not dot
    assert!(parse_log_date("sluver.log").is_none()); // no date
    assert!(parse_log_date("random.txt").is_none());
    assert!(parse_log_date("sluver.2026-7-5.log").is_none()); // not zero-padded
    assert!(parse_log_date("sluver.2026-07-25.log.bak").is_none()); // extra ext
}

// ─── line_matches_space ────────────────────────────────────────────────

#[test]
fn line_matches_space_null_or_missing_keeps_line() {
    // Missing space_id field → cross-Space event, kept.
    let no_field = r#"{"msg":"boot","level":"info"}"#;
    assert!(line_matches_space(no_field, "space-1"));
    // null space_id → explicitly cross-Space, kept.
    let null_field = r#"{"msg":"boot","space_id":null}"#;
    assert!(line_matches_space(null_field, "space-1"));
}

#[test]
fn line_matches_space_matching_id_keeps_line() {
    let line = r#"{"msg":"open","space_id":"space-1"}"#;
    assert!(line_matches_space(line, "space-1"));
    assert!(!line_matches_space(line, "space-2"));
}

#[test]
fn line_matches_space_unparseable_keeps_line() {
    // Garbage in → kept defensively (never silently drop diagnostics).
    assert!(line_matches_space("not json at all", "space-1"));
    assert!(line_matches_space("{broken", "space-1"));
}

#[test]
fn line_matches_space_non_object_json_keeps_line() {
    // A bare JSON value (not an object) → kept defensively.
    assert!(line_matches_space("[1,2,3]", "space-1"));
    assert!(line_matches_space("\"string\"", "space-1"));
    assert!(line_matches_space("42", "space-1"));
}

// ─── DateRange deserialization ─────────────────────────────────────────

#[test]
fn date_range_all_deserializes() {
    let dr: DateRange = serde_json::from_str(r#"{"all":null}"#).expect("parse All");
    assert!(matches!(dr, DateRange::All));
}

#[test]
fn date_range_last24_hours_deserializes() {
    let dr: DateRange = serde_json::from_str(r#"{"last24Hours":null}"#).expect("parse Last24Hours");
    assert!(matches!(dr, DateRange::Last24Hours));
}

#[test]
fn date_range_last_n_days_deserializes() {
    let dr: DateRange =
        serde_json::from_str(r#"{"lastNDays":{"days":14}}"#).expect("parse LastNDays");
    match dr {
        DateRange::LastNDays { days } => assert_eq!(days, 14),
        other => panic!("expected LastNDays, got {other:?}"),
    }
}
