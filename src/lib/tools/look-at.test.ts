/**
 * Tests for the look_at tool (ADR-0045 + ADR-0048 entity source): input-schema
 * exactly-one-of validation and execute behaviors (attachment hit/miss, url
 * passthrough, entity hit/miss, unconfigured vision agent, vision-call
 * failure vs abort re-throw). `@/lib/ai/look-at` is mocked — describeImage is
 * a vi.fn; the consent gate is bypassed by calling execute directly (see
 * AGENTS.md §Testing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeImage } from "@/lib/ai/look-at";
import type { ResolvedModelConfig } from "@/lib/ai/provider/provider-factory";
import { lookAtTools } from "@/lib/tools/look-at";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import { spaceIdSchema, worldIdSchema } from "@/types";

vi.mock("@/lib/ai/look-at", () => ({
  describeImage: vi.fn(),
}));

// ─── Helpers (inline) ────────────────────────────────────────────────────

const FAKE_VISION_CONFIG: ResolvedModelConfig = {
  npmPackage: "@ai-sdk/mock",
  modelId: "vision-mock",
  apiKey: "sk-test",
};

function makeToolContext(
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    spaceId: spaceIdSchema.parse("space-1"),
    worldId: worldIdSchema.parse("world-1"),
    approvalGate: { request: vi.fn(async () => true) },
    autoExecuteDangerousTools: false,
    shellToolEnabled: false,
    planAccess: { get: vi.fn(() => null), set: vi.fn(async () => {}) },
    threadLookup: { findToolPair: vi.fn(() => undefined) },
    skills: [],
    activatedSkills: new Set(),
    visionConfig: FAKE_VISION_CONFIG,
    attachmentLookup: {
      findByFilename: vi.fn(
        (filename: string) =>
          filename === "sunset.png"
            ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" }
            : null,
      ),
    },
    entityImageLookup: {
      findByEntity: vi.fn(
        async (kind: string, id: string) =>
          kind === "character" && id === "ch-1"
            ? { dataUrl: "data:image/webp;base64,UklGRg==", mediaType: "image/webp" }
            : null,
      ),
    },
    ...overrides,
  };
}

function lookAtTool(): ToolDef {
  const def = lookAtTools().look_at;
  if (!def) {
    throw new Error("look_at tool not found");
  }
  return def;
}

/** See grep.test.ts — `FlexibleSchema` has no `.parse`, zod is the runtime reality. */
function toZod<T>(schema: unknown): z.ZodType<T> {
  return schema as unknown as z.ZodType<T>;
}

type LookAtParsed = {
  filename?: string;
  url?: string;
  entityKind?: string;
  entityId?: string;
  question?: string;
};

const describeImageMock = vi.mocked(describeImage);
const schema = () => toZod<LookAtParsed>(lookAtTools().look_at.inputSchema);

// Clear call history between tests — behavior tests assert call counts.
beforeEach(() => {
  vi.clearAllMocks();
});

const SIGNAL = () => new AbortController().signal;

// ─── Tests ───────────────────────────────────────────────────────────────

describe("look_at", () => {
  it("passes the resolved attachment source + question + abort signal to describeImage and echoes the filename", async () => {
    describeImageMock.mockResolvedValue("A sunset over calm water.");
    const ctx = makeToolContext();
    const abortSignal = SIGNAL();

    const got = await lookAtTool().execute(
      { filename: "sunset.png", question: "What colors?" },
      ctx,
      { abortSignal },
    );

    expect(got).toEqual({
      filename: "sunset.png",
      description: "A sunset over calm water.",
    });
    expect(describeImageMock).toHaveBeenCalledTimes(1);
    expect(describeImageMock).toHaveBeenCalledWith(
      FAKE_VISION_CONFIG,
      {
        kind: "attachment",
        filename: "sunset.png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        mediaType: "image/png",
      },
      "What colors?",
      abortSignal,
    );
  });

  it("passes a url source through untouched", async () => {
    describeImageMock.mockResolvedValue("A cat in a box.");
    const ctx = makeToolContext();

    const got = await lookAtTool().execute(
      { url: "https://example.com/cat.png" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(got).toEqual({
      url: "https://example.com/cat.png",
      description: "A cat in a box.",
    });
    expect(describeImageMock).toHaveBeenCalledWith(
      FAKE_VISION_CONFIG,
      { kind: "url", url: "https://example.com/cat.png" },
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("passes an entity source with the looked-up data URL to describeImage and echoes kind+id", async () => {
    describeImageMock.mockResolvedValue("A gaunt swordsman in white.");
    const ctx = makeToolContext();
    const abortSignal = SIGNAL();

    const got = await lookAtTool().execute(
      { entityKind: "character", entityId: "ch-1", question: "What does he wear?" },
      ctx,
      { abortSignal },
    );

    expect(got).toEqual({
      entityKind: "character",
      entityId: "ch-1",
      description: "A gaunt swordsman in white.",
    });
    expect(ctx.entityImageLookup.findByEntity).toHaveBeenCalledWith(
      "character",
      "ch-1",
    );
    expect(describeImageMock).toHaveBeenCalledTimes(1);
    expect(describeImageMock).toHaveBeenCalledWith(
      FAKE_VISION_CONFIG,
      {
        kind: "entity",
        entityKind: "character",
        entityId: "ch-1",
        dataUrl: "data:image/webp;base64,UklGRg==",
        mediaType: "image/webp",
      },
      "What does he wear?",
      abortSignal,
    );
  });

  it("returns a structured entity_image_not_found error when the entity has no image", async () => {
    const ctx = makeToolContext();

    const got = await lookAtTool().execute(
      { entityKind: "novel", entityId: "nv-404" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(got).toEqual({
      error: "entity_image_not_found",
      entityKind: "novel",
      entityId: "nv-404",
      message: expect.stringContaining("hasImage"),
    });
    expect(describeImageMock).not.toHaveBeenCalled();
  });

  it("examines the current world's cover via ctx.worldId when entityKind is world (no id needed)", async () => {
    describeImageMock.mockResolvedValue("An ink-wash mountain range.");
    const ctx = makeToolContext({
      entityImageLookup: {
        findByEntity: vi.fn(async () => ({
          dataUrl: "data:image/webp;base64,UklGRg==",
          mediaType: "image/webp",
        })),
      },
    });

    const got = await lookAtTool().execute(
      { entityKind: "world" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    // The world's UUID is never model-facing — execute substitutes the
    // conversation's worldId (makeToolContext parses it as "world-1").
    expect(ctx.entityImageLookup.findByEntity).toHaveBeenCalledWith(
      "world",
      "world-1",
    );
    expect(got).toEqual({
      entityKind: "world",
      entityId: "world-1",
      description: "An ink-wash mountain range.",
    });
  });

  it("returns a world-specific remediation when the current world has no cover", async () => {
    const ctx = makeToolContext(); // default lookup misses every kind but character/ch-1

    const got = await lookAtTool().execute(
      { entityKind: "world" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(got).toEqual({
      error: "entity_image_not_found",
      entityKind: "world",
      entityId: "world-1",
      message: expect.stringContaining("set_world_image_from_url"),
    });
    expect(describeImageMock).not.toHaveBeenCalled();
  });

  it("returns a structured attachment_not_found error for an unknown filename", async () => {
    const ctx = makeToolContext();

    const got = await lookAtTool().execute(
      { filename: "missing.png" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(got).toEqual({
      error: "attachment_not_found",
      filename: "missing.png",
      message: expect.stringContaining("missing.png"),
    });
    expect(describeImageMock).not.toHaveBeenCalled();
  });

  it("returns a structured not_configured error when visionConfig is null (defensive)", async () => {
    const ctx = makeToolContext({ visionConfig: null });

    const got = await lookAtTool().execute(
      { filename: "sunset.png" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(got).toEqual({
      error: "not_configured",
      message: expect.stringContaining("vision"),
    });
    expect(describeImageMock).not.toHaveBeenCalled();
  });

  it("returns a structured vision_failed error when the vision call throws", async () => {
    describeImageMock.mockRejectedValue(new Error("boom"));
    const ctx = makeToolContext();

    const got = await lookAtTool().execute(
      { filename: "sunset.png" },
      ctx,
      { abortSignal: SIGNAL() },
    );

    expect(got).toEqual({
      error: "vision_failed",
      message: "look_at failed: boom",
    });
  });

  it("re-throws the vision failure when the abort signal has fired", async () => {
    describeImageMock.mockRejectedValue(new Error("aborted mid-call"));
    const ctx = makeToolContext();
    const controller = new AbortController();
    controller.abort();

    await expect(
      lookAtTool().execute(
        { filename: "sunset.png" },
        ctx,
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow("aborted mid-call");
  });

  describe("inputSchema", () => {
    it.each([
      { label: "filename only", input: { filename: "sunset.png" }, ok: true },
      { label: "url only", input: { url: "https://example.com/cat.jpg" }, ok: true },
      { label: "entity pair only", input: { entityKind: "character", entityId: "ch-1" }, ok: true },
      { label: "world kind alone (context-implied, no id)", input: { entityKind: "world" }, ok: true },
      { label: "world kind + question", input: { entityKind: "world", question: "cover?" }, ok: true },
      { label: "entity pair + question", input: { entityKind: "scene_image", entityId: "img-1", question: "mood?" }, ok: true },
      { label: "filename + question", input: { filename: "sunset.png", question: "colors?" }, ok: true },
      { label: "url + question", input: { url: "https://example.com/cat.jpg", question: "animal?" }, ok: true },
      { label: "both filename and url", input: { filename: "sunset.png", url: "https://example.com/cat.jpg" }, ok: false },
      { label: "filename + entity pair", input: { filename: "sunset.png", entityKind: "character", entityId: "ch-1" }, ok: false },
      { label: "url + entity pair", input: { url: "https://example.com/cat.jpg", entityKind: "character", entityId: "ch-1" }, ok: false },
      { label: "world kind + filename (two sources)", input: { filename: "sunset.png", entityKind: "world" }, ok: false },
      { label: "entityKind without entityId", input: { entityKind: "character" }, ok: false },
      { label: "entityId without entityKind", input: { entityId: "ch-1" }, ok: false },
      { label: "neither filename nor url", input: { question: "anything?" }, ok: false },
      { label: "empty input", input: {}, ok: false },
      { label: "invalid url", input: { url: "not-a-url" }, ok: false },
      { label: "plain http url (not https)", input: { url: "http://example.com/cat.jpg" }, ok: false },
      { label: "data url", input: { url: "data:image/png;base64,iVBORw0KGgo=" }, ok: false },
      { label: "empty filename", input: { filename: "" }, ok: false },
      { label: "unknown entityKind", input: { entityKind: "spaceship", entityId: "ch-1" }, ok: false },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(schema().safeParse(input).success).toBe(ok);
    });
  });
});
