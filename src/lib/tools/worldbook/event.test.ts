/**
 * Event domain tool tests — create passthrough (incl. characterRefs),
 * read-merge-write with junction replacement semantics, best-effort delete
 * snapshot, the 16:9 image tool, and ISO datetime schema spot-checks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createEvent, deleteEvent, getEvent, updateEvent } from "@/api/event";
import { updateEventImage } from "@/api/image";
import { fetchAndPrepareImage } from "@/api/search";
import {
  characterIdSchema,
  eventIdSchema,
  locationIdSchema,
  phaseIdSchema,
  spaceIdSchema,
  worldIdSchema,
  type CharacterRef,
  type Event,
} from "@/types";
import type { ToolContext } from "../types";
import { eventTools } from "./event";

vi.mock("@/api/event", () => ({
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getEvent: vi.fn(),
  listEventSummaries: vi.fn(),
  searchEvents: vi.fn(),
  updateEvent: vi.fn(),
}));

vi.mock("@/api/image", () => ({
  updateEventImage: vi.fn(),
}));

vi.mock("@/api/search", () => ({
  fetchAndPrepareImage: vi.fn(async () => new Uint8Array([5, 5, 5]).buffer),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");
const eventId = eventIdSchema.parse("ev-1");
const locationId = locationIdSchema.parse("loc-1");

const refA: CharacterRef = {
  characterId: characterIdSchema.parse("ch-1"),
  phaseId: phaseIdSchema.parse("ph-1"),
};
const refB: CharacterRef = {
  characterId: characterIdSchema.parse("ch-2"),
  phaseId: phaseIdSchema.parse("ph-2"),
};

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

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: eventId,
    worldId,
    name: "The Fall",
    description: "Imrryr burns",
    startAt: null,
    endAt: null,
    characterRefs: [refA],
    locationId,
    notes: "Author notes",
    tags: ["war"],
    hasImage: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

const tools = eventTools();
const ctx = makeStubCtx();
const call = { abortSignal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_event", () => {
  it("passes spaceId, worldId, and id", async () => {
    const event = makeEvent();
    vi.mocked(getEvent).mockResolvedValue(event);

    const result = await tools.get_event.execute({ id: "ev-1" }, ctx, call);

    expect(getEvent).toHaveBeenCalledWith(spaceId, worldId, eventId);
    expect(result).toBe(event);
  });
});

describe("create_event", () => {
  it("passes the input through unchanged, including characterRefs", async () => {
    const created = makeEvent({
      id: eventIdSchema.parse("ev-2"),
      name: "The Sack",
      characterRefs: [refB],
    });
    vi.mocked(createEvent).mockResolvedValue(created);

    const input = {
      name: "The Sack",
      characterRefs: [{ characterId: "ch-2", phaseId: "ph-2" }],
      locationId: "loc-1",
    };
    const result = await tools.create_event.execute(input, ctx, call);

    expect(createEvent).toHaveBeenCalledWith(spaceId, worldId, {
      name: "The Sack",
      characterRefs: [refB],
      locationId,
    });
    expect(result).toBe(created);
  });
});

describe("update_event", () => {
  it("keeps current junction values when the input omits them", async () => {
    const current = makeEvent();
    vi.mocked(getEvent).mockResolvedValue(current);
    const updated = makeEvent({ name: "The Long Fall" });
    vi.mocked(updateEvent).mockResolvedValue(updated);

    const result = await tools.update_event.execute(
      { id: "ev-1", name: "The Long Fall" },
      ctx,
      call,
    );

    expect(updateEvent).toHaveBeenCalledWith(spaceId, worldId, eventId, {
      name: "The Long Fall",
      description: current.description,
      startAt: current.startAt,
      endAt: current.endAt,
      characterRefs: [refA],
      locationId,
      notes: current.notes,
      tags: current.tags,
    });
    expect(result).toBe(updated);
  });

  it("replaces characterRefs and locationId only when provided", async () => {
    vi.mocked(getEvent).mockResolvedValue(makeEvent());
    vi.mocked(updateEvent).mockResolvedValue(makeEvent());

    await tools.update_event.execute(
      { id: "ev-1", characterRefs: [{ characterId: "ch-2", phaseId: "ph-2" }] },
      ctx,
      call,
    );

    const input = vi.mocked(updateEvent).mock.calls[0][3];
    expect(input.characterRefs).toEqual([refB]);
    // locationId was omitted → current value kept.
    expect(input.locationId).toEqual(locationId);

    await tools.update_event.execute(
      { id: "ev-1", locationId: "loc-2" },
      ctx,
      call,
    );

    const secondInput = vi.mocked(updateEvent).mock.calls[1][3];
    expect(secondInput.locationId).toEqual(locationIdSchema.parse("loc-2"));
    // characterRefs omitted in the second call → current array kept.
    expect(secondInput.characterRefs).toEqual([refA]);
  });
});

describe("delete_event", () => {
  it("still deletes when the snapshot read fails, without a snapshot field", async () => {
    vi.mocked(getEvent).mockRejectedValue(new Error("NOT_FOUND"));

    const result = await tools.delete_event.execute({ id: "ev-1" }, ctx, call);

    expect(deleteEvent).toHaveBeenCalledWith(spaceId, worldId, eventId);
    expect(result).toEqual({ deleted: true, id: "ev-1" });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("returns the pre-delete snapshot on the happy path", async () => {
    const current = makeEvent();
    vi.mocked(getEvent).mockResolvedValue(current);

    const result = await tools.delete_event.execute({ id: "ev-1" }, ctx, call);

    expect(result).toEqual({ deleted: true, id: "ev-1", snapshot: current });
  });
});

describe("set_event_image_from_url", () => {
  it("crops to the 16:9 640×360 event spec and writes WebP bytes", async () => {
    const result = await tools.set_event_image_from_url.execute(
      { id: "ev-1", imageUrl: "https://example.com/battle.jpg" },
      ctx,
      call,
    );

    expect(fetchAndPrepareImage).toHaveBeenCalledWith(
      "https://example.com/battle.jpg",
      16 / 9,
      640,
      360,
    );
    expect(updateEventImage).toHaveBeenCalledWith(
      spaceId,
      worldId,
      eventId,
      new Uint8Array([5, 5, 5]),
      "image/webp",
    );
    expect(result).toEqual({ updated: true });
  });
});

describe("create_event schema", () => {
  const schema = tools.create_event.inputSchema as unknown as z.ZodType;

  it("rejects a non-ISO startAt", () => {
    const result = schema.safeParse({ name: "X", startAt: "midnight" });
    expect(result.success).toBe(false);
  });

  it("accepts an ISO 8601 startAt with Z offset", () => {
    const result = schema.safeParse({
      name: "X",
      startAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});
