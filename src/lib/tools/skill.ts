/**
 * Agent Skills tools — progressive disclosure runtime (ADR-0043 §3).
 *
 * Two tools over the Space's installed skill directories:
 * - `activate_skill` (`auto`): reads the installed `SKILL.md` body plus the
 *   bundled-file listing (listed, never eagerly loaded). Deduplicated per
 *   conversation via `ctx.activatedSkills` — a repeat activation returns a
 *   short `already_active` result WITHOUT an API call.
 * - `read_skill_file` (`auto`): reads one bundled reference file on demand.
 *
 * ## Registration gate (ADR-0043 — Anthropic client-implementation guidance)
 *
 * The factory is only spread into a role's toolset when the role has ≥1
 * enabled skill (`ctx.skills.length > 0`, see `worldbook/index.ts`) — an
 * empty catalog registers NOTHING, so the model never sees these tools.
 * This mirrors the `shellToolEnabled` registration-time gate (ADR-0042).
 *
 * ## Scripts are not executed by sluver (ADR-0043 §3)
 *
 * Skill instructions direct the model; bundled scripts run through the
 * existing shell tool only when the user enabled it (ADR-0042). With shell
 * off, instructions and reference files still work — scripts are inert
 * text. The `location` field in the activation result is relative to the
 * shell tool's default cwd (the Space data directory), which is how the
 * model finds bundled scripts when shell IS available.
 *
 * ## Compaction (ADR-0043 §4 — amends ADR-0031)
 *
 * `activate_skill` call pairs are NEVER stubbed by `compactToolCalls`
 * (see `ai/pipeline/tool-compactor.ts`) — the skill's instructions must
 * persist for the whole conversation. `read_skill_file` results compact
 * normally: they are re-readable via this tool.
 */

import { z } from "zod";

import { readSkillEntry, readSkillFile } from "@/api/skill";
import type { ToolDef, ToolContext } from "./types";

/**
 * Build the `name` enum from the context's enabled skills. The factory is
 * only invoked when `ctx.skills` is non-empty (registration gate above), so
 * the tuple cast is safe by construction — the enum is never empty.
 */
function skillNameEnum(ctx: ToolContext) {
  const names = ctx.skills.map((s) => s.name) as [string, ...string[]];
  return z.enum(names);
}

/**
 * Agent Skill tools, keyed by `snake_case` name. Requires a context with
 * ≥1 enabled skill (the caller gates on `ctx.skills.length > 0`).
 */
export function skillTools(ctx: ToolContext): Record<string, ToolDef> {
  const nameEnum = skillNameEnum(ctx);

  return {
    activate_skill: {
      description:
        "Activate an Agent Skill by name. The <available_skills> catalog in the system prompt lists the installed skills with their descriptions; when the user's task matches a skill's description, call this tool BEFORE proceeding. " +
        "Returns the skill's SKILL.md instructions (body), the list of bundled files (paths relative to the skill's directory), and the skill's location. " +
        "Bundled scripts can be executed via run_shell_command from the Space directory (the skill's location is relative to the shell tool's default working directory) — but only when the shell tool is available; when it is not, scripts are inert and you should rely on the instructions alone. " +
        "For bundled reference files, use read_skill_file rather than shell cat when the shell tool is unavailable. " +
        "Activation is deduplicated per conversation: activating an already-active skill returns already_active and does NOT reload the body — do not re-request it.",
      inputSchema: z.object({
        name: nameEnum.describe(
          "The skill to activate — exactly as named in the <available_skills> catalog.",
        ),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { name } = input as { name: string };
        // Per-conversation dedup (ADR-0043 §3): the body + file listing are
        // already in the thread from the first activation — a repeat call
        // returns a short info object WITHOUT hitting the API.
        if (ctx.activatedSkills.has(name)) {
          return { status: "already_active" as const, name };
        }
        // A rejection propagates naturally — the SDK wraps thrown errors
        // into a non-fatal tool-error part (same as the note tools).
        const entry = await readSkillEntry(ctx.spaceId, name);
        // Record dedup state only AFTER a successful read, so a failed
        // activation (e.g. SKILL_NOT_INSTALLED) can be retried.
        ctx.activatedSkills.add(name);
        return {
          status: "activated" as const,
          name,
          body: entry.body,
          files: entry.files,
          location: `skills/${name}/`,
        };
      },
    },

    read_skill_file: {
      description:
        "Read one bundled reference file of an activated Agent Skill — use this for reference material listed in the activate_skill result instead of loading everything upfront. " +
        "The path must be one of the relative paths from that result's files list. Returns not_found when the path does not exist in the skill's directory.",
      inputSchema: z.object({
        name: nameEnum.describe(
          "The skill that bundles the file — exactly as named in the <available_skills> catalog.",
        ),
        path: z
          .string()
          .min(1)
          .describe(
            "Relative path from the skill's directory — one of the files listed in the activate_skill result.",
          ),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { name, path } = input as { name: string; path: string };
        const content = await readSkillFile(ctx.spaceId, name, path);
        if (content === null) {
          return { status: "not_found" as const, name, path };
        }
        return { status: "ok" as const, name, path, content };
      },
    },
  };
}
