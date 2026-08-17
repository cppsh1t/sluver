/**
 * Element domain tool tests (Location / Item / Lore) — representative
 * coverage of the shared read-merge-write, best-effort delete, create
 * passthrough, and per-entity crop specs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createLore,
  deleteItem,
  getItem,
  getLocation,
  updateLocation,
} from "@/api/element";
import { updateItemImage, updateLocationImage } from "@/api/image";
import { fetchAndPrepareImage } from "@/api/search";
import {
  itemIdSchema,
  locationIdSchema,
  loreIdSchema,
  spaceIdSchema,
  worldIdSchema,
  type Item,
  type Location,
  type Lore,
} from "@/types";
import type { ToolContext } from "../types";
import { itemTools, locationTools, loreTools } from "./element";

vi.mock("@/api/element", () => ({
  createItem: vi.fn(),
  createLocation: vi.fn(),
  createLore: vi.fn(),
  deleteItem: vi.fn(),
  deleteLocation: vi.fn(),
  deleteLore: vi.fn(),
  getItem: vi.fn(),
  getLocation: vi.fn(),
  getLore: vi.fn(),
  listItemSummaries: vi.fn(),
  listLocationSummaries: vi.fn(),
  listLoreSummaries: vi.fn(),
  searchItems: vi.fn(),
  searchLocations: vi.fn(),
  searchLores: vi.fn(),
  updateItem: vi.fn(),
  updateLocation: vi.fn(),
  updateLore: vi.fn(),
}));

vi.mock("@/api/image", () => ({
  updateItemImage: vi.fn(),
  updateLocationImage: vi.fn(),
  updateLoreImage: vi.fn(),
}));

vi.mock("@/api/search", () => ({
  fetchAndPrepareImage: vi.fn(async () => new Uint8Array([7, 7]).buffer),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");
const locationId = locationIdSchema.parse("loc-1");
const itemId = itemIdSchema.parse("item-1");

function makeStubCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    spaceId,
    worldId,
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(), set: vi.fn() },
    threadLookup: { findToolPair: vi.fn() },
    ...overrides,
  };
}

const TIMESTAMP = "2026-01-01T00:00:00Z";

function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    id: locationId,
    worldId,
    name: "Imrryr",
    description: "The dreaming city",
    notes: "Author notes",
    tags: ["city"],
    hasImage: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: itemId,
    worldId,
    name: "Stormbringer",
    description: "A runesword",
    notes: "",
    tags: ["weapon"],
    hasImage: false,
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

describe("update_location", () => {
  it("merges provided fields and falls back to current values for omitted ones", async () => {
    const current = makeLocation();
    vi.mocked(getLocation).mockResolvedValue(current);
    const updated = makeLocation({ description: "A ruined city" });
    vi.mocked(updateLocation).mockResolvedValue(updated);

    const result = await locationTools().update_location.execute(
      { id: "loc-1", description: "A ruined city" },
      ctx,
      call,
    );

    expect(updateLocation).toHaveBeenCalledWith(spaceId, worldId, locationId, {
      name: current.name,
      description: "A ruined city",
      notes: current.notes,
      tags: current.tags,
    });
    expect(result).toBe(updated);
  });
});

describe("delete_item", () => {
  it("still deletes when the snapshot read fails, without a snapshot field", async () => {
    vi.mocked(getItem).mockRejectedValue(new Error("NOT_FOUND"));

    const result = await itemTools().delete_item.execute(
      { id: "item-1" },
      ctx,
      call,
    );

    expect(deleteItem).toHaveBeenCalledWith(spaceId, worldId, itemId);
    expect(result).toEqual({ deleted: true, id: "item-1" });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("returns the pre-delete snapshot on the happy path", async () => {
    const current = makeItem();
    vi.mocked(getItem).mockResolvedValue(current);

    const result = await itemTools().delete_item.execute(
      { id: "item-1" },
      ctx,
      call,
    );

    expect(result).toEqual({ deleted: true, id: "item-1", snapshot: current });
  });
});

describe("create_lore", () => {
  it("passes the input through unchanged", async () => {
    const created: Lore = {
      id: loreIdSchema.parse("lore-1"),
      worldId,
      name: "The Covenant",
      description: "",
      notes: "",
      tags: ["magic"],
      hasImage: false,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    vi.mocked(createLore).mockResolvedValue(created);

    const result = await loreTools().create_lore.execute(
      { name: "The Covenant", tags: ["magic"] },
      ctx,
      call,
    );

    expect(createLore).toHaveBeenCalledWith(spaceId, worldId, {
      name: "The Covenant",
      tags: ["magic"],
    });
    expect(result).toBe(created);
  });
});

describe("image-from-URL tools", () => {
  it("set_location_image_from_url crops to 4:3 400×300", async () => {
    const result = await locationTools().set_location_image_from_url.execute(
      { id: "loc-1", imageUrl: "https://example.com/map.jpg" },
      ctx,
      call,
    );

    expect(fetchAndPrepareImage).toHaveBeenCalledWith(
      "https://example.com/map.jpg",
      4 / 3,
      400,
      300,
    );
    expect(updateLocationImage).toHaveBeenCalledWith(
      spaceId,
      worldId,
      locationId,
      new Uint8Array([7, 7]),
      "image/webp",
    );
    expect(result).toEqual({ updated: true });
  });

  it("set_item_image_from_url crops to 1:1 256×256 (distinct from location)", async () => {
    await itemTools().set_item_image_from_url.execute(
      { id: "item-1", imageUrl: "https://example.com/sword.png" },
      ctx,
      call,
    );

    expect(fetchAndPrepareImage).toHaveBeenCalledWith(
      "https://example.com/sword.png",
      1,
      256,
      256,
    );
    expect(updateItemImage).toHaveBeenCalledWith(
      spaceId,
      worldId,
      itemId,
      new Uint8Array([7, 7]),
      "image/webp",
    );
  });

  it("set_location_image_from_url rejects a non-URL imageUrl", () => {
    const schema = locationTools().set_location_image_from_url
      .inputSchema as unknown as z.ZodType;
    const bad = schema.safeParse({ id: "loc-1", imageUrl: "not-a-url" });
    expect(bad.success).toBe(false);

    const good = schema.safeParse({
      id: "loc-1",
      imageUrl: "https://example.com/map.jpg",
    });
    expect(good.success).toBe(true);
  });
});
