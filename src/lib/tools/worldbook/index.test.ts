/**
 * Worldbook tool barrel tests — the per-role composition table of
 * ADR-0050 D8: each of the nine loop roles gets exactly its assigned
 * surface (universal tools, look_at always registered, context_read
 * orchestrator-only, conditional shell/skills spreads, queryOnly
 * groupings, writer consent override).
 *
 * Consent-level assertions run through the compiled ToolSet's gate wiring
 * (the `callTool` pattern from types.test.ts): a DENYING gate makes a
 * consented tool reject with ToolDeniedError BEFORE any IPC happens, so
 * no api mocks are needed.
 */

import { describe, expect, it, vi } from "vitest";

import type { ToolSet } from "@/lib/ai";
import { spaceIdSchema, worldIdSchema } from "@/types";
import { ToolDeniedError, type ToolContext } from "../types";
import {
  buildCriticTools,
  buildCuratorTools,
  buildEditorTools,
  buildExplorerTools,
  buildHistorianTools,
  buildOrchestratorTools,
  buildPlotterTools,
  buildScribeTools,
  buildWriterTools,
} from "./index";

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");

function makeStubCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    spaceId,
    worldId,
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(), set: vi.fn() },
    threadLookup: { findToolPair: vi.fn() },
    skills: [],
    activatedSkills: new Set(),
    visionConfig: null,
    subagentRunner: { run: vi.fn() },
    attachmentLookup: { findByFilename: vi.fn(() => null) },
    entityImageLookup: { findByEntity: vi.fn(async () => null) },
    ...overrides,
  };
}

/** The nine loop-role builders, keyed by registry name. */
const BUILDERS = {
  orchestrator: buildOrchestratorTools,
  explorer: buildExplorerTools,
  curator: buildCuratorTools,
  scribe: buildScribeTools,
  historian: buildHistorianTools,
  editor: buildEditorTools,
  plotter: buildPlotterTools,
  writer: buildWriterTools,
  critic: buildCriticTools,
} as const;

const SUBAGENT_ROLES = [
  "explorer",
  "curator",
  "scribe",
  "historian",
  "editor",
  "plotter",
  "writer",
  "critic",
] as const;

function namesOf(role: keyof typeof BUILDERS, overrides: Partial<ToolContext> = {}) {
  return Object.keys(BUILDERS[role](makeStubCtx(overrides)));
}

function has(role: keyof typeof BUILDERS, tool: string): boolean {
  return namesOf(role).includes(tool);
}

/**
 * Invoke a compiled tool's SDK `execute` the way `streamText` would (same
 * pattern as types.test.ts) — used for consent-gate assertions.
 */
function callTool(tools: ToolSet, name: string): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) {
    throw new Error(`tool "${name}" has no execute function`);
  }
  return execute({}, {
    toolCallId: "call-1",
    messages: [],
    abortSignal: new AbortController().signal,
    context: {},
  });
}

/** Mutating worldbook (character/location/item/lore/event) tool names. */
const WORLDBOOK_MUTATIONS = [
  "create_character",
  "update_character",
  "delete_character",
  "add_phase",
  "update_phase",
  "delete_phase",
  "reorder_phases",
  "set_character_image_from_url",
  "set_character_image_from_attachment",
  "clear_character_image",
  "set_phase_image_from_url",
  "set_phase_image_from_attachment",
  "clear_phase_image",
  "create_location",
  "update_location",
  "delete_location",
  "set_location_image_from_url",
  "set_location_image_from_attachment",
  "clear_location_image",
  "create_item",
  "update_item",
  "delete_item",
  "set_item_image_from_url",
  "set_item_image_from_attachment",
  "clear_item_image",
  "create_lore",
  "update_lore",
  "delete_lore",
  "set_lore_image_from_url",
  "set_lore_image_from_attachment",
  "clear_lore_image",
  "create_event",
  "update_event",
  "delete_event",
  "set_event_image_from_url",
  "set_event_image_from_attachment",
  "clear_event_image",
];

/** Worldbook read trio (list/search/get/count per domain). */
const WORLDBOOK_READS = [
  "list_characters",
  "search_characters",
  "get_character",
  "count_character_refs",
  "count_phase_refs",
  "list_locations",
  "search_locations",
  "get_location",
  "list_items",
  "search_items",
  "get_item",
  "list_lores",
  "search_lores",
  "get_lore",
  "list_events",
  "search_events",
  "get_event",
];

/** Mutating novel/chapter/scene tool names. */
const NOVEL_DOMAIN_MUTATIONS = [
  "create_novel",
  "update_novel",
  "delete_novel",
  "set_novel_image_from_url",
  "set_novel_image_from_attachment",
  "clear_novel_image",
  "create_chapter",
  "update_chapter",
  "delete_chapter",
  "reorder_chapters",
  "create_scene",
  "update_scene",
  "delete_scene",
  "reorder_scenes",
  "add_scene_image_from_url",
  "add_scene_image_from_attachment",
  "delete_scene_image",
];

/** Novel/chapter/scene read trio (queryOnly per domain). */
const NOVEL_DOMAIN_READS = [
  "list_novels",
  "search_novels",
  "get_novel",
  "list_chapters",
  "search_chapters",
  "get_chapter",
  "get_chapter_overview",
  "list_scenes",
  "search_scenes",
  "get_scene",
  "count_scene_words",
  "list_scene_images",
];

const MUTATING_PREFIX = /^(create_|update_|delete_|reorder_|add_|set_|clear_)/;

// ─── Universal surface (every loop role) ──────────────────────────────────

describe("universal surface (ADR-0050 D8)", () => {
  it("every loop role carries get_current_time, format_time, plan, and look_at", () => {
    for (const role of Object.keys(BUILDERS)) {
      const keys = namesOf(role as keyof typeof BUILDERS);
      for (const name of ["get_current_time", "format_time", "plan", "look_at"]) {
        expect(keys, `${role} should carry ${name}`).toContain(name);
      }
    }
  });

  it("look_at is registered even when visionConfig is null (ADR-0050 D6)", () => {
    // makeStubCtx defaults visionConfig to null — every role above already
    // asserted look_at presence under that default. This explicit test
    // documents the regression guard for the removed registration gate.
    expect(has("orchestrator", "look_at")).toBe(true);
    expect(has("writer", "look_at")).toBe(true);
  });

  it("context_read is orchestrator-only", () => {
    expect(has("orchestrator", "context_read")).toBe(true);
    for (const role of SUBAGENT_ROLES) {
      expect(has(role, "context_read")).toBe(false);
    }
  });

  it("omits run_shell_command by default and registers it when shellToolEnabled is on", () => {
    for (const role of Object.keys(BUILDERS)) {
      expect(has(role as keyof typeof BUILDERS, "run_shell_command")).toBe(false);
    }
    for (const role of Object.keys(BUILDERS)) {
      expect(
        namesOf(role as keyof typeof BUILDERS, { shellToolEnabled: true }),
      ).toContain("run_shell_command");
    }
  });
});

// ─── Orchestrator purity (ADR-0050 D1) ────────────────────────────────────

describe("buildOrchestratorTools (D1 purity)", () => {
  const keys = namesOf("orchestrator");

  it("carries ONLY the system + look_at + dispatch surface (6 keys with shell+skills off)", () => {
    // systemTools() = timemapper format_time + get_current_time + plan +
    // context_read; plus the always-registered look_at; plus the Unit C
    // dispatch tool (ADR-0050 D3 — orchestrator-only). Nothing else.
    expect([...keys].sort()).toEqual(
      ["context_read", "dispatch_subagent", "format_time", "get_current_time", "look_at", "plan"].sort(),
    );
  });

  it("registers dispatch_subagent ONLY on the orchestrator (D1 — subagents never dispatch)", () => {
    expect(has("orchestrator", "dispatch_subagent")).toBe(true);
    for (const role of SUBAGENT_ROLES) {
      expect(has(role, "dispatch_subagent")).toBe(false);
    }
  });

  it("has no entity, novel, notes, retrieval, or web tools", () => {
    for (const name of [
      "list_characters",
      "get_character",
      "create_character",
      "list_novels",
      "get_scene",
      "list_notes",
      "grep",
      "timeline_lookup",
      "web_search",
      "web_fetch",
      "web_fetch_via_browser",
      "set_world_image_from_url",
    ]) {
      expect(keys).not.toContain(name);
    }
  });
});

// ─── Explorer ─────────────────────────────────────────────────────────────

describe("buildExplorerTools", () => {
  const keys = namesOf("explorer");

  it("carries retrieval + web + worldbook reads + novel-side queryOnly reads", () => {
    for (const name of ["grep", "timeline_lookup", "web_search", "web_fetch", "web_fetch_via_browser"]) {
      expect(keys).toContain(name);
    }
    for (const name of WORLDBOOK_READS) expect(keys).toContain(name);
    for (const name of NOVEL_DOMAIN_READS) expect(keys).toContain(name);
  });

  it("is a pure reader: no worldbook or novel mutations", () => {
    for (const name of WORLDBOOK_MUTATIONS) expect(keys).not.toContain(name);
    for (const name of NOVEL_DOMAIN_MUTATIONS) expect(keys).not.toContain(name);
  });

  it("carries NO note tools (scribe owns notes)", () => {
    for (const name of ["list_notes", "get_note", "grep_notes", "create_note", "update_note", "delete_note"]) {
      expect(keys).not.toContain(name);
    }
  });

  it("admits no mutating key at all", () => {
    expect(keys.filter((k) => MUTATING_PREFIX.test(k))).toEqual([]);
  });
});

// ─── Curator ──────────────────────────────────────────────────────────────

describe("buildCuratorTools", () => {
  const keys = namesOf("curator");

  it("carries FULL worldbook CRUD (incl. phases, reorder, images)", () => {
    for (const name of WORLDBOOK_MUTATIONS) expect(keys).toContain(name);
    for (const name of WORLDBOOK_READS) expect(keys).toContain(name);
  });

  it("has no novel-side, retrieval, web, or notes tools", () => {
    for (const name of [...NOVEL_DOMAIN_READS, ...NOVEL_DOMAIN_MUTATIONS]) {
      expect(keys).not.toContain(name);
    }
    for (const name of ["grep", "timeline_lookup", "web_search", "web_fetch", "list_notes"]) {
      expect(keys).not.toContain(name);
    }
  });
});

// ─── Scribe ───────────────────────────────────────────────────────────────

describe("buildScribeTools", () => {
  const keys = namesOf("scribe");

  it("carries all six note tools", () => {
    for (const name of ["list_notes", "get_note", "grep_notes", "create_note", "update_note", "delete_note"]) {
      expect(keys).toContain(name);
    }
  });

  it("carries nothing beyond the universal + notes surface", () => {
    const allowed = new Set([
      "get_current_time", "format_time", "plan", "look_at",
      "list_notes", "get_note", "grep_notes", "create_note", "update_note", "delete_note",
    ]);
    for (const key of keys) expect(allowed.has(key), `unexpected ${key}`).toBe(true);
  });
});

// ─── Historian (pure reader) ──────────────────────────────────────────────

describe("buildHistorianTools", () => {
  const keys = namesOf("historian");

  it("carries worldbook reads, retrieval, and novel-side reads", () => {
    for (const name of WORLDBOOK_READS) expect(keys).toContain(name);
    for (const name of NOVEL_DOMAIN_READS) expect(keys).toContain(name);
    for (const name of ["grep", "timeline_lookup"]) expect(keys).toContain(name);
  });

  it("has ZERO mutating tools of any domain", () => {
    expect(keys.filter((k) => MUTATING_PREFIX.test(k))).toEqual([]);
  });

  it("has no web tools (retrieval is corpus + timeline only)", () => {
    for (const name of ["web_search", "web_fetch", "web_fetch_via_browser"]) {
      expect(keys).not.toContain(name);
    }
  });
});

// ─── Editor ───────────────────────────────────────────────────────────────

describe("buildEditorTools", () => {
  const keys = namesOf("editor");

  it("carries world/novel/chapter/scene FULL CRUD (images, reorder, gallery)", () => {
    for (const name of NOVEL_DOMAIN_MUTATIONS) expect(keys).toContain(name);
    for (const name of NOVEL_DOMAIN_READS) expect(keys).toContain(name);
    for (const name of [
      "set_world_image_from_url",
      "set_world_image_from_attachment",
      "clear_world_image",
    ]) {
      expect(keys).toContain(name);
    }
  });

  it("has no worldbook CRUD (curator owns entities) and no retrieval/web/notes", () => {
    for (const name of WORLDBOOK_MUTATIONS) expect(keys).not.toContain(name);
    for (const name of ["list_characters", "get_character", "grep", "web_search", "list_notes"]) {
      expect(keys).not.toContain(name);
    }
  });
});

// ─── Plotter ──────────────────────────────────────────────────────────────

describe("buildPlotterTools", () => {
  const keys = namesOf("plotter");

  it("carries scene CRUD + chapter reads + worldbook read trio", () => {
    for (const name of ["list_chapters", "search_chapters", "get_chapter", "get_chapter_overview"]) {
      expect(keys).toContain(name);
    }
    for (const name of ["create_scene", "update_scene", "delete_scene", "reorder_scenes"]) {
      expect(keys).toContain(name);
    }
    for (const name of WORLDBOOK_READS) expect(keys).toContain(name);
  });

  it("has no chapter CRUD and no novel CRUD, no web, no notes", () => {
    for (const name of ["create_chapter", "update_chapter", "delete_chapter", "reorder_chapters"]) {
      expect(keys).not.toContain(name);
    }
    for (const name of ["create_novel", "update_novel", "delete_novel", "set_novel_image_from_url"]) {
      expect(keys).not.toContain(name);
    }
    for (const name of ["web_search", "grep", "list_notes"]) {
      expect(keys).not.toContain(name);
    }
  });
});

// ─── Writer ───────────────────────────────────────────────────────────────

describe("buildWriterTools", () => {
  const keys = namesOf("writer");

  it("carries scene reads + update_scene only — no create/delete/reorder scene", () => {
    for (const name of ["list_scenes", "search_scenes", "get_scene", "count_scene_words", "list_scene_images", "update_scene"]) {
      expect(keys).toContain(name);
    }
    for (const name of ["create_scene", "delete_scene", "reorder_scenes", "add_scene_image_from_url", "delete_scene_image"]) {
      expect(keys).not.toContain(name);
    }
  });

  it("has no novel/chapter tools and no worldbook/web/notes tools", () => {
    for (const name of ["list_novels", "create_chapter", "get_chapter_overview", "list_characters", "web_search", "list_notes"]) {
      expect(keys).not.toContain(name);
    }
  });

  it("update_scene is consent-gated at configurable: gate consulted when autoExecuteDangerousTools is off (ADR-0050 D5)", async () => {
    const request = vi.fn(async () => false); // deny → ToolDeniedError before IPC
    const tools = buildWriterTools(
      makeStubCtx({ autoExecuteDangerousTools: false, approvalGate: { request } }),
    );

    await expect(callTool(tools, "update_scene")).rejects.toBeInstanceOf(ToolDeniedError);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "update_scene", consentLevel: "configurable" }),
    );
  });

  it("update_scene bypasses the gate when autoExecuteDangerousTools is on", () => {
    const request = vi.fn(async () => false);
    const tools = buildWriterTools(
      makeStubCtx({ autoExecuteDangerousTools: true, approvalGate: { request } }),
    );

    // No gate call — the tool proceeds straight into its (real) execute.
    // Assert only that the gate stayed silent; the execute itself would
    // hit IPC, so swallow the inevitable rejection.
    void callTool(tools, "update_scene").catch(() => undefined);
    expect(request).not.toHaveBeenCalled();
  });
});

// ─── Critic ───────────────────────────────────────────────────────────────

describe("buildCriticTools", () => {
  const keys = namesOf("critic");

  it("carries chapter reads (incl. overview) + scene reads + count_scene_words", () => {
    for (const name of ["list_chapters", "search_chapters", "get_chapter", "get_chapter_overview"]) {
      expect(keys).toContain(name);
    }
    for (const name of ["list_scenes", "search_scenes", "get_scene", "count_scene_words", "list_scene_images"]) {
      expect(keys).toContain(name);
    }
  });

  it("lacks update_scene and every other mutation (pure reader)", () => {
    expect(keys).not.toContain("update_scene");
    expect(keys.filter((k) => MUTATING_PREFIX.test(k))).toEqual([]);
  });

  it("has no novel, worldbook, web, or notes tools", () => {
    for (const name of ["list_novels", "list_characters", "web_search", "grep", "list_notes"]) {
      expect(keys).not.toContain(name);
    }
  });
});

// ─── Delete/reorder stay "always" everywhere (ADR-0050 D5) ────────────────

describe("delete/reorder consent stays always", () => {
  it("editor's delete_scene consults the gate at always EVEN with autoExecuteDangerousTools on", async () => {
    const request = vi.fn(async () => false);
    const tools = buildEditorTools(
      makeStubCtx({ autoExecuteDangerousTools: true, approvalGate: { request } }),
    );

    await expect(callTool(tools, "delete_scene")).rejects.toBeInstanceOf(ToolDeniedError);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "delete_scene", consentLevel: "always" }),
    );
  });

  it("curator's delete_character consults the gate at always with autoExecuteDangerousTools on", async () => {
    const request = vi.fn(async () => false);
    const tools = buildCuratorTools(
      makeStubCtx({ autoExecuteDangerousTools: true, approvalGate: { request } }),
    );

    await expect(callTool(tools, "delete_character")).rejects.toBeInstanceOf(ToolDeniedError);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "delete_character", consentLevel: "always" }),
    );
  });
});
