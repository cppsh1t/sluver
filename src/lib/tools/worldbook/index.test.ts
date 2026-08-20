/**
 * Worldbook tool barrel tests — the role split implemented by `queryOnly`
 * filtering: Explorer gets full worldbook CRUD + novel/chapter/scene queries;
 * Writer gets full novel/chapter/scene CRUD + worldbook queries. Both share
 * notes / system / web / grep / timeline / world-cover tools, and shell
 * execution is registered only when `shellToolEnabled` is on.
 */

import { describe, expect, it, vi } from "vitest";

import { spaceIdSchema, worldIdSchema } from "@/types";
import type { ToolContext } from "../types";
import { buildExplorerTools, buildWriterTools } from "./index";

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
    attachmentLookup: { findByFilename: vi.fn(() => null) },
    ...overrides,
  };
}

const MUTATING_PREFIX = /^(create_|update_|delete_|reorder_|add_|set_)/;

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
  "set_phase_image_from_url",
  "create_location",
  "update_location",
  "delete_location",
  "set_location_image_from_url",
  "create_item",
  "update_item",
  "delete_item",
  "set_item_image_from_url",
  "create_lore",
  "update_lore",
  "delete_lore",
  "set_lore_image_from_url",
  "create_event",
  "update_event",
  "delete_event",
  "set_event_image_from_url",
];

/** Mutating novel/chapter/scene tool names. */
const NOVEL_DOMAIN_MUTATIONS = [
  "create_novel",
  "update_novel",
  "delete_novel",
  "set_novel_image_from_url",
  "create_chapter",
  "update_chapter",
  "delete_chapter",
  "reorder_chapters",
  "create_scene",
  "update_scene",
  "delete_scene",
  "reorder_scenes",
];

/** Mutating keys both roles legitimately carry (shared surfaces). */
const SHARED_MUTATIONS = [
  ...NOVEL_DOMAIN_MUTATIONS,
  "set_world_image_from_url",
  "create_note",
  "update_note",
  "delete_note",
];

function mutatingKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => MUTATING_PREFIX.test(k));
}

describe("buildExplorerTools", () => {
  const keys = Object.keys(buildExplorerTools(makeStubCtx()));

  it("excludes every mutating novel/chapter/scene tool (queryOnly)", () => {
    for (const name of NOVEL_DOMAIN_MUTATIONS) {
      expect(keys).not.toContain(name);
    }
  });

  it("keeps the novel/chapter/scene query tools", () => {
    for (const name of [
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
    ]) {
      expect(keys).toContain(name);
    }
  });

  it("carries full worldbook CRUD", () => {
    for (const name of WORLDBOOK_MUTATIONS) {
      expect(keys).toContain(name);
    }
    for (const name of [
      "list_characters",
      "search_characters",
      "get_character",
      "count_character_refs",
      "count_phase_refs",
      "list_events",
      "search_events",
      "get_event",
    ]) {
      expect(keys).toContain(name);
    }
  });

  it("admits no mutating key outside the worldbook/world/note domains", () => {
    const allowed = new Set([
      ...WORLDBOOK_MUTATIONS,
      "set_world_image_from_url",
      "create_note",
      "update_note",
      "delete_note",
    ]);
    for (const key of mutatingKeys(keys)) {
      expect(allowed).toContain(key);
    }
  });
});

describe("buildWriterTools", () => {
  const keys = Object.keys(buildWriterTools(makeStubCtx()));

  it("excludes every mutating worldbook tool (queryOnly)", () => {
    for (const name of WORLDBOOK_MUTATIONS) {
      expect(keys).not.toContain(name);
    }
  });

  it("keeps the worldbook query tools", () => {
    for (const name of [
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
    ]) {
      expect(keys).toContain(name);
    }
  });

  it("carries full novel/chapter/scene CRUD", () => {
    for (const name of NOVEL_DOMAIN_MUTATIONS) {
      expect(keys).toContain(name);
    }
    for (const name of [
      "list_novels",
      "search_novels",
      "get_novel",
      "get_chapter_overview",
    ]) {
      expect(keys).toContain(name);
    }
  });

  it("admits no mutating key outside the novel/world/note domains", () => {
    const allowed = new Set(SHARED_MUTATIONS);
    for (const key of mutatingKeys(keys)) {
      expect(allowed).toContain(key);
    }
  });
});

describe("shared surfaces (both roles)", () => {
  it("include notes, system, web, grep, timeline, and the world cover tool", () => {
    for (const build of [buildExplorerTools, buildWriterTools]) {
      const keys = Object.keys(build(makeStubCtx()));
      for (const name of [
        // Notes (prompt-gated, never behind queryOnly — ADR-0037)
        "list_notes",
        "get_note",
        "grep_notes",
        "create_note",
        "update_note",
        "delete_note",
        // System (+ timemapper via systemTools)
        "get_current_time",
        "plan",
        "context_read",
        "format_time",
        // Web
        "web_search",
        "web_fetch",
        "web_fetch_via_browser",
        // Match-centric retrieval + timeline
        "grep",
        "timeline_lookup",
        // World cover image (configurable on both roles)
        "set_world_image_from_url",
      ]) {
        expect(keys).toContain(name);
      }
    }
  });
});

describe("shell registration (ADR-0041/0042)", () => {
  it("omits run_shell_command when shellToolEnabled is false", () => {
    expect(Object.keys(buildExplorerTools(makeStubCtx()))).not.toContain(
      "run_shell_command",
    );
    expect(Object.keys(buildWriterTools(makeStubCtx()))).not.toContain(
      "run_shell_command",
    );
  });

  it("registers run_shell_command when shellToolEnabled is true", () => {
    expect(
      Object.keys(buildExplorerTools(makeStubCtx({ shellToolEnabled: true }))),
    ).toContain("run_shell_command");
    expect(
      Object.keys(buildWriterTools(makeStubCtx({ shellToolEnabled: true }))),
    ).toContain("run_shell_command");
  });
});
