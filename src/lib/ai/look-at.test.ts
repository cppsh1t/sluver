/**
 * Tests for the one-shot image description module (ADR-0045): FilePart
 * construction for both image sources, question propagation, abort-signal
 * forwarding, and output post-processing. The provider factory is mocked so
 * `createLanguageModel` hands back a `MockLanguageModelV3` — assertions run
 * against the recorded `doGenerate` call options (never a real provider).
 */
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

import { describeImage, type ImageSource } from "@/lib/ai/look-at";
import { createLanguageModel } from "@/lib/ai/provider/provider-factory";
import type { ResolvedModelConfig } from "@/lib/ai/provider/provider-factory";

vi.mock("@/lib/ai/provider/provider-factory", () => ({
  createLanguageModel: vi.fn(),
}));

const createModelMock = vi.mocked(createLanguageModel);

const CONFIG: ResolvedModelConfig = {
  npmPackage: "@ai-sdk/mock",
  modelId: "vision-mock",
  apiKey: "sk-test",
};

// ─── Fixtures (provider-level V3 doGenerate result shape) ────────────────

/** Nested V3 provider usage shape (as required inside the result). */
const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USAGE,
  // `never[]` satisfies the SDK's warning-union array without importing it.
  warnings: [] as never[],
});

/**
 * Install a mock vision model. `supportedUrls` declares image-URL support so
 * the url-source test exercises provider-side passthrough — without it the
 * SDK's default download function would fetch the URL over the network.
 */
function makeModel(result: ReturnType<typeof textResult>): MockLanguageModelV3 {
  const model = new MockLanguageModelV3({
    doGenerate: result,
    supportedUrls: { "image/*": [/^https:\/\//] },
  });
  createModelMock.mockReturnValue(model);
  return model;
}

const ATTACHMENT: ImageSource = {
  kind: "attachment",
  filename: "sunset.png",
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
};

/** The user message of the recorded V3 prompt (system is index 0). */
function userContentOf(model: MockLanguageModelV3): Array<Record<string, unknown>> {
  const calls = model.doGenerateCalls;
  expect(calls.length).toBe(1);
  const user = calls[0].prompt.find((m) => m.role === "user");
  expect(user).toBeDefined();
  expect(Array.isArray(user?.content)).toBe(true);
  return user?.content as unknown as Array<Record<string, unknown>>;
}

/**
 * Stringify a recorded file-part `data`. The V3 prompt keeps the SDK's
 * tagged form — `{ type: "data", data: <base64> }` for inline bytes,
 * `{ type: "url", url: URL }` for provider-side passthrough.
 */
function filePartData(part: Record<string, unknown> | undefined): string {
  expect(part).toBeDefined();
  const data = part?.data as { type: string; data?: unknown; url?: unknown };
  if (data.type === "data") return String(data.data);
  return String(data.url);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("describeImage", () => {
  it("builds an inline FilePart from the attachment's data URL and returns the description", async () => {
    const model = makeModel(textResult("A sunset over calm water."));

    const got = await describeImage(CONFIG, ATTACHMENT, undefined, undefined);

    expect(got).toBe("A sunset over calm water.");
    // Data URL is split by the SDK: inline base64 + the URL's own media type.
    const filePart = userContentOf(model).find((p) => p.type === "file");
    expect(filePart?.mediaType).toBe("image/png");
    expect(filePartData(filePart)).toBe("iVBORw0KGgo=");
  });

  it("builds a URL FilePart with a full media type derived from the extension", async () => {
    const model = makeModel(textResult("A cat in a box."));

    await describeImage(
      CONFIG,
      { kind: "url", url: "https://example.com/cat.webp?size=large" },
      undefined,
      undefined,
    );

    const filePart = userContentOf(model).find((p) => p.type === "file");
    expect(filePart?.mediaType).toBe("image/webp");
    expect(filePartData(filePart)).toBe("https://example.com/cat.webp?size=large");
  });

  it("propagates the question into the user text part", async () => {
    const model = makeModel(textResult("Two people, one dog."));

    await describeImage(CONFIG, ATTACHMENT, "How many people?", undefined);

    const textPart = userContentOf(model).find((p) => p.type === "text");
    expect(String(textPart?.text)).toContain("How many people?");
  });

  it("falls back to a general-description prompt without a question", async () => {
    const model = makeModel(textResult("A red bicycle."));

    await describeImage(CONFIG, ATTACHMENT, "   ", undefined);

    const textPart = userContentOf(model).find((p) => p.type === "text");
    expect(String(textPart?.text)).toBe("Describe the attached image.");
  });

  it("forwards the abort signal to generateText", async () => {
    const model = makeModel(textResult("unused"));
    const controller = new AbortController();

    await describeImage(CONFIG, ATTACHMENT, undefined, controller.signal);

    expect(model.doGenerateCalls[0].abortSignal).toBe(controller.signal);
  });

  it("throws on empty model output", async () => {
    makeModel(textResult("   "));

    await expect(
      describeImage(CONFIG, ATTACHMENT, undefined, undefined),
    ).rejects.toThrow("look-at: model output was empty");
  });

  it("collapses runs of blank lines but keeps single blank lines", async () => {
    makeModel(textResult("first\n\n\n\n\nsecond\n\nthird  "));

    const got = await describeImage(CONFIG, ATTACHMENT, undefined, undefined);

    expect(got).toBe("first\n\nsecond\n\nthird");
  });
});
