use super::*;
use crate::testutil::{make_space_with_world, uuid_shape, WorldFixture};
use base64::Engine as _;
use std::io::Write as _;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

// ── fixtures ───────────────────────────────────────────────────────────

/// Insert an agent_config row directly — the fixture's space.db only
/// carries the migration-seeded `namer` / `vision`, and these tests
/// want deterministic ids.
fn seed_agent_config(fx: &WorldFixture, n: u64, name: &str) -> String {
    let id = uuid_shape(n);
    fx.mgr
        .with_space(&fx.space_id, |conn| {
            conn.execute(
                "INSERT INTO agent_configs (id, name, model_id, created_at, updated_at)
                     VALUES (?1, ?2, NULL, '2026-01-01T00:00:00.000Z',
                             '2026-01-01T00:00:00.000Z')",
                params![id, name],
            )?;
            Ok(())
        })
        .expect("seed agent config");
    id
}

/// Build a deflate zip in memory and return it base64-encoded (the
/// upload wire format).
fn zip_base64(files: &[(&str, &str)]) -> String {
    zip_base64_realistic(&[], files)
}

/// Like [`zip_base64`] but WITH explicit directory entries — the shape
/// every real-world archiver produces (Explorer, macOS Archive
/// Utility, `zip` CLI). `dirs` are raw entry names ending in '/'.
fn zip_base64_realistic(dirs: &[&str], files: &[(&str, &str)]) -> String {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for dir in dirs {
        zip.add_directory(*dir, options)
            .unwrap_or_else(|e| panic!("add_directory {dir}: {e}"));
    }
    for (name, content) in files {
        zip.start_file(*name, options)
            .unwrap_or_else(|e| panic!("start_file {name}: {e}"));
        zip.write_all(content.as_bytes()).expect("write entry");
    }
    let bytes = zip.finish().expect("finish zip").into_inner();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn skill_md(name: &str, description: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n\n# Instructions\n\nUse the force.\n"
    )
}

fn skills_root(fx: &WorldFixture) -> PathBuf {
    fx.mgr.space_data_dir(&fx.space_id).join("skills")
}

/// Upload + enable a standard two-file skill under `explorer`;
/// returns the skill summary.
fn upload_and_enable(fx: &WorldFixture, agent_config_id: &str) -> SkillSummary {
    let zip = zip_base64(&[
        ("SKILL.md", &skill_md("my-skill", "A test skill")),
        ("refs/style.md", "# Style\nBe terse."),
    ]);
    let summary = do_upload_skill(&fx.mgr, &fx.space_id, &zip).expect("upload");
    do_set_skill_enabled(&fx.mgr, &fx.space_id, agent_config_id, &summary.id, true)
        .expect("enable");
    summary
}

fn junction_count(fx: &WorldFixture, skill_id: &str) -> i64 {
    fx.mgr
        .with_space(&fx.space_id, |conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM agent_config_skills WHERE skill_id = ?1",
                params![skill_id],
                |r| r.get(0),
            )?)
        })
        .expect("count junction rows")
}

// ── upload ─────────────────────────────────────────────────────────────

#[test]
fn upload_skill_root_layout_persists_row() {
    let fx = make_space_with_world();
    let summary = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[
            ("SKILL.md", &skill_md("my-skill", "A test skill")),
            ("refs/style.md", "# Style\nBe terse."),
        ]),
    )
    .expect("upload");
    assert_eq!(summary.name, "my-skill");
    assert_eq!(summary.description, "A test skill");
    assert!(!summary.id.is_empty());

    let list = do_list_skills(&fx.mgr, &fx.space_id).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, summary.id);
    assert_eq!(list[0].name, "my-skill");

    // NO disk materialization on upload — install happens only via
    // set_skill_enabled (ADR-0043 §1/§2).
    assert!(!skills_root(&fx).join("my-skill").exists());
}

#[test]
fn upload_skill_accepts_single_wrapper_dir() {
    let fx = make_space_with_world();
    let summary = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[
            ("my-skill/SKILL.md", &skill_md("my-skill", "Wrapped skill")),
            ("my-skill/refs/a.md", "A"),
        ]),
    )
    .expect("upload");
    // Name comes from the FRONTMATTER, not the directory.
    assert_eq!(summary.name, "my-skill");
    assert_eq!(summary.description, "Wrapped skill");
}

#[test]
fn upload_skill_rejects_missing_skill_md() {
    let fx = make_space_with_world();
    let err = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[("README.md", "no skill here")]),
    )
    .expect_err("must reject");
    assert!(matches!(err, DbError::SkillPackageInvalid(_)));
}

#[test]
fn upload_skill_rejects_missing_description() {
    let fx = make_space_with_world();
    let md = "---\nname: my-skill\n---\nbody\n";
    let err = do_upload_skill(&fx.mgr, &fx.space_id, &zip_base64(&[("SKILL.md", md)]))
        .expect_err("must reject");
    assert!(matches!(err, DbError::SkillPackageInvalid(_)));
}

#[test]
fn upload_skill_rejects_bad_names() {
    let fx = make_space_with_world();
    let too_long = "x".repeat(65);
    for bad in [
        "My-Skill",
        "my_skill",
        "-leading",
        "my space",
        too_long.as_str(),
    ] {
        let err = do_upload_skill(
            &fx.mgr,
            &fx.space_id,
            &zip_base64(&[("SKILL.md", &skill_md(bad, "desc"))]),
        )
        .expect_err("invalid frontmatter name must be rejected");
        assert!(matches!(err, DbError::SkillPackageInvalid(_)), "{bad:?}");
    }
}

#[test]
fn upload_skill_rejects_empty_description() {
    let fx = make_space_with_world();
    for desc in ["''", "'   '"] {
        let md = format!("---\nname: my-skill\ndescription: {desc}\n---\nbody\n");
        let err = do_upload_skill(&fx.mgr, &fx.space_id, &zip_base64(&[("SKILL.md", &md)]))
            .expect_err("empty description must be rejected");
        assert!(matches!(err, DbError::SkillPackageInvalid(_)), "{desc}");
    }
}

#[test]
fn upload_skill_rejects_oversize_description() {
    let fx = make_space_with_world();
    let long = "a".repeat(1025);
    let md = format!("---\nname: my-skill\ndescription: {long}\n---\nbody\n");
    let err = do_upload_skill(&fx.mgr, &fx.space_id, &zip_base64(&[("SKILL.md", &md)]))
        .expect_err("must reject");
    assert!(matches!(err, DbError::SkillPackageInvalid(_)));
}

#[test]
fn upload_skill_duplicate_name_hits_unique_constraint() {
    let fx = make_space_with_world();
    do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[("SKILL.md", &skill_md("my-skill", "first"))]),
    )
    .expect("first upload");
    let err = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[("SKILL.md", &skill_md("my-skill", "second"))]),
    )
    .expect_err("duplicate must reject");
    match err {
        DbError::Sqlite(e) => {
            assert!(e.to_string().contains("UNIQUE"), "got: {e}");
        }
        other => panic!("expected raw Sqlite constraint violation, got {other:?}"),
    }
}

#[test]
fn upload_skill_rejects_zip_slip_entry() {
    let fx = make_space_with_world();
    let err = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[
            ("SKILL.md", &skill_md("my-skill", "Evil")),
            ("../evil.txt", "escaped"),
        ]),
    )
    .expect_err("zip-slip must reject");
    match err {
        DbError::SkillPackageInvalid(reason) => {
            assert!(reason.contains("zip-slip"), "reason: {reason}");
        }
        other => panic!("expected SkillPackageInvalid, got {other:?}"),
    }
    // And nothing escaped next to the skills root.
    assert!(!fx
        .mgr
        .space_data_dir(&fx.space_id)
        .join("evil.txt")
        .exists());
}

#[test]
fn upload_skill_rejects_backslash_traversal_entry() {
    // `enclosed_name` only treats `\` as a path separator on Windows;
    // on Unix this entry passes the zip-crate guard as a single
    // Normal component and must be caught by the post-normalization
    // `..` re-check. Asserts the variant only, so it guards both
    // platforms.
    let fx = make_space_with_world();
    let err = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[
            ("SKILL.md", &skill_md("my-skill", "Evil")),
            ("my-skill\\..\\..\\evil.txt", "escaped"),
        ]),
    )
    .expect_err("backslash zip-slip must reject");
    assert!(matches!(err, DbError::SkillPackageInvalid(_)));
    assert!(!fx
        .mgr
        .space_data_dir(&fx.space_id)
        .join("evil.txt")
        .exists());
}

// ── enable / disable ──────────────────────────────────────────────────

#[test]
fn enable_skill_writes_junction_and_extracts_files() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    let summary = upload_and_enable(&fx, &ac);

    assert_eq!(junction_count(&fx, &summary.id), 1);

    let root = skills_root(&fx);
    assert!(root.join("my-skill").join("SKILL.md").exists());
    assert!(root.join("my-skill").join("refs").join("style.md").exists());

    // Catalog lookup by config name.
    let enabled = do_list_enabled_skills(&fx.mgr, &fx.space_id, "explorer").expect("list enabled");
    assert_eq!(enabled.len(), 1);
    assert_eq!(enabled[0].id, summary.id);
    assert_eq!(enabled[0].name, "my-skill");
    assert_eq!(enabled[0].description, "A test skill");

    // Unknown config name → benign empty Vec.
    assert!(do_list_enabled_skills(&fx.mgr, &fx.space_id, "ghost")
        .expect("ghost list")
        .is_empty());
}

#[test]
fn enable_skill_strips_wrapper_dir_on_install() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    let zip = zip_base64(&[
        ("my-skill/SKILL.md", &skill_md("my-skill", "Wrapped")),
        ("my-skill/refs/a.md", "A"),
    ]);
    let summary = do_upload_skill(&fx.mgr, &fx.space_id, &zip).expect("upload");
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true).expect("enable");
    // The wrapper prefix is stripped: files land directly under
    // skills/my-skill/, NOT skills/my-skill/my-skill/.
    assert!(skills_root(&fx)
        .join("my-skill")
        .join("refs")
        .join("a.md")
        .exists());
    assert!(!skills_root(&fx).join("my-skill").join("my-skill").exists());
}

#[test]
fn double_enable_is_idempotent_and_replaces_dir() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    let summary = upload_and_enable(&fx, &ac);

    // Simulate drift: the model edited a file via shell (disk is
    // truth — such edits persist until re-installation, ADR-0043).
    let drifted = skills_root(&fx)
        .join("my-skill")
        .join("refs")
        .join("style.md");
    std::fs::write(&drifted, "drifted").expect("drift");

    // Re-enable → idempotent reinstall from the stored zip.
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true).expect("second enable");
    assert_eq!(
        junction_count(&fx, &summary.id),
        1,
        "no duplicate junction row"
    );
    let restored = std::fs::read_to_string(&drifted).expect("read restored");
    assert_eq!(restored, "# Style\nBe terse.");
}

#[test]
fn enable_requires_existing_agent_config_and_skill() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    let zip = zip_base64(&[("SKILL.md", &skill_md("my-skill", "A test skill"))]);
    let summary = do_upload_skill(&fx.mgr, &fx.space_id, &zip).expect("upload");

    // Ghost agent config → AgentConfigNotFound.
    let err = do_set_skill_enabled(&fx.mgr, &fx.space_id, &uuid_shape(99), &summary.id, true)
        .expect_err("ghost agent config");
    match err {
        DbError::AgentConfigNotFound(id) => assert_eq!(id, uuid_shape(99)),
        other => panic!("expected AgentConfigNotFound, got {other:?}"),
    }

    // Ghost skill → SkillNotFound.
    let err = do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &uuid_shape(98), true)
        .expect_err("ghost skill");
    match err {
        DbError::SkillNotFound(id) => assert_eq!(id, uuid_shape(98)),
        other => panic!("expected SkillNotFound, got {other:?}"),
    }
}

#[test]
fn disable_removes_junction_and_dir_only_when_last_enablement_goes() {
    let fx = make_space_with_world();
    let ac1 = seed_agent_config(&fx, 7, "explorer");
    let ac2 = seed_agent_config(&fx, 8, "writer");
    let summary = upload_and_enable(&fx, &ac1);
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac2, &summary.id, true).expect("enable writer");
    let dir = skills_root(&fx).join("my-skill");
    assert!(dir.exists());

    // Disable ONE → dir REMAINS (writer still enables the skill).
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac1, &summary.id, false)
        .expect("disable explorer");
    assert!(
        dir.exists(),
        "dir must remain while another agent config still enables the skill"
    );
    assert_eq!(junction_count(&fx, &summary.id), 1);

    // Disable the LAST → junction gone + dir gone.
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac2, &summary.id, false).expect("disable writer");
    assert!(!dir.exists());
    assert_eq!(junction_count(&fx, &summary.id), 0);

    // Disabling again is a benign no-op (0 affected is NOT an error).
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac2, &summary.id, false).expect("disable again");
}

#[test]
fn enable_install_failure_leaves_no_phantom_junction_row() {
    // Ordering contract: install happens BEFORE the junction insert,
    // so a failed install must never leave the skill recorded as
    // enabled (a phantom row would flip the dialog Switch ON and make
    // activate_skill fail with SKILL_NOT_INSTALLED at runtime).
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    // Upload a valid skill, then corrupt its stored blob so the
    // re-validating installer fails at ENABLE time.
    let summary = do_upload_skill(
        &fx.mgr,
        &fx.space_id,
        &zip_base64(&[("SKILL.md", &skill_md("my-skill", "A test skill"))]),
    )
    .expect("upload");
    fx.mgr
        .with_space(&fx.space_id, |conn| {
            conn.execute(
                "UPDATE skills SET package = ?1 WHERE id = ?2",
                params![vec![0u8, 1, 2], summary.id],
            )?;
            Ok(())
        })
        .expect("corrupt blob");

    let err = do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
        .expect_err("install must fail on the corrupted blob");
    assert!(matches!(err, DbError::SkillPackageInvalid(_)));

    // No phantom-enabled row anywhere, nothing materialized on disk.
    assert_eq!(junction_count(&fx, &summary.id), 0);
    assert!(do_list_enabled_skills(&fx.mgr, &fx.space_id, "explorer")
        .expect("list enabled")
        .is_empty());
    assert!(!skills_root(&fx).join("my-skill").exists());

    // Repairing the blob makes enable succeed normally (store DECODED
    // bytes — the package column holds the raw zip, not base64).
    fx.mgr
        .with_space(&fx.space_id, |conn| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(zip_base64(&[("SKILL.md", &skill_md("my-skill", "Fixed"))]))
                .expect("decode zip");
            conn.execute(
                "UPDATE skills SET package = ?1, description = 'Fixed' WHERE id = ?2",
                params![bytes, summary.id],
            )?;
            Ok(())
        })
        .expect("restore blob");
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
        .expect("enable after repair");
    assert_eq!(junction_count(&fx, &summary.id), 1);
    assert!(skills_root(&fx).join("my-skill").join("SKILL.md").exists());
}

// ── delete ─────────────────────────────────────────────────────────────

#[test]
fn delete_skill_removes_row_junction_and_dir() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    let summary = upload_and_enable(&fx, &ac);

    do_delete_skill(&fx.mgr, &fx.space_id, &summary.id).expect("delete");
    assert!(do_list_skills(&fx.mgr, &fx.space_id)
        .expect("list")
        .is_empty());
    assert_eq!(junction_count(&fx, &summary.id), 0);
    assert!(!skills_root(&fx).join("my-skill").exists());

    // Deleting again → SkillNotFound.
    let err = do_delete_skill(&fx.mgr, &fx.space_id, &summary.id).expect_err("ghost delete");
    match err {
        DbError::SkillNotFound(id) => assert_eq!(id, summary.id),
        other => panic!("expected SkillNotFound, got {other:?}"),
    }
}

// ── read entry / file ──────────────────────────────────────────────────

#[test]
fn read_skill_entry_and_file_roundtrip_after_install() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 7, "explorer");
    let zip = zip_base64(&[
        ("SKILL.md", &skill_md("my-skill", "A test skill")),
        ("refs/style.md", "# Style\nBe terse."),
        ("refs/deep/nested.md", "deep"),
    ]);
    let summary = do_upload_skill(&fx.mgr, &fx.space_id, &zip).expect("upload");
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true).expect("enable");

    let entry = do_read_skill_entry(&fx.mgr, &fx.space_id, "my-skill").expect("entry");
    // Body = everything after the closing frontmatter delimiter.
    assert_eq!(entry.body, "\n# Instructions\n\nUse the force.\n");
    // Bundled files EXCLUDE SKILL.md, use forward slashes, sorted.
    assert_eq!(entry.files, vec!["refs/deep/nested.md", "refs/style.md"]);

    let file = do_read_skill_file(&fx.mgr, &fx.space_id, "my-skill", "refs/style.md")
        .expect("read file")
        .expect("file exists");
    assert_eq!(file, "# Style\nBe terse.");
    let nested = do_read_skill_file(&fx.mgr, &fx.space_id, "my-skill", "refs/deep/nested.md")
        .expect("read nested")
        .expect("nested exists");
    assert_eq!(nested, "deep");

    // Missing file → None; traversal / absolute / drive paths → None.
    for bad in [
        "nope.md",
        "../evil.txt",
        "refs/../../escape.txt",
        "/etc/passwd",
        "C:/Windows/system32/config",
    ] {
        assert!(
            do_read_skill_file(&fx.mgr, &fx.space_id, "my-skill", bad)
                .expect("read must not error")
                .is_none(),
            "path {bad:?} must resolve to None"
        );
    }
    // Nothing escaped via the traversal attempts.
    assert!(!fx
        .mgr
        .space_data_dir(&fx.space_id)
        .join("escape.txt")
        .exists());

    // Not-installed skill → SkillNotInstalled.
    let err = do_read_skill_entry(&fx.mgr, &fx.space_id, "ghost").expect_err("ghost entry");
    match err {
        DbError::SkillNotInstalled(n) => assert_eq!(n, "ghost"),
        other => panic!("expected SkillNotInstalled, got {other:?}"),
    }
    // Invalid name charset → rejected before any path join.
    let err = do_read_skill_entry(&fx.mgr, &fx.space_id, "../evil").expect_err("traversal name");
    assert!(matches!(err, DbError::SkillNotInstalled(_)));
    assert!(
        do_read_skill_file(&fx.mgr, &fx.space_id, "../evil", "SKILL.md")
            .expect("lenient path")
            .is_none()
    );
}

// ── pure helpers ───────────────────────────────────────────────────────

#[test]
fn strip_frontmatter_variants() {
    let with = "---\nname: x\ndescription: y\n---\nbody\n";
    assert_eq!(strip_frontmatter(with), "body\n");
    let no_closing = "---\nname: x\nbody";
    assert_eq!(strip_frontmatter(no_closing), no_closing);
    let no_opening = "just body\n";
    assert_eq!(strip_frontmatter(no_opening), "just body\n");
    let crlf = "---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n";
    assert_eq!(strip_frontmatter(crlf), "body\r\n");
}

#[test]
fn skill_name_charset() {
    let max = "x".repeat(64);
    let over = "x".repeat(65);
    for good in ["a", "0", "my-skill", "a1-b2", "abc-", max.as_str()] {
        assert!(is_valid_skill_name(good), "{good:?} must be valid");
    }
    for bad in [
        "",
        "A",
        "-abc",
        "my_skill",
        "my space",
        "my/skill",
        over.as_str(),
        // Windows reserved device names (charset-valid but
        // un-creatable as Win32 directories).
        "con",
        "nul",
        "aux",
        "com1",
        "lpt9",
    ] {
        assert!(!is_valid_skill_name(bad), "{bad:?} must be invalid");
    }
}

// ── install: real-world archive shapes ─────────────────────────────────

// Regression (user-reported os error 3): zips with EXPLICIT directory
// entries. `enclosed_name()` normalizes away the trailing '/', so a
// name-based dir-marker check never fires — dir entries were extracted
// as 0-byte "files", and the top-level wrapper marker stripped down to
// the EMPTY relative path, i.e. a write onto the extraction root
// itself (`fs::write` on a trailing-separator path → os error 3 on
// Windows). The fix records `is_dir()` from the raw entry in pass 1.
#[test]
fn enable_installs_realistic_zip_with_dir_entries() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 1, "explorer");
    // Exactly the shape of the user's captured archive: wrapper dir
    // marker, nested dir marker, files beneath them.
    let zip = zip_base64_realistic(
        &["realistic-skill/", "realistic-skill/references/"],
        &[
            (
                "realistic-skill/SKILL.md",
                &skill_md("realistic-skill", "A realistic skill"),
            ),
            ("realistic-skill/references/techniques.md", "T"),
            ("realistic-skill/references/vocabulary.md", "V"),
        ],
    );
    let summary = do_upload_skill(&fx.mgr, &fx.space_id, &zip).expect("upload");
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
        .expect("enable realistic zip");

    let root = skills_root(&fx).join("realistic-skill");
    assert!(root.join("SKILL.md").is_file(), "SKILL.md installed");
    assert!(root.join("references/techniques.md").is_file());
    assert!(root.join("references/vocabulary.md").is_file());
    let mut installed: Vec<String> = Vec::new();
    collect_files(&root, Path::new(""), &mut installed).expect("collect");
    installed.sort();
    assert_eq!(
        installed,
        vec![
            "SKILL.md".to_string(),
            "references/techniques.md".to_string(),
            "references/vocabulary.md".to_string(),
        ],
        "exactly the three real files, no marker residue"
    );
    // And the runtime read surface works over the installed copy.
    let entry = do_read_skill_entry(&fx.mgr, &fx.space_id, "realistic-skill").expect("read entry");
    assert_eq!(
        entry.files,
        vec!["references/techniques.md", "references/vocabulary.md"]
    );
}

// Root-layout variant of the same archive shape (no wrapper dir):
// dir markers at the archive root must not become 0-byte files at
// the install root either.
#[test]
fn enable_installs_realistic_root_layout_zip() {
    let fx = make_space_with_world();
    let ac = seed_agent_config(&fx, 1, "explorer");
    let zip = zip_base64_realistic(
        &["refs/"],
        &[
            ("SKILL.md", &skill_md("root-skill", "Root layout")),
            ("refs/style.md", "S"),
        ],
    );
    let summary = do_upload_skill(&fx.mgr, &fx.space_id, &zip).expect("upload");
    do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
        .expect("enable realistic root zip");
    let root = skills_root(&fx).join("root-skill");
    assert!(root.join("SKILL.md").is_file());
    assert!(root.join("refs/style.md").is_file());
    let mut installed: Vec<String> = Vec::new();
    collect_files(&root, Path::new(""), &mut installed).expect("collect");
    installed.sort();
    assert_eq!(
        installed,
        vec!["SKILL.md".to_string(), "refs/style.md".to_string()]
    );
}
