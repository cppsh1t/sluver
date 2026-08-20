/**
 * Character domain tool tests — passthrough queries, read-merge-write updates,
 * phase tri-state semantics, best-effort delete snapshots, and the image tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPhase,
  countCharacterRefs,
  countPhaseRefs,
  deleteCharacter,
  deletePhase,
  getCharacter,
  listCharacterSummaries,
  listCharacters,
  reorderPhases,
  searchCharacters,
  updateCharacter,
  updatePhase,
} from "@/api/character";
import { updateCharacterImage } from "@/api/image";
import { fetchAndPrepareImage } from "@/api/search";
import {
  characterIdSchema,
  eventIdSchema,
  phaseIdSchema,
  spaceIdSchema,
  worldIdSchema,
  type Character,
  type CharacterPhase,
  type PhaseId,
} from "@/types";
import type { ToolContext } from "../types";
import { characterTools } from "./character";

vi.mock("@/api/character", () => ({
  addPhase: vi.fn(),
  countCharacterRefs: vi.fn(),
  countPhaseRefs: vi.fn(),
  createCharacter: vi.fn(),
  deleteCharacter: vi.fn(),
  deletePhase: vi.fn(),
  getCharacter: vi.fn(),
  listCharacterSummaries: vi.fn(),
  listCharacters: vi.fn(),
  reorderPhases: vi.fn(),
  searchCharacters: vi.fn(),
  updateCharacter: vi.fn(),
  updatePhase: vi.fn(),
}));

vi.mock("@/api/image", () => ({
  updateCharacterImage: vi.fn(),
  updatePhaseImage: vi.fn(),
}));

vi.mock("@/api/search", () => ({
  fetchAndPrepareImage: vi.fn(async () => new Uint8Array([9, 9, 9]).buffer),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");
const characterId = characterIdSchema.parse("ch-1");
const phaseId = phaseIdSchema.parse("ph-1");
const otherPhaseId = phaseIdSchema.parse("ph-2");
const triggerEventId = eventIdSchema.parse("ev-1");

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

function makePhase(
  id: PhaseId,
  overrides: Partial<CharacterPhase> = {},
): CharacterPhase {
  return {
    id,
    characterId,
    name: "Youth",
    appearance: "Slim, unscarred",
    description: "Before the fall",
    conversationStyle: "Curt",
    triggerEventId: null,
    triggerEventName: null,
    hasImage: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: characterId,
    worldId,
    name: "Elric",
    aliases: ["White Wolf"],
    description: "Sorcerer-emperor of Melniboné",
    phases: [],
    notes: "Author notes",
    tags: ["sorcerer"],
    hasImage: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const tools = characterTools();
const ctx = makeStubCtx();
const call = { abortSignal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("query tools", () => {
  it("list_characters passes spaceId and worldId", async () => {
    const summaries = [{ id: characterId, name: "Elric", tags: ["sorcerer"] }];
    vi.mocked(listCharacterSummaries).mockResolvedValue(summaries);

    const result = await tools.list_characters.execute({}, ctx, call);

    expect(listCharacterSummaries).toHaveBeenCalledWith(spaceId, worldId);
    expect(result).toEqual(summaries);
  });

  it("search_characters passes the query", async () => {
    const summaries = [{ id: characterId, name: "Elric", tags: [] }];
    vi.mocked(searchCharacters).mockResolvedValue(summaries);

    const result = await tools.search_characters.execute(
      { query: "wolf" },
      ctx,
      call,
    );

    expect(searchCharacters).toHaveBeenCalledWith(spaceId, worldId, "wolf");
    expect(result).toEqual(summaries);
  });

  it("get_character passes the id", async () => {
    const character = makeCharacter();
    vi.mocked(getCharacter).mockResolvedValue(character);

    const result = await tools.get_character.execute(
      { id: "ch-1" },
      ctx,
      call,
    );

    expect(getCharacter).toHaveBeenCalledWith(spaceId, worldId, characterId);
    expect(result).toBe(character);
  });

  it("count_character_refs and count_phase_refs pass their ids", async () => {
    const counts = { events: 2, scenes: 1 };
    vi.mocked(countCharacterRefs).mockResolvedValue(counts);
    vi.mocked(countPhaseRefs).mockResolvedValue(counts);

    await expect(
      tools.count_character_refs.execute({ characterId: "ch-1" }, ctx, call),
    ).resolves.toEqual(counts);
    await expect(
      tools.count_phase_refs.execute({ phaseId: "ph-1" }, ctx, call),
    ).resolves.toEqual(counts);

    expect(countCharacterRefs).toHaveBeenCalledWith(
      spaceId,
      worldId,
      characterId,
    );
    expect(countPhaseRefs).toHaveBeenCalledWith(spaceId, worldId, phaseId);
  });
});

describe("update_character", () => {
  it("merges provided fields and falls back to current values for omitted ones", async () => {
    const current = makeCharacter();
    vi.mocked(getCharacter).mockResolvedValue(current);
    const updated = makeCharacter({ name: "Elric VIII" });
    vi.mocked(updateCharacter).mockResolvedValue(updated);

    const result = await tools.update_character.execute(
      { id: "ch-1", name: "Elric VIII" },
      ctx,
      call,
    );

    expect(getCharacter).toHaveBeenCalledWith(spaceId, worldId, characterId);
    expect(updateCharacter).toHaveBeenCalledWith(spaceId, worldId, characterId, {
      name: "Elric VIII",
      aliases: current.aliases,
      description: current.description,
      notes: current.notes,
      tags: current.tags,
    });
    expect(result).toBe(updated);
  });
});

describe("update_phase", () => {
  const phase = makePhase(phaseId, {
    name: "Exile",
    appearance: "Gaunt",
    description: "Wandering the Young Kingdoms",
    conversationStyle: "Bitter",
    triggerEventId,
    triggerEventName: "The Fall",
  });

  function seedCharacters() {
    const characters = [
      makeCharacter({ phases: [makePhase(otherPhaseId), phase] }),
    ];
    vi.mocked(listCharacters).mockResolvedValue(characters);
    vi.mocked(updatePhase).mockResolvedValue(phase);
  }

  it("keeps every omitted field and the current triggerEventId", async () => {
    seedCharacters();

    await tools.update_phase.execute({ phaseId: "ph-1" }, ctx, call);

    expect(updatePhase).toHaveBeenCalledWith(spaceId, worldId, phaseId, {
      name: "Exile",
      appearance: "Gaunt",
      description: "Wandering the Young Kingdoms",
      conversationStyle: "Bitter",
      triggerEventId,
    });
  });

  it("clears triggerEventId when the input passes null (not undefined)", async () => {
    seedCharacters();

    await tools.update_phase.execute(
      { phaseId: "ph-1", triggerEventId: null },
      ctx,
      call,
    );

    const input = vi.mocked(updatePhase).mock.calls[0][3];
    expect(input.triggerEventId).toBe(null);
  });

  it("sets triggerEventId when the input passes a string", async () => {
    seedCharacters();
    const newEventId = eventIdSchema.parse("ev-2");

    await tools.update_phase.execute(
      { phaseId: "ph-1", triggerEventId: "ev-2" },
      ctx,
      call,
    );

    const input = vi.mocked(updatePhase).mock.calls[0][3];
    expect(input.triggerEventId).toEqual(newEventId);
  });

  it("rejects when no character carries the phase", async () => {
    vi.mocked(listCharacters).mockResolvedValue([
      makeCharacter({ phases: [makePhase(otherPhaseId)] }),
    ]);

    await expect(
      tools.update_phase.execute({ phaseId: "ph-1" }, ctx, call),
    ).rejects.toThrow(/Phase not found/);
    expect(updatePhase).not.toHaveBeenCalled();
  });
});

describe("delete_character", () => {
  it("still deletes when the snapshot read fails, without a snapshot field", async () => {
    vi.mocked(getCharacter).mockRejectedValue(new Error("NOT_FOUND"));

    const result = await tools.delete_character.execute(
      { id: "ch-1" },
      ctx,
      call,
    );

    expect(deleteCharacter).toHaveBeenCalledWith(spaceId, worldId, characterId);
    expect(result).toEqual({ deleted: true, id: "ch-1" });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("returns the pre-delete snapshot on the happy path", async () => {
    const current = makeCharacter();
    vi.mocked(getCharacter).mockResolvedValue(current);

    const result = await tools.delete_character.execute(
      { id: "ch-1" },
      ctx,
      call,
    );

    expect(result).toEqual({ deleted: true, id: "ch-1", snapshot: current });
  });
});

describe("delete_phase", () => {
  it("snapshots the phase via listCharacters and deletes", async () => {
    vi.mocked(listCharacters).mockResolvedValue([
      makeCharacter({ phases: [makePhase(phaseId, { name: "Exile" })] }),
    ]);

    const result = await tools.delete_phase.execute(
      { phaseId: "ph-1" },
      ctx,
      call,
    );

    expect(deletePhase).toHaveBeenCalledWith(spaceId, worldId, phaseId);
    expect(result).toEqual({
      deleted: true,
      id: "ph-1",
      snapshot: makePhase(phaseId, { name: "Exile" }),
    });
  });

  it("still deletes when the snapshot read fails", async () => {
    vi.mocked(listCharacters).mockRejectedValue(new Error("db unavailable"));

    const result = await tools.delete_phase.execute(
      { phaseId: "ph-1" },
      ctx,
      call,
    );

    expect(deletePhase).toHaveBeenCalledWith(spaceId, worldId, phaseId);
    expect(result).toEqual({ deleted: true, id: "ph-1" });
  });
});

describe("add_phase", () => {
  it("splits characterId from the rest of the payload", async () => {
    const created = makePhase(phaseId, { name: "Exile", appearance: "Gaunt" });
    vi.mocked(addPhase).mockResolvedValue(created);

    const result = await tools.add_phase.execute(
      { characterId: "ch-1", name: "Exile", appearance: "Gaunt" },
      ctx,
      call,
    );

    expect(addPhase).toHaveBeenCalledWith(spaceId, worldId, characterId, {
      name: "Exile",
      appearance: "Gaunt",
    });
    expect(result).toBe(created);
  });
});

describe("reorder_phases", () => {
  it("echoes {reordered, characterId, order}", async () => {
    const result = await tools.reorder_phases.execute(
      { characterId: "ch-1", phaseIds: ["ph-2", "ph-1"] },
      ctx,
      call,
    );

    expect(reorderPhases).toHaveBeenCalledWith(spaceId, worldId, characterId, [
      otherPhaseId,
      phaseId,
    ]);
    expect(result).toEqual({
      reordered: true,
      characterId: "ch-1",
      order: ["ph-2", "ph-1"],
    });
  });
});

describe("set_character_image_from_url", () => {
  it("crops to the 3:4 300×400 character spec and writes WebP bytes", async () => {
    const result = await tools.set_character_image_from_url.execute(
      { characterId: "ch-1", imageUrl: "https://example.com/pic.jpg" },
      ctx,
      call,
    );

    expect(fetchAndPrepareImage).toHaveBeenCalledWith(
      "https://example.com/pic.jpg",
      3 / 4,
      300,
      400,
    );
    expect(updateCharacterImage).toHaveBeenCalledWith(
      spaceId,
      worldId,
      characterId,
      new Uint8Array([9, 9, 9]),
      "image/webp",
    );
    expect(result).toEqual({ updated: true });
  });
});
