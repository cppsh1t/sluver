/**
 * Role registry tests (ADR-0050 D1) — the single source of truth replacing
 * the old two-entry ROLE_BEHAVIOR map. Verifies the registry's shape (11
 * seeded roles, kinds, budgets, consent overrides), the lookup helper, and
 * the orchestrator roster block generated from registry entries.
 */

import { describe, expect, it } from "vitest";

import {
  buildSubagentRosterBlock,
  CONVERSATIONAL_ROLE_NAMES,
  getRoleDefinition,
  LOOP_ROLE_NAMES,
  ONESHOT_ROLE_NAMES,
  ROLE_REGISTRY,
  SEED_ROLE_NAMES,
  SUBAGENT_ROLE_NAMES,
} from "./index";

// ─── Registry shape ───────────────────────────────────────────────────────

describe("ROLE_REGISTRY shape", () => {
  it("has exactly the 11 seeded roles, keyed by name, names matching entries", () => {
    expect(Object.keys(ROLE_REGISTRY).sort()).toEqual([...SEED_ROLE_NAMES].sort());
    for (const def of Object.values(ROLE_REGISTRY)) {
      expect(ROLE_REGISTRY[def.name]).toBe(def);
      expect(def.duty.length).toBeGreaterThan(0);
    }
  });

  it("SEED_ROLE_NAMES holds 11 unique names", () => {
    expect(SEED_ROLE_NAMES).toHaveLength(11);
    expect(new Set(SEED_ROLE_NAMES).size).toBe(11);
  });

  it("partitions roles by kind: 1 conversational + 8 subagents + 2 oneshots", () => {
    expect(CONVERSATIONAL_ROLE_NAMES).toEqual(["orchestrator"]);
    expect(SUBAGENT_ROLE_NAMES).toHaveLength(8);
    expect(ONESHOT_ROLE_NAMES).toEqual(["namer", "vision"]);
    expect(LOOP_ROLE_NAMES).toHaveLength(9);

    const kinds = SEED_ROLE_NAMES.map((n) => ROLE_REGISTRY[n].kind);
    expect(kinds.filter((k) => k === "conversational")).toHaveLength(1);
    expect(kinds.filter((k) => k === "subagent")).toHaveLength(8);
    expect(kinds.filter((k) => k === "oneshot")).toHaveLength(2);

    // The name arrays are disjoint and cover the seed set.
    const partition = [
      ...CONVERSATIONAL_ROLE_NAMES,
      ...SUBAGENT_ROLE_NAMES,
      ...ONESHOT_ROLE_NAMES,
    ].sort();
    expect(partition).toEqual([...SEED_ROLE_NAMES].sort());
  });

  it("assigns maxSteps: orchestrator 10, writer/curator 15, other loop roles 10", () => {
    expect(ROLE_REGISTRY.orchestrator.maxSteps).toBe(10);
    expect(ROLE_REGISTRY.writer.maxSteps).toBe(15);
    expect(ROLE_REGISTRY.curator.maxSteps).toBe(15);
    for (const name of LOOP_ROLE_NAMES) {
      if (name === "writer" || name === "curator") continue;
      expect(ROLE_REGISTRY[name].maxSteps).toBe(10);
    }
  });

  it("every loop role carries a non-empty model-facing English system prompt + a buildTools factory", () => {
    for (const name of LOOP_ROLE_NAMES) {
      const def = ROLE_REGISTRY[name];
      expect(def.systemPrompt.length).toBeGreaterThan(0);
      expect(typeof def.buildTools).toBe("function");
    }
  });

  it("the writer declares the ADR-0050 D5 update_scene consent override; no other role does", () => {
    expect(ROLE_REGISTRY.writer.consentOverrides).toEqual({
      update_scene: "configurable",
    });
    for (const name of LOOP_ROLE_NAMES) {
      if (name === "writer") continue;
      expect(ROLE_REGISTRY[name].consentOverrides).toBeUndefined();
    }
  });
});

// ─── Lookup ───────────────────────────────────────────────────────────────

describe("getRoleDefinition", () => {
  it("resolves every seeded name", () => {
    for (const name of SEED_ROLE_NAMES) {
      expect(getRoleDefinition(name)?.name).toBe(name);
    }
  });

  it("returns undefined for unknown names", () => {
    expect(getRoleDefinition("navigator")).toBeUndefined();
    expect(getRoleDefinition("")).toBeUndefined();
  });
});

// ─── Roster block (ADR-0050 D3) ───────────────────────────────────────────

describe("buildSubagentRosterBlock", () => {
  const block = buildSubagentRosterBlock();

  it("lists all eight subagents with their registry duty lines", () => {
    for (const name of SUBAGENT_ROLE_NAMES) {
      expect(block).toContain(`- ${name}: ${ROLE_REGISTRY[name].duty}`);
    }
  });

  it("never mentions the orchestrator, the one-shots, or the orchestrator-only tools", () => {
    expect(block).not.toContain("- orchestrator:");
    expect(block).not.toContain("namer");
    expect(block).not.toContain("vision");
  });

  it("is wrapped in the <subagent_roster> markers", () => {
    expect(block.startsWith("<subagent_roster>")).toBe(true);
    expect(block.endsWith("</subagent_roster>")).toBe(true);
  });
});
