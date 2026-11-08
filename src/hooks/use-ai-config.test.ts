/**
 * Tests for the pure `resolveAgentModelConfig` join (the hook-free core of
 * `useResolvedModelConfig` and the conversation-runtime model resolver,
 * ADR-0050 D1): the joined `config` must carry the composite modelId's
 * provider prefix as `providerName` — the openai-compatible providerOptions
 * namespace — alongside the npm package, model id, key, and base URL.
 */
import { describe, expect, it } from "vitest";

import { resolveAgentModelConfig } from "@/hooks/use-ai-config";
import {
  agentConfigIdSchema,
  providerCredentialIdSchema,
  type AgentConfig,
  type ModelsDevCatalog,
  type ProviderCredential,
} from "@/types";

const NOW = "2026-11-08T00:00:00.000Z";

const agentConfig = (modelId: string | null): AgentConfig => ({
  id: agentConfigIdSchema.parse("cfg-1"),
  name: "orchestrator",
  modelId,
  autoExecuteDangerousTools: false,
  shellToolEnabled: false,
  contextCompaction: { enabled: false, turnAge: 3 },
  contextNote: "",
  maxSteps: null,
  modelSettings: {
    temperature: null,
    topP: null,
    topK: null,
    maxOutputTokens: null,
    reasoning: null,
    providerOptions: null,
  },
  createdAt: NOW,
  updatedAt: NOW,
});

const CREDENTIAL: ProviderCredential = {
  id: providerCredentialIdSchema.parse("cred-1"),
  providerId: "deepseek",
  apiKey: "sk-test",
  createdAt: NOW,
  updatedAt: NOW,
};

const CATALOG: ModelsDevCatalog = {
  providers: [
    {
      id: "deepseek",
      name: "DeepSeek",
      npm: "@ai-sdk/openai-compatible",
      apiBaseUrl: "https://api.deepseek.com",
      iconUrl: null,
      models: [],
    },
  ],
  fetchedAt: NOW,
  isStale: false,
};

describe("resolveAgentModelConfig providerName threading", () => {
  it("joins the modelId's provider prefix into config.providerName", () => {
    const joined = resolveAgentModelConfig(
      agentConfig("deepseek/deepseek-flash"),
      [CREDENTIAL],
      CATALOG,
    );

    expect(joined.config).not.toBeNull();
    expect(joined.config?.providerName).toBe("deepseek");
    expect(joined.config?.npmPackage).toBe("@ai-sdk/openai-compatible");
    expect(joined.config?.modelId).toBe("deepseek-flash");
  });

  it("reports config null when any join piece is missing", () => {
    expect(
      resolveAgentModelConfig(agentConfig(null), [CREDENTIAL], CATALOG).config,
    ).toBeNull();
    expect(
      resolveAgentModelConfig(
        agentConfig("deepseek/deepseek-flash"),
        [],
        CATALOG,
      ).config,
    ).toBeNull();
  });
});
