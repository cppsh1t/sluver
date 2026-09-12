/**
 * Tests for the shared image-from-attachment infra (filename schema, the
 * entity set body, and the scene-gallery add bodies), mirroring
 * image-from-url.test.ts. `@/api/image`'s prepareImage is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { prepareImage } from "@/api/image";
import {
  sceneIdSchema,
  sceneImageIdSchema,
  spaceIdSchema,
  worldIdSchema,
  type SceneImageMeta,
} from "@/types";
import type { ToolContext } from "../types";
import { ENTITY_IMAGE_CROP_SPEC } from "./image-from-url";
import {
  SCENE_IMAGE_MAX_DIMENSION,
  executeAddSceneImageFromAttachment,
  executeAddSceneImageFromUrl,
  executeSetImageFromAttachment,
  filenameSchema,
} from "./image-from-attachment";

vi.mock("@/api/image", () => ({
  prepareImage: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer),
}));

const spaceId = spaceIdSchema.parse("space-1");
const worldId = worldIdSchema.parse("world-1");

const ATTACHMENT = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
};

const TIMESTAMP = "2026-01-01T00:00:00Z";

function makeSceneImageMeta(): SceneImageMeta {
  return {
    id: sceneImageIdSchema.parse("img-1"),
    sceneId: sceneIdSchema.parse("sc-1"),
    position: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function makeStubCtx(
  attachment: { dataUrl: string; mediaType: string } | null = ATTACHMENT,
): ToolContext {
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
    attachmentLookup: { findByFilename: vi.fn(() => attachment) },
    entityImageLookup: { findByEntity: vi.fn(async () => null) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SCENE_IMAGE_MAX_DIMENSION", () => {
  it("is 1600 (fit-within ceiling, aspect preserved)", () => {
    expect(SCENE_IMAGE_MAX_DIMENSION).toBe(1600);
  });
});

describe("filenameSchema", () => {
  it("rejects an empty filename", () => {
    expect(filenameSchema.safeParse("").success).toBe(false);
  });

  it("accepts a non-empty filename", () => {
    expect(filenameSchema.safeParse("portrait.png").success).toBe(true);
  });
});

describe("executeSetImageFromAttachment", () => {
  it("strips the data URL to its base64 payload, compresses with the entity crop spec, and forwards WebP bytes", async () => {
    const mutator = vi.fn(
      async (_bytes: Uint8Array, _mime: "image/webp") => undefined,
    );

    const result = await executeSetImageFromAttachment(
      makeStubCtx(),
      "portrait.png",
      ENTITY_IMAGE_CROP_SPEC.character,
      mutator,
    );

    expect(prepareImage).toHaveBeenCalledWith({
      dataBase64: "iVBORw0KGgo=",
      width: 300,
      height: 400,
    });
    expect(mutator).toHaveBeenCalledTimes(1);
    const [bytes, mime] = mutator.mock.calls[0];
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(mime).toBe("image/webp");
    expect(result).toEqual({ updated: true });
  });

  it("returns a structured attachment_not_found result (no throw) on a miss", async () => {
    const mutator = vi.fn(
      async (_bytes: Uint8Array, _mime: "image/webp") => undefined,
    );

    const result = await executeSetImageFromAttachment(
      makeStubCtx(null),
      "missing.png",
      ENTITY_IMAGE_CROP_SPEC.world,
      mutator,
    );

    expect(result).toEqual({
      error: "attachment_not_found",
      filename: "missing.png",
      message: expect.stringContaining("missing.png"),
    });
    expect(prepareImage).not.toHaveBeenCalled();
    expect(mutator).not.toHaveBeenCalled();
  });
});

describe("executeAddSceneImageFromUrl", () => {
  it("downscales with maxDimension (no crop args) and returns the mutator's meta", async () => {
    const meta = makeSceneImageMeta();
    const mutator = vi.fn(async () => meta);

    const result = await executeAddSceneImageFromUrl(
      makeStubCtx(),
      "https://example.com/ref.jpg",
      mutator,
    );

    expect(prepareImage).toHaveBeenCalledWith({
      url: "https://example.com/ref.jpg",
      maxDimension: SCENE_IMAGE_MAX_DIMENSION,
    });
    expect(mutator).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3, 4]),
      "image/webp",
    );
    expect(result).toBe(meta);
  });
});

describe("executeAddSceneImageFromAttachment", () => {
  it("resolves the attachment, downscales with maxDimension, and returns the meta", async () => {
    const meta = makeSceneImageMeta();
    const mutator = vi.fn(async () => meta);

    const result = await executeAddSceneImageFromAttachment(
      makeStubCtx(),
      "ref.png",
      mutator,
    );

    expect(prepareImage).toHaveBeenCalledWith({
      dataBase64: "iVBORw0KGgo=",
      maxDimension: SCENE_IMAGE_MAX_DIMENSION,
    });
    expect(result).toBe(meta);
  });

  it("returns a structured attachment_not_found result on a miss", async () => {
    const mutator = vi.fn(async () => makeSceneImageMeta());

    const result = await executeAddSceneImageFromAttachment(
      makeStubCtx(null),
      "missing.png",
      mutator,
    );

    expect(result).toEqual({
      error: "attachment_not_found",
      filename: "missing.png",
      message: expect.stringContaining("missing.png"),
    });
    expect(mutator).not.toHaveBeenCalled();
  });
});
