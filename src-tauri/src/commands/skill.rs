// Agent Skills commands (ADR-0043: storage-center install model).
//
// A skill is an Anthropic-format package: a zip of a folder whose SKILL.md
// carries `name` + `description` frontmatter plus a markdown body,
// optionally bundled with reference files. The DB is the STORAGE source —
// `skills` rows hold the immutable zip blob, `agent_config_skills` rows
// hold per-AgentConfig enablement (row EXISTS = enabled, no `enabled`
// column). Disk materialization happens ONLY at enable time: the zip is
// extracted to `spaces/{spaceId}/skills/{name}/` and from then on THE DISK
// COPY IS THE RUNTIME TRUTH (no re-sync machinery; re-install — re-enable
// or re-upload — is the only propagation path).
//
// Upload safety (ADR-0043 §1): zip-slip guard via `enclosed_name()` PLUS
// an explicit post-normalization traversal re-check (backslash-encoded
// `..` is only caught by `enclosed_name` on Windows — see the check in
// `parse_skill_zip`), ≤ 10 MiB package, ≤ 1 MiB per entry, ≤ 100 entries.
// The frontmatter `name` is strictly validated (`^[a-z0-9][a-z0-9-]{0,63}$`,
// Windows reserved device names rejected) because it becomes the on-disk
// directory name — filesystem safety is a hard requirement here, not a
// cosmetic warning.
//
// All command bodies are thin wrappers over `do_*` helpers taking
// `&DbManager` — unit-testable without a Tauri runtime (house convention).
//
// Redaction: skill names / descriptions / package bytes are user creative
// content and are NEVER logged; only ids surface in `entity_id` fields.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rusqlite::params;
use tauri::State;
use zip::ZipArchive;

use crate::db::{DbError, DbManager};
use crate::models::skill::{EnabledSkill, Skill, SkillEntry, SkillSummary};
use crate::util::{new_id, now_iso};

// ─── upload safety limits (ADR-0043 §1) ─────────────────────────────────────

/// Hard ceiling on the decoded skill package (≤ 10 MiB total).
const MAX_PACKAGE_BYTES: usize = 10 * 1024 * 1024;
/// Hard ceiling on the archive entry count (≤ 100 files).
const MAX_ENTRIES: usize = 100;
/// Hard ceiling on a single entry's UNCOMPRESSED size (≤ 1 MiB per file).
const MAX_ENTRY_BYTES: usize = 1024 * 1024;
/// Max frontmatter `description` length in characters.
const MAX_DESCRIPTION_CHARS: usize = 1024;

// ═══════════════════════════════════════════════════════════════════════════
// package parsing + validation (shared by upload and install)
// ═══════════════════════════════════════════════════════════════════════════

/// A skill package parsed + validated out of its zip blob. `entries` paths
/// are forward-slash relative to the skill root (top-level wrapper dir
/// stripped) and are safe to join onto an extraction root — every entry
/// passed the zip-slip guards (`enclosed_name()` plus an explicit
/// post-normalization `..` re-check that does not depend on the host
/// OS's separator handling), so no `..` or absolute components can
/// appear.
struct ParsedSkillPackage {
    name: String,
    description: String,
    entries: Vec<(String, Vec<u8>)>,
}

/// Frontmatter block of SKILL.md. Only `name` + `description` are consumed;
/// unknown keys are ignored (lenient per the standard's client guidance —
/// ADR-0043 §1).
#[derive(Debug, Default, serde::Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) —
/// `name` becomes a directory name and Win32 path handling mis-resolves
/// these regardless of extension. Windows-first app, so they are rejected
/// on every build host.
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", //
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", //
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// `^[a-z0-9][a-z0-9-]{0,63}$` minus Windows reserved device names — the
/// skill `name` doubles as the on-disk directory name (`skills/{name}/`),
/// so the charset is a filesystem-safety requirement (ADR-0043 §1).
/// Hand-rolled: the crate carries no `regex` dependency and this shape is
/// trivial to check byte-wise.
fn is_valid_skill_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    match bytes.first() {
        Some(&b) if b.is_ascii_lowercase() || b.is_ascii_digit() => {}
        _ => return false,
    }
    bytes.len() <= 64
        && bytes[1..]
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        // Charset is already lowercase-only, so an exact match suffices.
        && !WINDOWS_RESERVED_NAMES.contains(&name)
}

fn invalid(reason: impl Into<String>) -> DbError {
    DbError::SkillPackageInvalid(reason.into())
}

/// Decode + validate a skill zip blob: entry count / per-entry size /
/// zip-slip guards, SKILL.md location (archive root, or under a SINGLE
/// common top-level directory whose prefix is stripped for all entries),
/// and frontmatter shape. Shared by upload (consumes name + description)
/// and install (consumes everything) so both paths enforce IDENTICAL
/// limits — the install path re-validates the stored blob rather than
/// trusting it.
fn parse_skill_zip(bytes: &[u8]) -> Result<ParsedSkillPackage, DbError> {
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| invalid(format!("not a valid zip archive: {e}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(invalid(format!(
            "archive contains more than {MAX_ENTRIES} entries"
        )));
    }

    // Pass 1: entry names (zip-slip guard + UTF-8) + header sizes.
    let mut names: Vec<String> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| invalid(format!("failed to read entry metadata: {e}")))?;
        // Zip-slip guard: `enclosed_name` is None whenever the stored name
        // would escape the archive root (`..` components, absolute paths).
        let Some(enclosed) = entry.enclosed_name() else {
            return Err(invalid("entry name escapes the archive root (zip-slip)"));
        };
        let Some(raw) = enclosed.to_str() else {
            return Err(invalid("entry name is not valid UTF-8"));
        };
        // Normalize to forward slashes (Windows Path rendering uses '\').
        names.push(raw.replace('\\', "/"));
        if entry.size() > MAX_ENTRY_BYTES as u64 {
            return Err(invalid("entry exceeds the 1 MiB uncompressed size limit"));
        }
    }

    // Path components per entry (empty segments from dir markers dropped).
    let comps: Vec<Vec<&str>> = names
        .iter()
        .map(|n| n.split('/').filter(|c| !c.is_empty()).collect())
        .collect();

    // Post-normalization traversal re-check: `enclosed_name` tokenizes
    // with `Path::components`, which treats `\` as a separator ONLY on
    // Windows — on Unix an entry named `a\..\..\evil` sails through the
    // zip-crate guard as a single Normal component and only becomes
    // `a/../../evil` after the backslash replace above. The zip-slip
    // defense must not depend on the host OS, so reject `..` components
    // explicitly on the NORMALIZED names.
    if comps.iter().flatten().any(|c| *c == "..") {
        return Err(invalid("entry name escapes the archive root (zip-slip)"));
    }

    // Locate SKILL.md: exactly ONE entry whose final component is SKILL.md,
    // at depth 1 (archive root) or depth 2 under a SINGLE common top-level
    // directory shared by EVERY entry. Zero hits = missing; multiple hits
    // or deeper nesting = mixed depths — both rejected.
    let prefix_depth = match comps
        .iter()
        .enumerate()
        .filter(|(_, c)| c.last() == Some(&"SKILL.md"))
        .map(|(i, _)| i)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [i] => match comps[*i].len() {
            1 => 1,
            2 => {
                let dir = comps[*i][0];
                if comps.iter().all(|c| !c.is_empty() && c[0] == dir) {
                    2
                } else {
                    return Err(invalid(
                        "SKILL.md's wrapper directory is not shared by all entries",
                    ));
                }
            }
            _ => return Err(invalid("SKILL.md appears at mixed depths")),
        },
        [] => return Err(invalid("SKILL.md not found in the archive")),
        _ => return Err(invalid("SKILL.md appears at mixed depths")),
    };

    // Pass 2: read contents (directory markers skipped), strip the wrapper
    // prefix from every path.
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for (i, name) in names.iter().enumerate() {
        if name.ends_with('/') || comps[i].is_empty() {
            continue; // explicit directory marker / degenerate name
        }
        let mut entry = archive
            .by_index(i)
            .map_err(|e| invalid(format!("failed to read entry: {e}")))?;
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| invalid(format!("failed to read entry contents: {e}")))?;
        // Defense in depth: the local header's size field can lie —
        // re-check the actually-read length.
        if buf.len() > MAX_ENTRY_BYTES {
            return Err(invalid("entry exceeds the 1 MiB uncompressed size limit"));
        }
        entries.push((comps[i][prefix_depth - 1..].join("/"), buf));
    }

    // Frontmatter: name + description.
    let skill_md = entries
        .iter()
        .find(|(p, _)| p == "SKILL.md")
        .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
        .ok_or_else(|| invalid("SKILL.md not found in the archive"))?;
    let fm = parse_frontmatter(&skill_md)?;
    let name = fm
        .name
        .filter(|n| is_valid_skill_name(n))
        .ok_or_else(|| {
            invalid("frontmatter name is missing or invalid (must match ^[a-z0-9][a-z0-9-]{0,63}$)")
        })?;
    let description = fm
        .description
        .ok_or_else(|| invalid("frontmatter description is missing"))?;
    if description.trim().is_empty() {
        return Err(invalid(
            "frontmatter description is empty or whitespace-only",
        ));
    }
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(invalid("frontmatter description exceeds 1024 characters"));
    }

    Ok(ParsedSkillPackage {
        name,
        description,
        entries,
    })
}

/// Parse the leading `---`-delimited YAML frontmatter block of SKILL.md.
/// The opening line must be exactly `---`; the block closes at the next
/// line that is exactly `---` (trailing `\r` tolerated for CRLF files).
fn parse_frontmatter(content: &str) -> Result<SkillFrontmatter, DbError> {
    let mut lines = content.lines();
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => {
            return Err(invalid(
                "SKILL.md must start with a '---' frontmatter delimiter",
            ))
        }
    }
    let mut block: Vec<&str> = Vec::new();
    for line in lines {
        if line.trim_end() == "---" {
            return serde_yaml::from_str(&block.join("\n"))
                .map_err(|e| invalid(format!("invalid frontmatter YAML: {e}")));
        }
        block.push(line);
    }
    Err(invalid(
        "SKILL.md frontmatter is not closed with a '---' delimiter",
    ))
}

/// Return the markdown BODY of SKILL.md (everything after the closing
/// `---`). Progressive disclosure (ADR-0043 §3): name + description live
/// in the always-on catalog; only the body is worth loading into context.
/// A file without parseable frontmatter is returned whole — the installed
/// copy passed upload validation, so this is a degenerate-case fallback,
/// not an expected path.
fn strip_frontmatter(content: &str) -> String {
    let first_line_end = match content.find('\n') {
        Some(i) => i + 1,
        None => return content.to_string(),
    };
    if content[..first_line_end].trim_end() != "---" {
        return content.to_string();
    }
    let rest = &content[first_line_end..];
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return rest[offset + line.len()..].to_string();
        }
        offset += line.len();
    }
    content.to_string()
}

// ─── disk helpers ───────────────────────────────────────────────────────────

/// `spaces/{space_id}/skills/{name}` — the installed (runtime-truth) copy.
/// `name` MUST have passed `is_valid_skill_name` before this join (the
/// charset check is what makes the join traversal-safe).
fn skill_dir(mgr: &DbManager, space_id: &str, name: &str) -> PathBuf {
    mgr.space_data_dir(space_id).join("skills").join(name)
}

/// Extract a skill package to `skills/{name}.tmp-{uuid}/`, then swap it
/// into place via a stash dance: final → `{name}.old-{uuid}` → tmp →
/// final → delete stash. The final path is never absent for a recursive
/// delete — only for the two consecutive renames — so a concurrent
/// `read_skill_entry` sees either the old complete install or the new
/// one (remove_dir_all-then-rename would leave an unbounded gap while
/// deleting up to 100 files). On swap failure the stash is renamed back
/// (rollback) and any IO error surfaces as `DbError::Io` after cleaning
/// the tmp dir. Installing over an existing install is a supported
/// replace path (re-enable after drift — ADR-0043 §2: re-installation is
/// the only propagation path).
fn install_skill(
    mgr: &DbManager,
    space_id: &str,
    name: &str,
    package: &[u8],
) -> Result<(), DbError> {
    // Re-validate the stored blob with the SAME limits/guards as upload —
    // do not trust un-revalidated bytes on the disk-truth path.
    let parsed = parse_skill_zip(package)?;
    let skills_root = mgr.space_data_dir(space_id).join("skills");
    std::fs::create_dir_all(&skills_root)?;
    let tmp = skills_root.join(format!("{name}.tmp-{}", new_id()));
    let stash = skills_root.join(format!("{name}.old-{}", new_id()));
    let final_dir = skills_root.join(name);
    let swapped = extract_to(&tmp, &parsed.entries).and_then(|()| {
        let had_final = final_dir.exists();
        if had_final {
            std::fs::rename(&final_dir, &stash)?;
        }
        match std::fs::rename(&tmp, &final_dir) {
            Ok(()) => {
                if had_final {
                    let _ = std::fs::remove_dir_all(&stash);
                }
                Ok(())
            }
            Err(e) => {
                // Roll the previous install back into place.
                if had_final {
                    let _ = std::fs::rename(&stash, &final_dir);
                }
                Err(DbError::Io(e))
            }
        }
    });
    if let Err(e) = swapped {
        // Clean the staged tmp dir so failures don't litter skills/.
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Write `entries` (forward-slash relative paths → bytes) under `root`.
/// Parent dirs are created on demand; zip-slip was already excluded by
/// `parse_skill_zip`.
fn extract_to(root: &Path, entries: &[(String, Vec<u8>)]) -> Result<(), DbError> {
    std::fs::create_dir_all(root)?;
    for (rel, bytes) in entries {
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, bytes)?;
    }
    Ok(())
}

/// Recursively collect file paths under `dir` as `/`-separated paths
/// relative to `rel` (accumulated from the walk root).
fn collect_files(dir: &Path, rel: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let child_rel = rel.join(entry.file_name());
        if path.is_dir() {
            collect_files(&path, &child_rel, out)?;
        } else {
            out.push(child_rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// A path safe to join under the skill dir: non-empty, relative, and free
/// of `..` / drive-prefix / root components (symlinks are handled by the
/// caller's canonicalize containment check).
fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let p = Path::new(path);
    p.is_relative()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

fn row_to_summary(row: &rusqlite::Row) -> rusqlite::Result<SkillSummary> {
    Ok(SkillSummary {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Full DB-row mapper (includes the `package` blob). Used only where the
/// blob is actually needed — the install path of `set_skill_enabled`.
fn row_to_skill(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        package: row.get("package")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// list_skills
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_skills(
    space_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<SkillSummary>, DbError> {
    do_list_skills(&state, &space_id)
}

pub(crate) fn do_list_skills(
    mgr: &DbManager,
    space_id: &str,
) -> Result<Vec<SkillSummary>, DbError> {
    mgr.with_space(space_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, created_at, updated_at
             FROM skills ORDER BY created_at, id",
        )?;
        let rows = stmt
            .query_map([], row_to_summary)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// upload_skill
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state, package_base64), fields(entity_id))]
#[tauri::command]
pub fn upload_skill(
    space_id: String,
    package_base64: String,
    state: State<'_, DbManager>,
) -> Result<SkillSummary, DbError> {
    do_upload_skill(&state, &space_id, &package_base64)
}

/// Upload pipeline (ADR-0043 §1): base64-decode → size ceiling → zip
/// validation (entry count / per-entry size / zip-slip / SKILL.md
/// location / frontmatter) → INSERT. NO disk materialization happens
/// here — install only happens via `set_skill_enabled(true)`.
pub(crate) fn do_upload_skill(
    mgr: &DbManager,
    space_id: &str,
    package_base64: &str,
) -> Result<SkillSummary, DbError> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(package_base64)
        .map_err(|_| invalid("invalid base64 payload"))?;
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err(invalid("package exceeds the 10 MiB size limit"));
    }
    let parsed = parse_skill_zip(&bytes)?;

    let id = new_id();
    let now = now_iso();
    tracing::Span::current().record("entity_id", id.as_str());
    // Insert + read back. A duplicate `name` surfaces as the RAW SQLite
    // UNIQUE constraint error — house convention (no DuplicateName
    // business variant; see AGENTS.md testing notes).
    mgr.with_space(space_id, move |conn| {
        conn.execute(
            "INSERT INTO skills (id, name, description, package, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, parsed.name, parsed.description, bytes, now],
        )?;
        conn.query_row(
            "SELECT id, name, description, created_at, updated_at
             FROM skills WHERE id = ?1",
            params![id],
            row_to_summary,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::SkillNotFound(id.clone()),
            other => DbError::Sqlite(other),
        })
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// delete_skill
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state, skill_id), fields(entity_id = %skill_id))]
#[tauri::command]
pub fn delete_skill(
    space_id: String,
    skill_id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    do_delete_skill(&state, &space_id, &skill_id)
}

pub(crate) fn do_delete_skill(
    mgr: &DbManager,
    space_id: &str,
    skill_id: &str,
) -> Result<(), DbError> {
    // Single transaction: fetch the name (needed for the dir path) →
    // delete junction rows explicitly (the FK cascade from the skills row
    // would do it, but being explicit documents intent) → delete the
    // skills row. rows_affected == 0 → SkillNotFound.
    let name = mgr.with_space(space_id, |conn| {
        let tx = conn.transaction()?;
        let name: String = tx
            .query_row(
                "SELECT name FROM skills WHERE id = ?1",
                params![skill_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DbError::SkillNotFound(skill_id.to_string())
                }
                other => DbError::Sqlite(other),
            })?;
        tx.execute(
            "DELETE FROM agent_config_skills WHERE skill_id = ?1",
            params![skill_id],
        )?;
        let affected = tx.execute("DELETE FROM skills WHERE id = ?1", params![skill_id])?;
        if affected == 0 {
            // Race: row vanished between SELECT and DELETE.
            return Err(DbError::SkillNotFound(skill_id.to_string()));
        }
        tx.commit()?;
        Ok(name)
    })?;
    // Best-effort removal of the installed dir (a missing dir is fine —
    // the skill may never have been enabled). Never log the name.
    let dir = skill_dir(mgr, space_id, &name);
    if dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(entity_id = %skill_id, error = %e, "skill dir removal failed");
        }
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// set_skill_enabled
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state, agent_config_id), fields(entity_id = %skill_id))]
#[tauri::command]
pub fn set_skill_enabled(
    space_id: String,
    agent_config_id: String,
    skill_id: String,
    enabled: bool,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    do_set_skill_enabled(&state, &space_id, &agent_config_id, &skill_id, enabled)
}

pub(crate) fn do_set_skill_enabled(
    mgr: &DbManager,
    space_id: &str,
    agent_config_id: &str,
    skill_id: &str,
    enabled: bool,
) -> Result<(), DbError> {
    if enabled {
        // Install FIRST; record the junction row only after the disk copy
        // exists. The reverse order would leave a phantom-enabled row on
        // install failure: `list_enabled_skills` (a pure DB join) would
        // report the skill enabled while `activate_skill` fails with
        // SKILL_NOT_INSTALLED at runtime. An orphan DIRECTORY from a
        // failure between the two steps is benign by comparison — no
        // junction row references it, and delete_skill / the next enable
        // clean it up. The blob + name come OUT of the closures so the
        // disk work happens with no lock held — `with_space`'s spaces
        // lock must never wrap file IO (ADR-0007 lock discipline).
        let (name, package) = mgr.with_space(space_id, |conn| {
            conn.query_row(
                "SELECT id FROM agent_configs WHERE id = ?1",
                params![agent_config_id],
                |_| Ok(()),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DbError::AgentConfigNotFound(agent_config_id.to_string())
                }
                other => DbError::Sqlite(other),
            })?;
            let skill = conn
                .query_row(
                    "SELECT id, name, description, package, created_at, updated_at
                     FROM skills WHERE id = ?1",
                    params![skill_id],
                    row_to_skill,
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => {
                        DbError::SkillNotFound(skill_id.to_string())
                    }
                    other => DbError::Sqlite(other),
                })?;
            Ok((skill.name, skill.package))
        })?;
        install_skill(mgr, space_id, &name, &package)?;
        // INSERT OR IGNORE → re-enabling is an idempotent reinstall. (A
        // concurrent agent_config deletion between the two steps surfaces
        // as an FK violation here — install already succeeded, the orphan
        // dir is benign as documented above.)
        mgr.with_space(space_id, |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO agent_config_skills
                    (agent_config_id, skill_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![agent_config_id, skill_id, now_iso()],
            )?;
            Ok(())
        })
    } else {
        // Junction row removal (0 affected is NOT an error — disabling an
        // already-disabled skill is a no-op). The installed dir is removed
        // only when NO AgentConfig still enables the skill.
        let name_to_remove = mgr.with_space(space_id, |conn| {
            let name: Option<String> = conn
                .query_row(
                    "SELECT name FROM skills WHERE id = ?1",
                    params![skill_id],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    // No row = skill gone; its junction rows were
                    // FK-cascaded, nothing to disable.
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(DbError::Sqlite(other)),
                })?;
            let Some(name) = name else {
                return Ok(None);
            };
            conn.execute(
                "DELETE FROM agent_config_skills
                 WHERE agent_config_id = ?1 AND skill_id = ?2",
                params![agent_config_id, skill_id],
            )?;
            let remaining: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agent_config_skills WHERE skill_id = ?1",
                params![skill_id],
                |r| r.get(0),
            )?;
            Ok(if remaining == 0 { Some(name) } else { None })
        })?;
        if let Some(name) = name_to_remove {
            let dir = skill_dir(mgr, space_id, &name);
            if dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    tracing::warn!(entity_id = %skill_id, error = %e, "skill dir removal failed");
                }
            }
        }
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// list_enabled_skills
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state, agent_config_name))]
#[tauri::command]
pub fn list_enabled_skills(
    space_id: String,
    agent_config_name: String,
    state: State<'_, DbManager>,
) -> Result<Vec<EnabledSkill>, DbError> {
    do_list_enabled_skills(&state, &space_id, &agent_config_name)
}

/// JOIN agent_configs (by name) → agent_config_skills → skills. An unknown
/// config name yields an EMPTY Vec (benign — the runtime treats empty as
/// "no skills", e.g. the namer role which never enables any).
pub(crate) fn do_list_enabled_skills(
    mgr: &DbManager,
    space_id: &str,
    agent_config_name: &str,
) -> Result<Vec<EnabledSkill>, DbError> {
    mgr.with_space(space_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.description
             FROM agent_configs ac
             JOIN agent_config_skills j ON j.agent_config_id = ac.id
             JOIN skills s ON s.id = j.skill_id
             WHERE ac.name = ?1
             ORDER BY s.created_at, s.id",
        )?;
        let rows = stmt
            .query_map(params![agent_config_name], |row| {
                Ok(EnabledSkill {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// read_skill_entry
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state, name))]
#[tauri::command]
pub fn read_skill_entry(
    space_id: String,
    name: String,
    state: State<'_, DbManager>,
) -> Result<SkillEntry, DbError> {
    do_read_skill_entry(&state, &space_id, &name)
}

/// Read `skills/{name}/SKILL.md` from DISK — the installed copy is the
/// runtime truth (ADR-0043 §2). Missing dir/file → `SkillNotInstalled`.
pub(crate) fn do_read_skill_entry(
    mgr: &DbManager,
    space_id: &str,
    name: &str,
) -> Result<SkillEntry, DbError> {
    // Defense in depth: the charset check is what makes the path join
    // below traversal-safe (upload already rejected every other shape, so
    // a name failing it can never have been installed).
    if !is_valid_skill_name(name) {
        return Err(DbError::SkillNotInstalled(name.to_string()));
    }
    let dir = skill_dir(mgr, space_id, name);
    let content = match std::fs::read_to_string(dir.join("SKILL.md")) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(DbError::SkillNotInstalled(name.to_string()));
        }
        Err(e) => return Err(DbError::Io(e)),
    };
    // Bundled files: everything under the dir EXCEPT SKILL.md itself,
    // relative forward-slash paths, sorted. Listed, never eagerly loaded
    // (progressive disclosure — ADR-0043 §3).
    let mut files: Vec<String> = Vec::new();
    collect_files(&dir, Path::new(""), &mut files).map_err(DbError::Io)?;
    files.sort();
    files.retain(|f| f != "SKILL.md");
    Ok(SkillEntry {
        body: strip_frontmatter(&content),
        files,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// read_skill_file
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state, name, path))]
#[tauri::command]
pub fn read_skill_file(
    space_id: String,
    name: String,
    path: String,
    state: State<'_, DbManager>,
) -> Result<Option<String>, DbError> {
    do_read_skill_file(&state, &space_id, &name, &path)
}

/// Read `skills/{name}/{path}` from disk. Text-oriented tool: content is
/// decoded via `from_utf8_lossy` (binary garbage degrades to replacement
/// characters rather than erroring — acceptable degradation). Missing /
/// unreadable / unsafe paths → `Ok(None)`.
pub(crate) fn do_read_skill_file(
    mgr: &DbManager,
    space_id: &str,
    name: &str,
    path: &str,
) -> Result<Option<String>, DbError> {
    // Same charset guard as read_skill_entry; here a bad name is simply
    // "no such skill" (this is the lenient read path).
    if !is_valid_skill_name(name) {
        return Ok(None);
    }
    if !is_safe_relative_path(path) {
        return Ok(None);
    }
    let dir = skill_dir(mgr, space_id, name);
    let full = dir.join(path);
    // Canonicalized containment check: the resolved target must stay under
    // the skill dir (symlink / alias defense).
    let Ok(canonical_target) = full.canonicalize() else {
        return Ok(None); // missing target or skill not installed
    };
    let Ok(canonical_dir) = dir.canonicalize() else {
        return Ok(None); // skill not installed
    };
    if !canonical_target.starts_with(&canonical_dir) {
        return Ok(None);
    }
    match std::fs::read(&canonical_target) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(_) => Ok(None),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{make_space_with_world, uuid_shape, WorldFixture};
    use base64::Engine as _;
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    // ── fixtures ───────────────────────────────────────────────────────────

    /// Insert an agent_config row directly — the fixture's space.db only
    /// carries the migration-seeded `namer`, and these tests want
    /// deterministic ids.
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
        let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
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
        let err = do_upload_skill(
            &fx.mgr,
            &fx.space_id,
            &zip_base64(&[("SKILL.md", md)]),
        )
        .expect_err("must reject");
        assert!(matches!(err, DbError::SkillPackageInvalid(_)));
    }

    #[test]
    fn upload_skill_rejects_bad_names() {
        let fx = make_space_with_world();
        let too_long = "x".repeat(65);
        for bad in ["My-Skill", "my_skill", "-leading", "my space", too_long.as_str()] {
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
            let err = do_upload_skill(
                &fx.mgr,
                &fx.space_id,
                &zip_base64(&[("SKILL.md", &md)]),
            )
            .expect_err("empty description must be rejected");
            assert!(matches!(err, DbError::SkillPackageInvalid(_)), "{desc}");
        }
    }

    #[test]
    fn upload_skill_rejects_oversize_description() {
        let fx = make_space_with_world();
        let long = "a".repeat(1025);
        let md = format!("---\nname: my-skill\ndescription: {long}\n---\nbody\n");
        let err = do_upload_skill(
            &fx.mgr,
            &fx.space_id,
            &zip_base64(&[("SKILL.md", &md)]),
        )
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
        assert!(!fx.mgr.space_data_dir(&fx.space_id).join("evil.txt").exists());
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
        assert!(!fx.mgr.space_data_dir(&fx.space_id).join("evil.txt").exists());
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
        let enabled = do_list_enabled_skills(&fx.mgr, &fx.space_id, "explorer")
            .expect("list enabled");
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, summary.id);
        assert_eq!(enabled[0].name, "my-skill");
        assert_eq!(enabled[0].description, "A test skill");

        // Unknown config name → benign empty Vec.
        assert!(
            do_list_enabled_skills(&fx.mgr, &fx.space_id, "ghost")
                .expect("ghost list")
                .is_empty()
        );
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
        do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
            .expect("enable");
        // The wrapper prefix is stripped: files land directly under
        // skills/my-skill/, NOT skills/my-skill/my-skill/.
        assert!(skills_root(&fx).join("my-skill").join("refs").join("a.md").exists());
        assert!(!skills_root(&fx).join("my-skill").join("my-skill").exists());
    }

    #[test]
    fn double_enable_is_idempotent_and_replaces_dir() {
        let fx = make_space_with_world();
        let ac = seed_agent_config(&fx, 7, "explorer");
        let summary = upload_and_enable(&fx, &ac);

        // Simulate drift: the model edited a file via shell (disk is
        // truth — such edits persist until re-installation, ADR-0043).
        let drifted = skills_root(&fx).join("my-skill").join("refs").join("style.md");
        std::fs::write(&drifted, "drifted").expect("drift");

        // Re-enable → idempotent reinstall from the stored zip.
        do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
            .expect("second enable");
        assert_eq!(junction_count(&fx, &summary.id), 1, "no duplicate junction row");
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
        let err = do_set_skill_enabled(
            &fx.mgr,
            &fx.space_id,
            &uuid_shape(99),
            &summary.id,
            true,
        )
        .expect_err("ghost agent config");
        match err {
            DbError::AgentConfigNotFound(id) => assert_eq!(id, uuid_shape(99)),
            other => panic!("expected AgentConfigNotFound, got {other:?}"),
        }

        // Ghost skill → SkillNotFound.
        let err =
            do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &uuid_shape(98), true)
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
        do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac2, &summary.id, true)
            .expect("enable writer");
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
        do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac2, &summary.id, false)
            .expect("disable writer");
        assert!(!dir.exists());
        assert_eq!(junction_count(&fx, &summary.id), 0);

        // Disabling again is a benign no-op (0 affected is NOT an error).
        do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac2, &summary.id, false)
            .expect("disable again");
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
        assert!(
            do_list_enabled_skills(&fx.mgr, &fx.space_id, "explorer")
                .expect("list enabled")
                .is_empty()
        );
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
        assert!(
            do_list_skills(&fx.mgr, &fx.space_id)
                .expect("list")
                .is_empty()
        );
        assert_eq!(junction_count(&fx, &summary.id), 0);
        assert!(!skills_root(&fx).join("my-skill").exists());

        // Deleting again → SkillNotFound.
        let err = do_delete_skill(&fx.mgr, &fx.space_id, &summary.id)
            .expect_err("ghost delete");
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
        do_set_skill_enabled(&fx.mgr, &fx.space_id, &ac, &summary.id, true)
            .expect("enable");

        let entry = do_read_skill_entry(&fx.mgr, &fx.space_id, "my-skill").expect("entry");
        // Body = everything after the closing frontmatter delimiter.
        assert_eq!(entry.body, "\n# Instructions\n\nUse the force.\n");
        // Bundled files EXCLUDE SKILL.md, use forward slashes, sorted.
        assert_eq!(entry.files, vec!["refs/deep/nested.md", "refs/style.md"]);

        let file = do_read_skill_file(&fx.mgr, &fx.space_id, "my-skill", "refs/style.md")
            .expect("read file")
            .expect("file exists");
        assert_eq!(file, "# Style\nBe terse.");
        let nested =
            do_read_skill_file(&fx.mgr, &fx.space_id, "my-skill", "refs/deep/nested.md")
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
        assert!(!fx.mgr.space_data_dir(&fx.space_id).join("escape.txt").exists());

        // Not-installed skill → SkillNotInstalled.
        let err = do_read_skill_entry(&fx.mgr, &fx.space_id, "ghost")
            .expect_err("ghost entry");
        match err {
            DbError::SkillNotInstalled(n) => assert_eq!(n, "ghost"),
            other => panic!("expected SkillNotInstalled, got {other:?}"),
        }
        // Invalid name charset → rejected before any path join.
        let err = do_read_skill_entry(&fx.mgr, &fx.space_id, "../evil")
            .expect_err("traversal name");
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
}
