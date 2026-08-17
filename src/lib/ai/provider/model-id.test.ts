import { describe, expect, it } from "vitest";

import { composeModelId, parseModelId } from "./model-id";

describe("parseModelId", () => {
  it("splits on the FIRST slash only (openrouter-style ids)", () => {
    expect(parseModelId("openrouter/anthropic/claude")).toEqual([
      "openrouter",
      "anthropic/claude",
    ]);
  });

  it("splits a plain provider/model id", () => {
    expect(parseModelId("anthropic/claude-sonnet-5")).toEqual([
      "anthropic",
      "claude-sonnet-5",
    ]);
  });

  it("returns [null, null] for null", () => {
    expect(parseModelId(null)).toEqual([null, null]);
  });

  it("returns [null, null] when there is no slash", () => {
    expect(parseModelId("claude-sonnet-5")).toEqual([null, null]);
  });
});

describe("composeModelId round-trip", () => {
  it("rejoins provider and model parts", () => {
    expect(composeModelId("anthropic", "claude-sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("round-trips every well-formed composite id", () => {
    for (const id of [
      "anthropic/claude-sonnet-5",
      "openrouter/anthropic/claude",
      "openrouter/google/gemini-2.5-pro",
      "deepseek/deepseek-chat-v3.1",
    ]) {
      const [providerId, modelId] = parseModelId(id);
      expect(composeModelId(providerId ?? "", modelId ?? "")).toBe(id);
    }
  });
});
