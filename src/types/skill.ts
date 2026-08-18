import { z } from "zod";

/**
 * Agent Skills — storage-center install model (ADR-0043).
 *
 * A skill is an Anthropic-format package: a zip whose `SKILL.md` carries
 * `name` + `description` frontmatter plus a markdown body, optionally
 * bundled with reference files and scripts. The app is a package manager,
 * not an editor — import and delete only.
 *
 * Skills are Space-scoped (stored in `space.db`). Enabling a skill on an
 * AgentConfig installs the zip to `spaces/{id}/skills/{name}/`; the disk
 * copy is the runtime truth under progressive disclosure: a lightweight
 * catalog (`EnabledSkill`) sits permanently in context, the body and
 * bundled files (`SkillEntry` / `read_skill_file`) load only on demand.
 */

// ─── Branded IDs ──────────────────────────────────────────────────────────

/** Skill id — one row in the Space's `skills` table. */
export const skillIdSchema = z.string().brand<"SkillId">();
export type SkillId = z.infer<typeof skillIdSchema>;

// ─── Skill Summary ─────────────────────────────────────────────────────────

/**
 * Lightweight skill row — everything except the package blob.
 *
 * Returned by `list_skills`: the storage-center listing. `name` is the
 * lowercase-hyphen identifier parsed from `SKILL.md` frontmatter (unique
 * per Space).
 */
export const skillSummarySchema = z.object({
  id: skillIdSchema,
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;

// ─── Enabled Skill (catalog entry) ─────────────────────────────────────────

/**
 * Catalog entry for the `<available_skills>` system-prompt block of one
 * agent role — name + description only (~100 tokens per skill), per
 * progressive disclosure (ADR-0043 §3).
 */
export const enabledSkillSchema = z.object({
  id: skillIdSchema,
  name: z.string(),
  description: z.string(),
});

export type EnabledSkill = z.infer<typeof enabledSkillSchema>;

// ─── Skill Entry (progressive disclosure step 2) ───────────────────────────

/**
 * Result of activating a skill: the `SKILL.md` body plus the relative
 * paths of bundled files (excluding `SKILL.md` itself) — listed, never
 * eagerly loaded.
 */
export const skillEntrySchema = z.object({
  body: z.string(),
  files: z.array(z.string()),
});

export type SkillEntry = z.infer<typeof skillEntrySchema>;
