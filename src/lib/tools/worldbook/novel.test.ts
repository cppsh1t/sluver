/**
 * Novel domain tool tests — scene junction merge semantics, snapshot-free
 * deletes, reorder echoes, novel read-merge-write, the 2:3 cover tool, and
 * create_scene schema spot-checks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  deleteNovel,
  getNovel,
  getScene,
  reorderChapters,
  reorderScenes,
  updateNovel,
  updateScene,
} from "@/api/novel";
import { updateNovelImage } from "@/api/image";
import { fetchAndPrepareImage } from "@/api/search";
import {
  chapterIdSchema,
  characterIdSchema,
  eventIdSchema,
  itemIdSchema,
  locationIdSchema,
  loreIdSchema,
  novelIdSchema,
  phaseIdSchema,
  sceneIdSchema,
  spaceIdSchema,
  worldIdSchema,
  type CharacterRef,
  type Novel,
  type Scene,
} from "@/types";
import type { ToolContext } from "../types";
import { chapterTools, novelTools, sceneTools } from "./novel";

vi.mock("@/api/novel", () => ({
  createChapter: vi.fn(),
  createNovel: vi.fn(),
  createScene: vi.fn(),
  deleteChapter: vi.fn(),
  deleteNovel: vi.fn(),
  deleteScene: vi.fn(),
  getChapter: vi.fn(),
  getChapterOverview: vi.fn(),
  getNovel: vi.fn(),
  getScene: vi.fn(),
  listChapterSummaries: vi.fn(),
  listNovelSummaries: vi.fn(),
  listSceneSummaries: vi.fn(),
  reorderChapters: vi.fn(),
  reorderScenes: vi.fn(),
  searchChapters: vi.fn(),
  searchNovels: vi.fn(),
  searchScenes: vi.fn(),
  updateChapter: vi.fn(),
  updateNovel: vi.fn(),
  updateScene: vi.fn(),
}));

vi.mock("@/api/image", () => ({
  updateNovelImage: vi.fn(),
}));

vi.mock("@/api/search", () => ({
  fetchAndPrepareImage: vi.fn(async () => new Uint8Array([3, 3]).buffer),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");
const novelId = novelIdSchema.parse("nv-1");
const chapterId = chapterIdSchema.parse("cp-1");
const otherChapterId = chapterIdSchema.parse("cp-2");
const sceneId = sceneIdSchema.parse("sc-1");
const locationId = locationIdSchema.parse("loc-1");

const refA: CharacterRef = {
  characterId: characterIdSchema.parse("ch-1"),
  phaseId: phaseIdSchema.parse("ph-1"),
};
const refB: CharacterRef = {
  characterId: characterIdSchema.parse("ch-2"),
  phaseId: phaseIdSchema.parse("ph-2"),
};

const itemIds = [itemIdSchema.parse("it-1")];
const eventIds = [eventIdSchema.parse("ev-9")];
const loreIds = [loreIdSchema.parse("lo-1")];

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
    ...overrides,
  };
}

const TIMESTAMP = "2026-01-01T00:00:00Z";

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: sceneId,
    chapterId,
    title: "The burning harbor",
    summary: "Ships burn at anchor",
    content: "It began with a single sail…",
    startAt: null,
    endAt: null,
    characterRefs: [refA],
    locationId,
    itemIds,
    eventIds,
    loreIds,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeNovel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: novelId,
    worldId,
    title: "Stormbringer",
    description: "A doomed romance",
    author: "M. Moorcock",
    chapterIds: [chapterId],
    tags: ["fantasy"],
    hasImage: false,
    wordCount: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

const ctx = makeStubCtx();
const call = { abortSignal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("update_scene", () => {
  it("keeps every current junction value when the input omits them", async () => {
    const current = makeScene();
    vi.mocked(getScene).mockResolvedValue(current);
    vi.mocked(updateScene).mockResolvedValue(current);

    await sceneTools().update_scene.execute(
      { id: "sc-1", title: "A colder dawn" },
      ctx,
      call,
    );

    expect(updateScene).toHaveBeenCalledWith(spaceId, worldId, sceneId, {
      title: "A colder dawn",
      summary: current.summary,
      content: current.content,
      startAt: current.startAt,
      endAt: current.endAt,
      characterRefs: [refA],
      locationId,
      itemIds,
      eventIds,
      loreIds,
    });
  });

  it("replaces provided junction arrays and keeps omitted ones", async () => {
    const current = makeScene();
    vi.mocked(getScene).mockResolvedValue(current);
    vi.mocked(updateScene).mockResolvedValue(current);

    await sceneTools().update_scene.execute(
      {
        id: "sc-1",
        itemIds: ["it-2"],
        loreIds: ["lo-2"],
        characterRefs: [{ characterId: "ch-2", phaseId: "ph-2" }],
      },
      ctx,
      call,
    );

    const input = vi.mocked(updateScene).mock.calls[0][3];
    expect(input.itemIds).toEqual(["it-2"]);
    expect(input.loreIds).toEqual(["lo-2"]);
    expect(input.characterRefs).toEqual([refB]);
    // Omitted junctions keep the current values.
    expect(input.eventIds).toEqual(["ev-9"]);
    expect(input.locationId).toEqual(locationId);  });
});

describe("delete_novel", () => {
  it("returns {deleted, id} with NO snapshot (unlike character)", async () => {
    const result = await novelTools().delete_novel.execute(
      { id: "nv-1" },
      ctx,
      call,
    );

    expect(deleteNovel).toHaveBeenCalledWith(spaceId, worldId, novelId);
    expect(result).toEqual({ deleted: true, id: "nv-1" });
    expect(result).not.toHaveProperty("snapshot");
    expect(getNovel).not.toHaveBeenCalled();
  });
});

describe("reorder tools", () => {
  it("reorder_chapters echoes {reordered, novelId, order}", async () => {
    const result = await chapterTools().reorder_chapters.execute(
      { novelId: "nv-1", chapterIds: ["cp-2", "cp-1"] },
      ctx,
      call,
    );

    expect(reorderChapters).toHaveBeenCalledWith(spaceId, worldId, novelId, [
      otherChapterId,
      chapterId,
    ]);
    expect(result).toEqual({
      reordered: true,
      novelId: "nv-1",
      order: ["cp-2", "cp-1"],
    });
  });

  it("reorder_scenes echoes {reordered, chapterId, order}", async () => {
    const result = await sceneTools().reorder_scenes.execute(
      { chapterId: "cp-1", sceneIds: ["sc-1"] },
      ctx,
      call,
    );

    expect(reorderScenes).toHaveBeenCalledWith(spaceId, worldId, chapterId, [
      sceneId,
    ]);
    expect(result).toEqual({
      reordered: true,
      chapterId: "cp-1",
      order: ["sc-1"],
    });
  });
});

describe("update_novel", () => {
  it("merges provided fields and falls back to current values for omitted ones", async () => {
    const current = makeNovel();
    vi.mocked(getNovel).mockResolvedValue(current);
    const updated = makeNovel({ author: "Anonymous" });
    vi.mocked(updateNovel).mockResolvedValue(updated);

    const result = await novelTools().update_novel.execute(
      { id: "nv-1", author: "Anonymous" },
      ctx,
      call,
    );

    expect(updateNovel).toHaveBeenCalledWith(spaceId, worldId, novelId, {
      title: current.title,
      description: current.description,
      author: "Anonymous",
      tags: current.tags,
    });
    expect(result).toBe(updated);
  });
});

describe("set_novel_image_from_url", () => {
  it("crops to the 2:3 320×480 cover spec and writes WebP bytes", async () => {
    const result = await novelTools().set_novel_image_from_url.execute(
      { id: "nv-1", imageUrl: "https://example.com/cover.jpg" },
      ctx,
      call,
    );

    expect(fetchAndPrepareImage).toHaveBeenCalledWith(
      "https://example.com/cover.jpg",
      2 / 3,
      320,
      480,
    );
    expect(updateNovelImage).toHaveBeenCalledWith(
      spaceId,
      worldId,
      novelId,
      new Uint8Array([3, 3]),
      "image/webp",
    );
    expect(result).toEqual({ updated: true });
  });
});

describe("create_scene schema", () => {
  const schema = sceneTools().create_scene.inputSchema as unknown as z.ZodType;

  it("requires chapterId and title", () => {
    expect(schema.safeParse({ title: "X" }).success).toBe(false);
    expect(schema.safeParse({ chapterId: "cp-1" }).success).toBe(false);
    expect(schema.safeParse({ chapterId: "cp-1", title: "X" }).success).toBe(
      true,
    );
  });
});
