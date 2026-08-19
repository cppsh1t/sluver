/**
 * Vision capability resolution tests (ADR-0044 §D9 step 2) — the pure join
 * of a composite modelId with the models.dev catalog's `inputModalities`.
 * Tri-state contract: catalog-confirmed true/false; `undefined` for
 * anything unknown (NEVER defaulted to false).
 */

import { describe, expect, it } from "vitest";

import { imageInputSupportedForModel } from "./vision";
import type { CatalogModel, ModelsDevCatalog } from "@/types";

function model(
  id: string,
  inputModalities?: string[] | null,
): CatalogModel {
  return {
    id,
    name: id,
    ...(inputModalities === undefined
      ? {}
      : {
          // Mirror the Rust adapter: empty arrays are filtered to `null`
          // (None) so `null` reliably means "unknown", never "known empty".
          inputModalities:
            inputModalities !== null && inputModalities.length === 0
              ? null
              : inputModalities,
        }),
  };
}

function catalog(models: CatalogModel[], providerId = "anthropic"): ModelsDevCatalog {
  return {
    providers: [{ id: providerId, name: providerId, models }],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    isStale: false,
  };
}

describe("imageInputSupportedForModel", () => {
  it("returns true when the catalog confirms image input", () => {
    const c = catalog([model("claude-x", ["text", "image"])]);
    expect(imageInputSupportedForModel(c, "anthropic/claude-x")).toBe(true);
  });

  it("returns false when the catalog confirms text-only input", () => {
    const c = catalog([model("claude-x", ["text"])]);
    expect(imageInputSupportedForModel(c, "anthropic/claude-x")).toBe(false);
  });

  it("returns undefined when the entry omits inputModalities (null upstream)", () => {
    const c = catalog([model("custom-llm", null)]);
    expect(imageInputSupportedForModel(c, "anthropic/custom-llm")).toBeUndefined();
  });

  it("returns undefined when the entry has no modalities field at all", () => {
    const c = catalog([model("custom-llm")]);
    expect(imageInputSupportedForModel(c, "anthropic/custom-llm")).toBeUndefined();
  });

  it("returns undefined when the model is not in the catalog", () => {
    const c = catalog([model("claude-x", ["text", "image"])]);
    expect(imageInputSupportedForModel(c, "anthropic/unknown-model")).toBeUndefined();
  });

  it("returns undefined when the provider is not in the catalog", () => {
    const c = catalog([model("claude-x", ["text", "image"])]);
    expect(imageInputSupportedForModel(c, "other/claude-x")).toBeUndefined();
  });

  it("returns undefined when no model is chosen or the catalog is missing", () => {
    const c = catalog([model("claude-x", ["image"])]);
    expect(imageInputSupportedForModel(c, null)).toBeUndefined();
    expect(imageInputSupportedForModel(undefined, "anthropic/claude-x")).toBeUndefined();
    expect(imageInputSupportedForModel(undefined, null)).toBeUndefined();
  });

  it("handles composite ids with a slash in the model segment (openrouter)", () => {
    // parseModelId splits on the FIRST slash: provider "openrouter",
    // model "anthropic/claude-x" (the established id convention).
    const c = catalog([model("anthropic/claude-x", ["text", "image"])], "openrouter");
    expect(imageInputSupportedForModel(c, "openrouter/anthropic/claude-x")).toBe(true);
  });

  it("returns undefined for an id with no provider segment", () => {
    const c = catalog([model("claude-x", ["text", "image"])]);
    expect(imageInputSupportedForModel(c, "claude-x")).toBeUndefined();
  });
});
