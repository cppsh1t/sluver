use serde::{Deserialize, Serialize};

/// Where a `skills` row comes from (ADR-0055, amending ADR-0043).
///
/// `User` rows follow the plain ADR-0043 storage-center model: uploaded as
/// zips, deletable, names first-come-first-served. `Official` rows are
/// app-owned: seeded into every Space at connection open by
/// `official_skills::seed_official_skills`, default-enabled on their
/// designated roles, protected from deletion, and their names are
/// reserved against user uploads.
///
/// `from_db_str` falls back to `User` for unknown strings — the column is
/// NOT NULL with DEFAULT 'user', so an unexpected value means a future
/// kind this build predates; treating such a row as user-shaped (the
/// less-privileged behavior) is the safe degradation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillKind {
    User,
    Official,
}

impl SkillKind {
    /// Parse the stored discriminator; anything unknown degrades to
    /// `User` (see the type-level comment for why that is the safe side).
    pub fn from_db_str(raw: &str) -> Self {
        match raw {
            "official" => SkillKind::Official,
            _ => SkillKind::User,
        }
    }
}

/// A skill package row in `space.db` (ADR-0043). The `package` blob is the
/// immutable original zip artifact; `name` + `description` are parsed from
/// the zip's SKILL.md frontmatter at upload and `name` doubles as the
/// on-disk directory name (`spaces/{spaceId}/skills/{name}/` — charset-
/// validated for filesystem safety, see `commands::skill`).
///
/// This is the raw DB-row shape: the `package` blob is deliberately never
/// serialized to the frontend (a `Vec<u8>` crosses IPC as a JSON
/// number-array encoding trap — the same reasoning that keeps image blobs
/// out of entity structs). Commands return [`SkillSummary`] instead and
/// select the blob only on the install path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: SkillKind,
    pub package: Vec<u8>,
    pub created_at: String,
    pub updated_at: String,
}

/// Frontend-facing projection of a [`Skill`] without the package blob —
/// what `list_skills` / `upload_skill` return.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: SkillKind,
    pub created_at: String,
    pub updated_at: String,
}

/// One enabled skill for an AgentConfig — the runtime catalog entry
/// (name + description is what the model judges relevance from;
/// progressive disclosure, ADR-0043 §3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledSkill {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// The payload of `read_skill_entry` (the app-side half of the
/// `activate_skill` tool): the SKILL.md markdown BODY (frontmatter
/// stripped — name + description already live in the catalog) plus an
/// enumeration of the bundled files (listed, never eagerly loaded).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub body: String,
    pub files: Vec<String>,
}
