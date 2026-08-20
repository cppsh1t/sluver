/**
 * Tests for the look_at tool (ADR-0045): input-schema exactly-one-of
 * validation and execute behaviors (attachment hit/miss, url passthrough,
 * unconfigured vision agent, vision-call failure vs abort re-throw).
 * `@/lib/ai/look-at` is mocked — describeImage is a vi.fn; the consent gate
 * is bypassed by calling execute directly (see AGENTS.md §Testing).
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

type LookAtParsed = { filename?: string; url?: string; question?: string };

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
      { label: "filename + question", input: { filename: "sunset.png", question: "colors?" }, ok: true },
      { label: "url + question", input: { url: "https://example.com/cat.jpg", question: "animal?" }, ok: true },
      { label: "both filename and url", input: { filename: "sunset.png", url: "https://example.com/cat.jpg" }, ok: false },
      { label: "neither filename nor url", input: { question: "anything?" }, ok: false },
      { label: "empty input", input: {}, ok: false },
      { label: "invalid url", input: { url: "not-a-url" }, ok: false },
      { label: "plain http url (not https)", input: { url: "http://example.com/cat.jpg" }, ok: false },
      { label: "data url", input: { url: "data:image/png;base64,iVBORw0KGgo=" }, ok: false },
      { label: "empty filename", input: { filename: "" }, ok: false },
    ])("$label → success=$ok", ({ input, ok }) => {
      expect(schema().safeParse(input).success).toBe(ok);
    });
  });
});
