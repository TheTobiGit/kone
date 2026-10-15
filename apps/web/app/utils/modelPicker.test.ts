import { beforeEach, describe, expect, test } from "bun:test";
import { buildModelCatalog, type ModelOption } from "~/utils/modelCatalog";
import {
  ASSISTANT_MODEL_KEY,
  ASSISTANT_PROVIDER_KEY,
  ASSISTANT_REASONING_KEY,
  bootAssistantSelection,
  bootMode,
  bootSelection,
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
      // The fresh-install fallback draws a random ready provider/model, so pin
      // the draw — near-1 lands on the last flat entry (the high rung here).
      rand: () => 0.999,
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

  test("bootSelection reads the whole default triple when last used is empty", () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "claudeAgent");
    localStorage.setItem(DEFAULT_MODEL_KEY, "claude-sonnet-4-6");
    localStorage.setItem(DEFAULT_REASONING_KEY, "high");

    expect(bootSelection()).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      reasoning: "high",
    });
  });

  test("last-used selection takes priority over the initial default", () => {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "codex");
    localStorage.setItem(DEFAULT_MODEL_KEY, "gpt-5.6-terra");
    localStorage.setItem(DEFAULT_REASONING_KEY, "low");

    setLastUsedModel({
      provider: "claudeAgent",
      modelId: "claude-sonnet-4-6",
      tier: "high",
    });

    expect(bootSelection()).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      reasoning: "high",
    });
  });

  test("a stale last-used provider kone no longer offers is skipped whole for an offered default", () => {
    // Last used was Droid before kone retired it; the default is Codex. The
    // retired provider, its model and its effort must all fall through
    // together — the model and effort must not ride onto Codex.
    localStorage.setItem(PROVIDER_KEY, "droid");
    localStorage.setItem(MODEL_KEY, "droid-model");
    localStorage.setItem(REASONING_KEY, "high");
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "codex");
    localStorage.setItem(DEFAULT_MODEL_KEY, "gpt-5.6-terra");
    localStorage.setItem(DEFAULT_REASONING_KEY, "low");

    expect(bootSelection()).toEqual({
      provider: "codex",
      model: "gpt-5.6-terra",
      reasoning: "low",
    });
  });

  test("a stale Antigravity default falls through to null when nothing offered remains", () => {
    // Both stored tiers name Antigravity; there is no offered candidate left,
    // so there is no model or effort either.
    localStorage.setItem(PROVIDER_KEY, "antigravity");
    localStorage.setItem(MODEL_KEY, "gemini-3.8-flash");
    localStorage.setItem(REASONING_KEY, "high");
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "antigravity");
    localStorage.setItem(DEFAULT_MODEL_KEY, "gemini-3.8-flash");
    localStorage.setItem(DEFAULT_REASONING_KEY, "medium");

    expect(bootSelection()).toBeNull();
  });

  test("bootAssistantSelection skips a stale assistant provider to the board's offered last used", () => {
    localStorage.setItem(ASSISTANT_PROVIDER_KEY, "droid");
    localStorage.setItem(ASSISTANT_MODEL_KEY, "droid-model");
    localStorage.setItem(ASSISTANT_REASONING_KEY, "high");
    localStorage.setItem(PROVIDER_KEY, "claudeAgent");
    localStorage.setItem(MODEL_KEY, "claude-sonnet-4-6");
    localStorage.setItem(REASONING_KEY, "high");
    localStorage.setItem(DEFAULT_PROVIDER_KEY, "codex");
    localStorage.setItem(DEFAULT_MODEL_KEY, "gpt-5.6-terra");

    expect(bootAssistantSelection()).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      reasoning: "high",
    });
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

  test("bootSelection returns null on fresh install with nothing stored", () => {
    expect(bootSelection()).toBeNull();
  });

  test("bootSelection returns what was stored; readiness is validated by the resolver", () => {
    localStorage.setItem(PROVIDER_KEY, "codex");
    expect(bootSelection()?.provider).toBe("codex");
    const res = resolveSessionModelSelection({
      lastUsed: { provider: "codex" },
      availableProviders: ["claudeAgent"],
      availableCatalogs: mockCatalogs,
    });
    expect(res.provider).not.toBe("codex");
  });

  test("resolve returns none when no provider is active", () => {
    const res = resolveSessionModelSelection({
      availableProviders: [],
      availableCatalogs: mockCatalogs,
    });
    expect(res.provider).toBeNull();
    expect(res.model).toBeUndefined();
    expect(res.source).toBe("none");
  });

  test("fresh-install fallback picks randomly among ready providers", () => {
    const first = resolveSessionModelSelection({
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex", "claudeAgent"],
      rand: () => 0,
    });
    const last = resolveSessionModelSelection({
      availableCatalogs: mockCatalogs,
      availableProviders: ["codex", "claudeAgent"],
      rand: () => 0.999,
    });
    expect(first.provider).toBe("codex");
    expect(last.provider).toBe("claudeAgent");
    expect(first.source).toBe("catalog_fallback");
    expect(last.source).toBe("catalog_fallback");
  });
});
