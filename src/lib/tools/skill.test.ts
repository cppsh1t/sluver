/**
 * Skill tool tests (ADR-0043 §3) — activation returns body + files +
 * location and records per-conversation dedup; a repeat activation returns
 * `already_active` WITHOUT a second API call (and a failed activation does
 * not poison the dedup set); `read_skill_file` ok / not_found result
 * objects; `consentLevel: "auto"` on both tools; the dynamic `name` enum
 * rejects names outside the enabled catalog.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { readSkillEntry, readSkillFile } from "@/api/skill";
import {
  skillIdSchema,
  spaceIdSchema,
  worldIdSchema,
  type EnabledSkill,
} from "@/types";
import type { ToolContext } from "./types";
import { skillTools } from "./skill";

vi.mock("@/api/skill", () => ({
  readSkillEntry: vi.fn(),
  readSkillFile: vi.fn(),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");

const skills: EnabledSkill[] = [
  {
    id: skillIdSchema.parse("skill-1"),
    name: "prose-style",
    description: "House style conventions for prose.",
  },
  {
    id: skillIdSchema.parse("skill-2"),
    name: "world-lint",
    description: "Consistency checks over the worldbook.",
  },
];

function makeStubCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    spaceId,
    worldId,
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(), set: vi.fn() },
    threadLookup: { findToolPair: vi.fn() },
    skills,
    activatedSkills: new Set(),
    visionConfig: null,
    attachmentLookup: { findByFilename: vi.fn(() => null) },
    ...overrides,
  };
}

const ctx = makeStubCtx();
const tools = skillTools(ctx);
const call = { abortSignal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── activate_skill ────────────────────────────────────────────────────────

describe("activate_skill", () => {
  it("returns the body, files, and skill-relative location, and records dedup state", async () => {
    vi.mocked(readSkillEntry).mockResolvedValue({
      body: "# Style instructions",
      files: ["refs/style.md", "scripts/lint.py"],
    });

    const result = await tools.activate_skill.execute(
      { name: "prose-style" },
      ctx,
      call,
    );

    expect(readSkillEntry).toHaveBeenCalledWith(spaceId, "prose-style");
    expect(readSkillEntry).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "activated",
      name: "prose-style",
      body: "# Style instructions",
      files: ["refs/style.md", "scripts/lint.py"],
      location: "skills/prose-style/",
    });
    expect(ctx.activatedSkills.has("prose-style")).toBe(true);
  });

  it("returns already_active WITHOUT an API call on the second activation", async () => {
    ctx.activatedSkills.add("prose-style");

    const result = await tools.activate_skill.execute(
      { name: "prose-style" },
      ctx,
      call,
    );

    expect(result).toEqual({ status: "already_active", name: "prose-style" });
    expect(readSkillEntry).not.toHaveBeenCalled();
  });

  it("does not record dedup state when the entry read fails", async () => {
    vi.mocked(readSkillEntry).mockRejectedValue(
      new Error("SKILL_NOT_INSTALLED"),
    );

    await expect(
      tools.activate_skill.execute({ name: "world-lint" }, ctx, call),
    ).rejects.toThrow("SKILL_NOT_INSTALLED");

    expect(ctx.activatedSkills.has("world-lint")).toBe(false);
  });

  it("is consentLevel auto", () => {
    expect(tools.activate_skill.consentLevel).toBe("auto");
  });
});

// ─── read_skill_file ───────────────────────────────────────────────────────

describe("read_skill_file", () => {
  it("returns ok with the file content", async () => {
    vi.mocked(readSkillFile).mockResolvedValue("Reference material.");

    const result = await tools.read_skill_file.execute(
      { name: "prose-style", path: "refs/style.md" },
      ctx,
      call,
    );

    expect(readSkillFile).toHaveBeenCalledWith(
      spaceId,
      "prose-style",
      "refs/style.md",
    );
    expect(result).toEqual({
      status: "ok",
      name: "prose-style",
      path: "refs/style.md",
      content: "Reference material.",
    });
  });

  it("returns not_found when the path does not exist (null from the API)", async () => {
    vi.mocked(readSkillFile).mockResolvedValue(null);

    const result = await tools.read_skill_file.execute(
      { name: "prose-style", path: "refs/missing.md" },
      ctx,
      call,
    );

    expect(result).toEqual({
      status: "not_found",
      name: "prose-style",
      path: "refs/missing.md",
    });
  });

  it("is consentLevel auto", () => {
    expect(tools.read_skill_file.consentLevel).toBe("auto");
  });
});

// ─── Dynamic name enum ─────────────────────────────────────────────────────

describe("input schema name enum", () => {
  const activateSchema = tools.activate_skill
    .inputSchema as unknown as z.ZodType;
  const readFileSchema = tools.read_skill_file
    .inputSchema as unknown as z.ZodType;

  it("accepts enabled skill names", () => {
    expect(activateSchema.safeParse({ name: "prose-style" }).success).toBe(
      true,
    );
    expect(activateSchema.safeParse({ name: "world-lint" }).success).toBe(
      true,
    );
  });

  it("rejects names outside the enabled catalog", () => {
    expect(activateSchema.safeParse({ name: "not-a-skill" }).success).toBe(
      false,
    );
    expect(
      readFileSchema.safeParse({ name: "not-a-skill", path: "x" }).success,
    ).toBe(false);
  });
});
