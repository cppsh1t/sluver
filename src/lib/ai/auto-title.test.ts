/**
 * Tests for the one-shot conversation titler (ADR-0040): default
 * temperature fallback (TITLE_TEMPERATURE when settings are omitted or
 * all-null), per-field settings forwarding (ADR-0056), prompt truncation,
 * and the empty-output throw. The provider factory is mocked so
 * `createLanguageModel` hands back a `MockLanguageModelV3` — assertions run
 * against the recorded `doGenerate` call options (never a real provider).
 */
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

import {
  cleanTitle,
  generateConversationTitle,
  type ModelGenerationSettings,
} from "@/lib/ai/auto-title";
import { createLanguageModel } from "@/lib/ai";
import type { ResolvedModelConfig } from "@/lib/ai";

vi.mock("@/lib/ai", () => ({
  createLanguageModel: vi.fn(),
}));

const createModelMock = vi.mocked(createLanguageModel);

const CONFIG: ResolvedModelConfig = {
  npmPackage: "@ai-sdk/mock",
  providerName: "mock",
  modelId: "namer-mock",
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

function makeModel(result: ReturnType<typeof textResult>): MockLanguageModelV3 {
  const model = new MockLanguageModelV3({ doGenerate: result });
  createModelMock.mockReturnValue(model);
  return model;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("generateConversationTitle", () => {
  it("returns the cleaned title", async () => {
    makeModel(textResult('"  A quiet harbor  "'));

    const got = await generateConversationTitle(CONFIG, "hello there");

    expect(got).toBe("A quiet harbor");
  });

  it("defaults to TITLE_TEMPERATURE (0.3) when settings are omitted", async () => {
    const model = makeModel(textResult("T"));

    await generateConversationTitle(CONFIG, "hello");

    expect(model.doGenerateCalls[0].temperature).toBe(0.3);
  });

  it("defaults to TITLE_TEMPERATURE (0.3) when every settings field is null", async () => {
    const model = makeModel(textResult("T"));
    const allNull: ModelGenerationSettings = {
      temperature: null,
      topP: null,
      topK: null,
      maxOutputTokens: null,
      reasoning: null,
      providerOptions: null,
    };

    await generateConversationTitle(CONFIG, "hello", allNull);

    // The SDK spreads all callSettings keys; unset ones materialize as
    // `undefined`, which is the provider-default signal.
    const call = model.doGenerateCalls[0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.3);
    expect(call.topP).toBeUndefined();
    expect(call.topK).toBeUndefined();
    expect(call.maxOutputTokens).toBeUndefined();
    expect(call.reasoning).toBeUndefined();
    expect(call.providerOptions).toBeUndefined();
  });

  it("forwards every non-null settings field and overrides the temperature fallback", async () => {
    const model = makeModel(textResult("T"));
    const settings: ModelGenerationSettings = {
      temperature: 0.9,
      topP: 0.75,
      topK: 16,
      maxOutputTokens: 128,
      reasoning: "minimal",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    };

    await generateConversationTitle(CONFIG, "hello", settings);

    // `reasoning` is typed on the V4 call options, not the mock's recorded
    // V3 shape — widen once for the assertion.
    const call = model.doGenerateCalls[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      temperature: 0.9,
      topP: 0.75,
      topK: 16,
      maxOutputTokens: 128,
      reasoning: "minimal",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    });
  });

  it("truncates the user text to 1500 chars before prompting", async () => {
    const model = makeModel(textResult("T"));
    const long = "x".repeat(2000);

    await generateConversationTitle(CONFIG, long);

    const prompt = model.doGenerateCalls[0].prompt;
    const user = prompt.find((m) => m.role === "user");
    const text = JSON.stringify(user?.content);
    expect(text).toContain("x".repeat(1500));
    expect(text).not.toContain("x".repeat(1501));
  });

  it("throws when post-processing empties the model output", async () => {
    makeModel(textResult("   "));

    await expect(generateConversationTitle(CONFIG, "hello")).rejects.toThrow(
      "auto-title: model output was empty after post-processing",
    );
  });
});

describe("cleanTitle", () => {
  it("strips wrapping quotes, collapses whitespace, and clamps length", () => {
    expect(cleanTitle('  "  Hello   World " ')).toBe("Hello World");
    expect(cleanTitle("a".repeat(80)).length).toBe(60);
    expect(cleanTitle("「角括弧」")).toBe("角括弧");
  });
});
