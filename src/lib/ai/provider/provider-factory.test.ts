import { describe, expect, it } from "vitest";

// NOTE: this file intentionally imports the factory module (which statically
// imports every installed @ai-sdk/* provider). Error paths plus cheap
// happy-path instantiations are tested here — model construction is lazy (no
// network, no key validation at construction time), so the suite stays fast.
import { createLanguageModel, ProviderFactoryError } from "./provider-factory";

describe("createLanguageModel error paths", () => {
  it("throws ProviderFactoryError carrying .npmPackage for an unknown package", () => {
    const npmPackage = "@ai-sdk/not-a-real-provider";
    try {
      createLanguageModel({
        npmPackage,
        providerName: "not-a-real-provider",
        modelId: "some-model",
        apiKey: "sk-test",
      });
      expect.unreachable("createLanguageModel should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFactoryError);
      const factoryError = error as ProviderFactoryError;
      expect(factoryError.npmPackage).toBe(npmPackage);
      expect(factoryError.name).toBe("ProviderFactoryError");
      expect(factoryError.message).toContain(npmPackage);
    }
  });

  it("throws ProviderFactoryError for an empty package string", () => {
    expect(() =>
      createLanguageModel({
        npmPackage: "",
        providerName: "p",
        modelId: "m",
        apiKey: "k",
      }),
    ).toThrowError(ProviderFactoryError);
  });
});

describe("createLanguageModel provider name threading", () => {
  // `createOpenAICompatible` requires `name`: it becomes the model's
  // providerOptions namespace — `providerOptions[name]` is forwarded raw
  // into the request body (the ADR-0056 escape hatch). Without the threaded
  // name the namespace resolved to the literal string "undefined".
  it("uses providerName as the openai-compatible providerOptions namespace", () => {
    const model = createLanguageModel({
      npmPackage: "@ai-sdk/openai-compatible",
      providerName: "deepseek",
      modelId: "deepseek-flash",
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com",
    });
    expect(
      (model as unknown as { providerOptionsName: string }).providerOptionsName,
    ).toBe("deepseek");
  });

  it("first-party factories tolerate the extra name option", () => {
    const model = createLanguageModel({
      npmPackage: "@ai-sdk/deepseek",
      providerName: "deepseek",
      modelId: "deepseek-flash",
      apiKey: "sk-test",
    });
    const { modelId, provider } = model as unknown as {
      modelId: string;
      provider: string;
    };
    expect(modelId).toBe("deepseek-flash");
    expect(provider).toBe("deepseek.chat");
  });
});
