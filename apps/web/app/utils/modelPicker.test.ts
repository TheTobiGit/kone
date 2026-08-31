import { beforeEach, describe, expect, test } from "bun:test";
import { buildModelCatalog, type ModelOption } from "~/utils/modelCatalog";
import {
  bootMode,
  bootModel,
  bootProvider,
  bootReasoning,
  DEFAULT_MODE_KEY,
  DEFAULT_MODEL_KEY,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_REASONING_KEY,
  MODEL_KEY,
  modeKey,
  PROVIDER_KEY,
  REASONING_KEY,
  resolveSessionModelSelection,
  setDefaultModel,
  setLastUsedModel,
} from "./modelPicker";

const mockCatalogs = {
  codex: buildModelCatalog([
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    },
  ]),
  claudeAgent: buildModelCatalog([
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      reasoningEfforts: ["base", "high"],
      contextWindows: [
        { id: "200k", tokens: 200_000, label: "200k", isDefault: true },
        { id: "1m", tokens: 1_000_000, label: "1M" },
      ],
    },
  ]),
} satisfies Partial<Record<"codex" | "claudeAgent" | "opencode", ModelOption[]>>;

describe("resolveSessionModelSelection — model resolution hierarchy", () => {
  test("1. Reopening an existing thread prioritizes threadPersisted selection", () => {
    const res = resolveSessionModelSelection({
      threadPersisted: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        reasoning: "high",
        contextWindow: "1m",
      },
      agentPinned: { provider: "codex", model: "gpt-5.6-terra" },
      lastUsed: { provider: "codex", model: "gpt-5.6-terra", reasoning: "high" },
      userDefault: { provider: "opencode", model: "opencode-model" },
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex", "claudeAgent"],
    });

    expect(res).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      reasoning: "high",
      serviceTier: undefined,
      contextWindow: "1m",
      source: "thread_persisted",
    });
  });

  test("2. Spawning with an agent preset prioritizes agentPinned model", () => {
    const res = resolveSessionModelSelection({
      agentPinned: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      lastUsed: { provider: "codex", model: "gpt-5.6-terra", reasoning: "high" },
      userDefault: { provider: "codex", model: "gpt-5.6-terra", reasoning: "low" },
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex", "claudeAgent"],
    });

    expect(res).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      reasoning: "high",
      serviceTier: undefined,
      contextWindow: "200k",
      source: "agent_pinned",
    });
  });

  test("3. General session creation uses lastUsed model over user default", () => {
    const res = resolveSessionModelSelection({
      lastUsed: { provider: "claudeAgent", model: "claude-sonnet-4-6", reasoning: "high" },
      userDefault: { provider: "codex", model: "gpt-5.6-terra", reasoning: "low" },
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex", "claudeAgent"],
    });

    expect(res).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      reasoning: "high",
      serviceTier: undefined,
      contextWindow: "200k",
      source: "last_used",
    });
  });

  test("4. First launch / clean session uses userDefault setting when no lastUsed", () => {
    const res = resolveSessionModelSelection({
      userDefault: { provider: "codex", model: "gpt-5.6-terra", reasoning: "low" },
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex", "claudeAgent"],
    });

    expect(res).toEqual({
      provider: "codex",
      model: "gpt-5.6-terra",
      reasoning: "low",
      serviceTier: undefined,
      contextWindow: undefined,
      source: "user_default",
    });
  });

  test("5. Falls back down the chain when higher preference provider is unavailable", () => {
    // Agent wants claudeAgent, but only codex is available
    const res = resolveSessionModelSelection({
      agentPinned: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      lastUsed: { provider: "codex", model: "gpt-5.6-terra", reasoning: "high" },
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex"],
    });

    expect(res).toEqual({
      provider: "codex",
      model: "gpt-5.6-terra",
      reasoning: "high",
      serviceTier: undefined,
      contextWindow: undefined,
      source: "last_used",
    });
  });

  test("6. Falls back to first available catalog default when everything else is unavailable", () => {
    const res = resolveSessionModelSelection({
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex"],
    });

    expect(res).toEqual({
      provider: "codex",
      model: "gpt-5.6-terra",
      reasoning: "high",
      serviceTier: undefined,
      contextWindow: undefined,
      source: "catalog_fallback",
    });
  });
});

describe("boot helpers & local storage persistence", () => {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };

  beforeEach(() => {
    store.clear();
    globalThis.localStorage = mockStorage;
  });

  test("bootProvider, bootModel, bootReasoning read default when last used is empty", () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "claudeAgent");
    localStorage.setItem(DEFAULT_MODEL_KEY, "claude-sonnet-4-6");
    localStorage.setItem(DEFAULT_REASONING_KEY, "high");

    expect(bootProvider()).toBe("claudeAgent");
    expect(bootModel()).toBe("claude-sonnet-4-6");
    expect(bootReasoning()).toBe("high");
  });

  test("last-used model takes priority over initial default in subsequent reads", () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "codex");
    localStorage.setItem(DEFAULT_MODEL_KEY, "gpt-5.6-terra");
    localStorage.setItem(DEFAULT_REASONING_KEY, "low");

    setLastUsedModel({
      provider: "claudeAgent",
      modelId: "claude-sonnet-4-6",
      tier: "high",
    });

    expect(bootProvider()).toBe("claudeAgent");
    expect(bootModel()).toBe("claude-sonnet-4-6");
    expect(bootReasoning()).toBe("high");
  });

  test("setDefaultModel writes default keys AND primes last-used keys", () => {
    setDefaultModel({
      provider: "claudeAgent",
      modelId: "claude-sonnet-4-6",
      tier: "high",
    });

    expect(localStorage.getItem(DEFAULT_PROVIDER_KEY)).toBe("claudeAgent");
    expect(localStorage.getItem(DEFAULT_MODEL_KEY)).toBe("claude-sonnet-4-6");
    expect(localStorage.getItem(DEFAULT_REASONING_KEY)).toBe("high");

    expect(localStorage.getItem(PROVIDER_KEY)).toBe("claudeAgent");
    expect(localStorage.getItem(MODEL_KEY)).toBe("claude-sonnet-4-6");
    expect(localStorage.getItem(REASONING_KEY)).toBe("high");
  });

  test("bootMode falls back to DEFAULT_MODE_KEY when project mode is not set", () => {
    localStorage.setItem(DEFAULT_MODE_KEY, "full-access");
    expect(bootMode("/path/to/project")).toBe("full-access");
  });

  test("bootMode prioritizes per-project modeKey over DEFAULT_MODE_KEY", () => {
    localStorage.setItem(DEFAULT_MODE_KEY, "accept-edits");
    localStorage.setItem(modeKey("/path/to/project"), "full-access");
    expect(bootMode("/path/to/project")).toBe("full-access");
  });

  test("bootMode returns null for unrecognized mode values", () => {
    localStorage.setItem(DEFAULT_MODE_KEY, "invalid-mode");
    expect(bootMode("/path/to/project")).toBeNull();
  });
});
