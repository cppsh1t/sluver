// Official skills (ADR-0055, amending ADR-0043).
//
// Official skills are Anthropic-format skill packages that ship WITH the
// app: embedded at compile time via `include_str!`, seeded into every
// Space's `skills` table at connection open, default-enabled on their
// designated agent roles, protected from deletion, and their names are
// reserved against user uploads. The user keeps full per-role enable
// control (default-on ≠ locked-on) — toggling an official skill off for
// a role is the normal `set_skill_enabled` flow.
//
// Seeding lifecycle (see ADR-0055 for the full rationale):
//
// - `seed_official_skills` runs inside `DbManager::open_space_conn_inner`
//   right after migrations — the single choke point every space-connection
//   open routes through. It is DB-ONLY (the spaces lock is held; no file
//   IO — ADR-0007 lock discipline) and BEST-EFFORT: a per-def failure is
//   logged and skipped, never propagated, so a seeding hiccup can never
//   make a Space unopenable. Each def seeds inside its own transaction:
//   the skills row and its default junction rows commit atomically, so a
//   mid-seed failure cannot leave an official row that the
//   junction-once rule (below) would then never backfill.
//
// - Junction rows are seeded ONLY on first insert of the skills row
//   ("junction-once"). Re-seeding on every connection open must never
//   resurrect a junction the user deliberately deleted — reopening a
//   Space is not a consent event. Consequence (documented limitation):
//   adding a default_role to an ALREADY-SEEDED official skill in a
//   future app version requires an explicit backfill migration; the
//   row-exists branch only refreshes content.
//
// - Content refresh: official rows are app-owned, so a changed embedded
//   package updates the stored blob (compared by parsed entries, so zip
//   metadata churn alone doesn't count as a change). Disk propagation
//   stays re-enable-only per ADR-0043 §2 — an enabled-and-installed
//   official keeps serving its installed copy until the user toggles it
//   off and on again.
//
// - Disk materialization is LAZY: seeding records enablement without
//   installing (a deliberate amendment of ADR-0043 §2's
//   install-before-enable ordering). The catalog, the config-dialog
//   switches, and the pool listing are all DB-driven; the only disk
//   consumer is `read_skill_entry`, which self-heals a missing install
//   from the stored blob before reporting SKILL_NOT_INSTALLED — the
//   invariant's purpose ("never reported enabled but broken at
//   runtime") is preserved.
//
// Redaction: official names/descriptions are app-shipped constants, not
// user creative content — they are safe to log (unlike uploaded skill
// content, which `commands::skill` never logs).

use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::DbError;

/// An official skill definition: fixed id (UUID-v7-shaped literal, the
/// M007/M011 seed precedent — stable across Spaces and app versions, so
/// the content-refresh path targets the same row), the skill `name`
/// (must match the SKILL.md frontmatter; validated at compile-cache
/// init), the roles it is default-enabled on, and the package files
/// (path relative to the skill root, file content) embedded in the
/// binary.
struct OfficialSkillDef {
    id: &'static str,
    name: &'static str,
    default_roles: &'static [&'static str],
    files: &'static [(&'static str, &'static str)],
}

/// Fixed far-future timestamp for official rows (the M007/M011 seed
/// precedent): deterministic across Spaces, sorts after user content in
/// plain `created_at` ordering (officials are pinned first where it
/// matters, in `do_list_skills`), and never confuses "when did this
/// Space adopt the skill" with "when was the skill created".
const OFFICIAL_TIMESTAMP: &str = "9999-12-31T23:59:59.999Z";

/// The official registry. v1 shipped one skill: the element authoring
/// guide, default-enabled on the curator (the subagent that writes
/// worldbook entity fields — exactly the audience of the guide). v2
/// added the subagent dispatch guide, default-enabled on the
/// orchestrator (brief-composition standards per dispatched role; the
/// curator section carries the inlined-source-material requirement —
/// per-role sections accumulate as dispatch experience shows what each
/// role's briefs need).
///
/// Source files live under `docs/official-skills/{name}/` and are
/// embedded COMPILE-TIME via `include_str!` (paths relative to this
/// file; rustc tracks them in dep-info, so edits rebuild correctly).
/// A unit test pins registry↔frontmatter name agreement — if you add or
/// move a file, update the paths here and that test will catch drift.
const OFFICIAL_SKILLS: &[OfficialSkillDef] = &[
    OfficialSkillDef {
        id: "01a00a6e-36c8-7e01-9e01-000000000001",
        name: "element-creation-guide",
        default_roles: &["curator"],
        files: &[(
            "SKILL.md",
            include_str!("../../docs/official-skills/element-creation-guide/SKILL.md"),
        )],
    },
    OfficialSkillDef {
        id: "01a00a6e-36c8-7e01-9e01-000000000002",
        name: "subagent-dispatch-guide",
        default_roles: &["orchestrator"],
        files: &[(
            "SKILL.md",
            include_str!("../../docs/official-skills/subagent-dispatch-guide/SKILL.md"),
        )],
    },
];

/// A definition compiled once per process: the built zip blob (the
/// storage-center `package` artifact, built in the wrapper-dir layout
/// `parse_skill_zip` accepts) plus the parsed name/description/entries.
struct CompiledOfficialSkill {
    def: &'static OfficialSkillDef,
    zip: Vec<u8>,
    description: String,
    /// Wrapper-stripped entries — the comparison basis for content
    /// refresh (zip byte equality would false-positive on metadata
    /// churn; parsed-entry equality is the semantic "did the content
    /// change" check).
    entries: Vec<(String, Vec<u8>)>,
}

/// Build the package zip for `def`: a single wrapper directory `{name}/`
/// holding the files, Deflated (the `zip` crate's deflate feature is
/// enabled for the upload path already). Fallible — see `compiled()`.
fn build_zip(def: &OfficialSkillDef) -> Result<Vec<u8>, String> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (path, content) in def.files {
        let entry_name = format!("{}/{}", def.name, path);
        zip.start_file(&entry_name, options)
            .map_err(|e| format!("zip entry {path}: {e}"))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("zip write {path}: {e}"))?;
    }
    zip.finish()
        .map_err(|e| format!("zip finish {}: {e}", def.name))
        .map(|w| w.into_inner())
}

/// Compile the registry once per process. Any def that fails to build or
/// validate (including a frontmatter/def name mismatch — the name doubles
/// as the on-disk directory, so they must match) is dropped with an error
/// log: degraded-but-alive beats a panic at Space-open time. A unit test
/// pins that the shipped registry compiles cleanly, so these branches
/// are guards, not expected paths.
fn compiled() -> &'static [CompiledOfficialSkill] {
    static COMPILED: OnceLock<Vec<CompiledOfficialSkill>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        OFFICIAL_SKILLS
            .iter()
            .filter_map(|def| {
                let zip = match build_zip(def) {
                    Ok(zip) => zip,
                    Err(e) => {
                        tracing::error!(
                            skill_name = def.name,
                            error = %e,
                            "official skill zip build failed; skipping seed"
                        );
                        return None;
                    }
                };
                match crate::commands::skill::parse_skill_zip(&zip) {
                    Ok(parsed) if parsed.name == def.name => Some(CompiledOfficialSkill {
                        def,
                        zip,
                        description: parsed.description,
                        entries: parsed.entries,
                    }),
                    Ok(parsed) => {
                        tracing::error!(
                            skill_name = def.name,
                            parsed_name = %parsed.name,
                            "official skill frontmatter name != def name; skipping seed"
                        );
                        None
                    }
                    Err(e) => {
                        tracing::error!(
                            skill_name = def.name,
                            error = %e,
                            "official skill failed validation; skipping seed"
                        );
                        None
                    }
                }
            })
            .collect()
    })
}

/// Seed official skills into a freshly-opened `space.db`. Called from
/// `DbManager::open_space_conn_inner` after migrations, with the spaces
/// lock held — DB-ONLY by contract. Best-effort: per-def failures are
/// logged and skipped (each def seeds in its own transaction, so a
/// failure rolls back atomically and the next open retries).
pub(crate) fn seed_official_skills(conn: &mut Connection, space_id: &str) {
    for skill in compiled() {
        if let Err(e) = seed_one(conn, space_id, skill) {
            tracing::warn!(
                space_id = %space_id,
                skill_id = %skill.def.id,
                error = %e,
                "official skill seed failed; will retry on next open"
            );
        }
    }
}

/// Seed one official skill. Three branches:
///
/// - **Row absent** → (after a reserved-name collision check) INSERT the
///   skills row and the default junction rows in one transaction. The
///   junction `INSERT ... SELECT` resolves AgentConfigs by NAME, so it
///   works regardless of whether the row came from the M011 seed or a
///   legacy `do_create_space` loop with a different id; a missing role
///   row inserts nothing (and junction-once means a Space created before
///   the role existed never gets the default — accepted, see ADR-0055).
/// - **Row present, official** → content refresh when the parsed entries
///   diverge from the embedded package (also heals a corrupted stored
///   blob: a failed parse counts as divergence). Never touches junction
///   rows — that is the junction-once rule.
/// - **Row present, user** → impossible in practice (user ids are
///   generated UUIDs); warn and skip rather than clobber.
fn seed_one(
    conn: &mut Connection,
    space_id: &str,
    skill: &CompiledOfficialSkill,
) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    let existing_kind: Option<String> = tx
        .query_row(
            "SELECT kind FROM skills WHERE id = ?1",
            params![skill.def.id],
            |r| r.get(0),
        )
        .optional()?;
    match existing_kind.as_deref() {
        None => {
            // Reserved-name collision: a user uploaded a skill with this
            // name before the official one existed (or the official
            // shipped later). The user row wins — never mutate or delete
            // user data — and this official is skipped for now. The next
            // open after the user removes their duplicate seeds normally.
            let taken: i64 = tx.query_row(
                "SELECT COUNT(*) FROM skills WHERE name = ?1",
                params![skill.def.name],
                |r| r.get(0),
            )?;
            if taken > 0 {
                tracing::warn!(
                    space_id = %space_id,
                    skill_name = %skill.def.name,
                    "user skill already holds the official name; skipping official seed"
                );
                return Ok(());
            }
            tx.execute(
                "INSERT INTO skills
                    (id, name, description, package, kind, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'official', ?5, ?5)",
                params![
                    skill.def.id,
                    skill.def.name,
                    skill.description,
                    skill.zip,
                    OFFICIAL_TIMESTAMP
                ],
            )?;
            for role in skill.def.default_roles {
                tx.execute(
                    "INSERT OR IGNORE INTO agent_config_skills
                        (agent_config_id, skill_id, created_at)
                     SELECT ac.id, ?1, ?2 FROM agent_configs ac WHERE ac.name = ?3",
                    params![skill.def.id, OFFICIAL_TIMESTAMP, role],
                )?;
            }
        }
        Some("official") => {
            let stored: Vec<u8> = tx.query_row(
                "SELECT package FROM skills WHERE id = ?1",
                params![skill.def.id],
                |r| r.get(0),
            )?;
            let up_to_date = crate::commands::skill::parse_skill_zip(&stored)
                .map(|p| p.entries == skill.entries)
                .unwrap_or(false);
            if !up_to_date {
                tx.execute(
                    "UPDATE skills
                     SET package = ?1, description = ?2, updated_at = ?3
                     WHERE id = ?4 AND kind = 'official'",
                    params![
                        skill.zip,
                        skill.description,
                        OFFICIAL_TIMESTAMP,
                        skill.def.id
                    ],
                )?;
            }
        }
        Some(other) => {
            tracing::warn!(
                space_id = %space_id,
                skill_id = %skill.def.id,
                kind = other,
                "skills row holds the official id with a non-official kind; skipping"
            );
            return Ok(());
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
#[path = "tests/official_skills.rs"]
mod tests;
