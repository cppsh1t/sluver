use super::*;

// The compile-cache silently DROPS defs whose embedded package fails
// validation (degraded-but-alive beats panicking at Space-open). This
// test pins that the registry as shipped always compiles cleanly — if
// it ever fails, the fix belongs in the embedded resource, not here.

#[test]
fn official_registry_compiles_completely() {
    let all = compiled();
    assert_eq!(
        all.len(),
        OFFICIAL_SKILLS.len(),
        "every official skill def must compile (name match + valid package)"
    );
    // Compilation preserves registry order (nothing was silently
    // dropped) and every def carries at least one default role.
    let names: Vec<&str> = all.iter().map(|s| s.def.name).collect();
    let expected: Vec<&str> = OFFICIAL_SKILLS.iter().map(|d| d.name).collect();
    assert_eq!(names, expected, "compiled roster matches the registry");
    for skill in all {
        // The embedded package must round-trip through the same
        // validation as uploads (guaranteed by compiled() construction —
        // these assertions document the invariant and guard refactors).
        assert!(!skill.description.is_empty(), "description must parse non-empty");
        assert!(
            skill.entries.iter().any(|(p, _)| p == "SKILL.md"),
            "parsed entries must include SKILL.md"
        );
        assert!(
            skill.zip.len() <= 10 * 1024 * 1024,
            "embedded zip must respect the upload size ceiling"
        );
        assert!(
            !skill.def.default_roles.is_empty(),
            "an official skill must default onto at least one role"
        );
    }
}

#[test]
fn official_zip_uses_wrapper_dir_layout() {
    // Every built zip must land in the single-wrapper-dir layout that
    // parse_skill_zip accepts ({name}/SKILL.md at depth 2), and the
    // wrapper must be the def name.
    for skill in compiled() {
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(&skill.zip)).expect("open zip");
        let mut names: Vec<String> = Vec::new();
        for i in 0..archive.len() {
            let entry = archive.by_index(i).expect("entry");
            names.push(entry.name().to_string());
        }
        names.sort();
        assert_eq!(
            names,
            vec![format!("{}/SKILL.md", skill.def.name)],
            "exactly one entry: {{name}}/SKILL.md for {}",
            skill.def.name
        );
    }
}
