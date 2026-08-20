use super::*;

#[test]
fn parses_valid_log_filename() {
    assert_eq!(
        parse_log_date("sluver.2025-07-25.log"),
        Some(NaiveDate::from_ymd_opt(2025, 7, 25).unwrap())
    );
}

#[test]
fn rejects_unrelated_filenames() {
    assert!(parse_log_date("sluver-2025-07-25.log").is_none()); // dash, not dot
    assert!(parse_log_date("sluver.log").is_none()); // no date
    assert!(parse_log_date("2025-07-25.log").is_none()); // no prefix
    assert!(parse_log_date("sluver.2025-7-5.log").is_none()); // not zero-padded
    assert!(parse_log_date("random.txt").is_none());
    assert!(parse_log_date("sluver.2025-07-25.log.bak").is_none());
}

#[test]
fn logs_dir_appends_logs_subdir() {
    let p = std::path::Path::new("/tmp/sluver");
    assert_eq!(logs_dir(p), std::path::PathBuf::from("/tmp/sluver/logs"));
}

// ─── tier_to_filter (canonical tier → EnvFilter mapping) ────────────────

#[test]
fn tier_to_filter_maps_known_tiers() {
    assert_eq!(tier_to_filter(TIER_STANDARD), Some(DEFAULT_FILTER));
    assert_eq!(tier_to_filter(TIER_VERBOSE), Some("debug"));
    assert_eq!(
        tier_to_filter(TIER_VERY_VERBOSE),
        Some("trace,rusqlite=warn,reqwest=warn,hyper=warn,h2=warn")
    );
    // The standard tier aliases the bootstrap default exactly —
    // regression guard against silent drift.
    assert_eq!(tier_to_filter(TIER_STANDARD), Some("info,sluver=debug"));
}

#[test]
fn tier_to_filter_rejects_unknown_tier() {
    assert!(tier_to_filter("VERBOSE").is_none()); // case-sensitive
    assert!(tier_to_filter("").is_none());
    // Raw filter string, not a tier:
    assert!(tier_to_filter("trace").is_none());
    assert!(tier_to_filter("info,sluver=debug").is_none());
}
