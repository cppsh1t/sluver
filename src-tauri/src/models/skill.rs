use serde::{Deserialize, Serialize};

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
