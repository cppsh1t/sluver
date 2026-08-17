/**
 * Tests for the shared image-from-URL infra (crop spec table, URL schema,
 * and the common execute body).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAndPrepareImage } from "@/api/search";
import { spaceIdSchema, worldIdSchema } from "@/types";
import type { ToolContext } from "../types";
import {
  ENTITY_IMAGE_CROP_SPEC,
  executeSetImageFromUrl,
  imageUrlSchema,
} from "./image-from-url";

vi.mock("@/api/search", () => ({
  fetchAndPrepareImage: vi.fn(
    async () => new Uint8Array([1, 2, 3, 4]).buffer,
  ),
}));

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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ENTITY_IMAGE_CROP_SPEC", () => {
  it("matches the per-entity aspect/size table exactly", () => {
    expect(ENTITY_IMAGE_CROP_SPEC).toEqual({
      world: { aspect: 16 / 9, outputWidth: 640, outputHeight: 360 },
      character: { aspect: 3 / 4, outputWidth: 300, outputHeight: 400 },
      phase: { aspect: 3 / 4, outputWidth: 300, outputHeight: 400 },
      location: { aspect: 4 / 3, outputWidth: 400, outputHeight: 300 },
      item: { aspect: 1, outputWidth: 256, outputHeight: 256 },
      lore: { aspect: 1, outputWidth: 256, outputHeight: 256 },
      event: { aspect: 16 / 9, outputWidth: 640, outputHeight: 360 },
      novel: { aspect: 2 / 3, outputWidth: 320, outputHeight: 480 },
    });
  });
});

describe("imageUrlSchema", () => {
  it("rejects non-URLs", () => {
    const result = imageUrlSchema.safeParse("not-a-url");
    expect(result.success).toBe(false);
  });

  it("accepts a direct http(s) image URL", () => {
    const result = imageUrlSchema.safeParse("https://example.com/pic.jpg");
    expect(result.success).toBe(true);
  });
});

describe("executeSetImageFromUrl", () => {
  it("downloads with the entity crop spec and forwards WebP bytes to the mutator", async () => {
    const mutator = vi.fn(
      async (_bytes: Uint8Array, _mime: "image/webp") => undefined,
    );
    const ctx = makeStubCtx();

    const result = await executeSetImageFromUrl(
      ctx,
      "https://example.com/pic.jpg",
      ENTITY_IMAGE_CROP_SPEC.character,
      mutator,
    );

    expect(fetchAndPrepareImage).toHaveBeenCalledWith(
      "https://example.com/pic.jpg",
      3 / 4,
      300,
      400,
    );
    expect(mutator).toHaveBeenCalledTimes(1);
    const [bytes, mime] = mutator.mock.calls[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(mime).toBe("image/webp");
    expect(result).toEqual({ updated: true });
  });
});
