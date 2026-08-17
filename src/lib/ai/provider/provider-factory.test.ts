import { describe, expect, it } from "vitest";

// NOTE: this file intentionally imports the factory module (which statically
// imports every installed @ai-sdk/* provider). Only the error paths are
// tested here — the happy path is skipped to keep the suite fast.
import { createLanguageModel, ProviderFactoryError } from "./provider-factory";

describe("createLanguageModel error paths", () => {
  it("throws ProviderFactoryError carrying .npmPackage for an unknown package", () => {
    const npmPackage = "@ai-sdk/not-a-real-provider";
    try {
      createLanguageModel({
        npmPackage,
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
      createLanguageModel({ npmPackage: "", modelId: "m", apiKey: "k" }),
    ).toThrowError(ProviderFactoryError);
  });
});
