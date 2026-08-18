/**
 * Agent Skills IPC API (ADR-0043).
 *
 * Space-scoped storage-center surface: upload/delete skill packages and
 * toggle per-AgentConfig enablement (which installs/removes the on-disk
 * copy — the runtime truth). `read_skill_entry` / `read_skill_file` are
 * the progressive-disclosure reads over the installed directory, used by
 * the agent runtime's `activate_skill` / `read_skill_file` tools.
 */

import type { EnabledSkill, SkillEntry, SkillId, SkillSummary } from "@/types";
import { call } from "./client";

// ─── Storage center (Space-scoped) ──────────────────────────────────────────

/** All skill packages installed in the Space (no package blobs). */
export function listSkills(spaceId: string): Promise<SkillSummary[]> {
  return call<SkillSummary[]>("list_skills", { spaceId });
}

/**
 * Upload an Anthropic-format skill package (zip, base64). `name` and
 * `description` are parsed from `SKILL.md` frontmatter server-side; name
 * collisions within the Space are rejected.
 */
export function uploadSkill(spaceId: string, packageBase64: string): Promise<SkillSummary> {
  return call<SkillSummary>("upload_skill", { spaceId, packageBase64 });
}

/** Delete a skill package and every per-AgentConfig enablement of it. */
export function deleteSkill(spaceId: string, skillId: SkillId): Promise<void> {
  return call<void>("delete_skill", { spaceId, skillId });
}

// ─── Per-AgentConfig enablement ─────────────────────────────────────────────

/**
 * Enable/disable a skill for one AgentConfig. Enabling extracts the zip to
 * `spaces/{id}/skills/{name}/`; disabling removes that directory. Takes
 * effect for new conversations (ADR-0024 agent cache lifecycle).
 */
export function setSkillEnabled(
  spaceId: string,
  agentConfigId: string,
  skillId: SkillId,
  enabled: boolean,
): Promise<void> {
  return call<void>("set_skill_enabled", { spaceId, agentConfigId, skillId, enabled });
}

// ─── Progressive disclosure reads (installed copy) ──────────────────────────

/** Catalog entries for one agent role's `<available_skills>` block. */
export function listEnabledSkills(spaceId: string, agentConfigName: string): Promise<EnabledSkill[]> {
  return call<EnabledSkill[]>("list_enabled_skills", { spaceId, agentConfigName });
}

/** `SKILL.md` body + bundled-file listing (activation, step 2 of disclosure). */
export function readSkillEntry(spaceId: string, name: string): Promise<SkillEntry> {
  return call<SkillEntry>("read_skill_entry", { spaceId, name });
}

/** Read one bundled reference file; `null` when the path does not exist. */
export function readSkillFile(spaceId: string, name: string, path: string): Promise<string | null> {
  return call<string | null>("read_skill_file", { spaceId, name, path });
}
