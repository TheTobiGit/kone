import { describe, expect, test } from "bun:test";

import { resolveAgentModel, resolveModelWithFallback, type ProviderAvailability } from "./agentModel.js";
import type { AgentModelRef } from "./ConversationStore.js";

// A small readable availability snapshot: two providers logged in, one not.
function surface(overrides: Partial<Record<string, ProviderAvailability>> = {}): ProviderAvailability[] {
  const base: Record<string, ProviderAvailability> = {
    claudeAgent: { provider: "claudeAgent", available: true, models: ["opus", "sonnet", "haiku"] },
    codex: { provider: "codex", available: true, models: ["gpt-5"] },
    cursor: { provider: "cursor", available: false, models: ["auto"] },
  };
  return Object.values({ ...base, ...overrides });
}

const ref = (provider: AgentModelRef["provider"], model: string): AgentModelRef => ({ provider, model });

describe("resolveAgentModel", () => {
  test("no model is no preference, not a failure", () => {
    expect(resolveAgentModel(null, surface())).toEqual({ outcome: "no-preference" });
    expect(resolveAgentModel(undefined, surface())).toEqual({ outcome: "no-preference" });
  });

  test("an available model resolves to itself", () => {
    const r = resolveAgentModel(ref("claudeAgent", "opus"), surface());
    expect(r).toEqual({ outcome: "resolved", ref: ref("claudeAgent", "opus") });
  });

  // The pin can't run: its provider isn't logged in. There's no fallback list —
  // the agent runs on its one model or the spawn is refused, so this is
  // unavailable, naming what was tried.
  test("a model whose provider isn't logged in is unavailable", () => {
    const r = resolveAgentModel(ref("cursor", "auto"), surface());
    expect(r).toEqual({ outcome: "unavailable", tried: ref("cursor", "auto") });
  });

  test("a model the provider doesn't offer is unavailable", () => {
    const r = resolveAgentModel(ref("claudeAgent", "gpt-6"), surface());
    expect(r).toEqual({ outcome: "unavailable", tried: ref("claudeAgent", "gpt-6") });
  });

  // "or has exhausted its available usage" — a spent model can't run even
  // though the provider is up and offers it.
  test("an exhausted model is unavailable", () => {
    const s = surface({
      claudeAgent: {
        provider: "claudeAgent",
        available: true,
        models: ["opus", "sonnet"],
        exhausted: ["opus"],
      },
    });
    const r = resolveAgentModel(ref("claudeAgent", "opus"), s);
    expect(r).toEqual({ outcome: "unavailable", tried: ref("claudeAgent", "opus") });
  });

  test("a provider absent from the snapshot is treated as unavailable", () => {
    const r = resolveAgentModel(ref("droid", "kimi"), surface());
    expect(r).toEqual({ outcome: "unavailable", tried: ref("droid", "kimi") });
  });

  test("an empty exhausted list blocks nothing", () => {
    const s = surface({
      codex: { provider: "codex", available: true, models: ["gpt-5"], exhausted: [] },
    });
    const r = resolveAgentModel(ref("codex", "gpt-5"), s);
    expect(r).toEqual({ outcome: "resolved", ref: ref("codex", "gpt-5") });
  });
});

describe("resolveModelWithFallback", () => {
  test("an available primary model resolves immediately", () => {
    const primary = { provider: "claudeAgent", model: "opus" };
    const fallbacks = [{ provider: "codex", model: "gpt-5" }];
    const r = resolveModelWithFallback(primary, fallbacks, surface());
    expect(r).toEqual({ outcome: "resolved", ref: primary });
  });

  test("falls back smoothly when primary provider is marked unavailable", () => {
    const primary = { provider: "cursor", model: "auto" };
    const fallbacks = [{ provider: "codex", model: "gpt-5" }];
    const r = resolveModelWithFallback(primary, fallbacks, surface());
    expect(r).toEqual({ outcome: "resolved", ref: { provider: "codex", model: "gpt-5" } });
  });

  test("falls back when primary model is exhausted", () => {
    const s = surface({
      claudeAgent: {
        provider: "claudeAgent",
        available: true,
        models: ["opus", "sonnet"],
        exhausted: ["opus"],
      },
    });
    const primary = { provider: "claudeAgent", model: "opus" };
    const fallbacks = [
      { provider: "claudeAgent", model: "sonnet" },
      { provider: "codex", model: "gpt-5" },
    ];
    const r = resolveModelWithFallback(primary, fallbacks, s);
    expect(r).toEqual({ outcome: "resolved", ref: { provider: "claudeAgent", model: "sonnet" } });
  });

  test("transitions across multiple unavailable candidates to first available", () => {
    const primary = { provider: "cursor", model: "auto" };
    const fallbacks = [
      { provider: "droid", model: "kimi" },
      { provider: "claudeAgent", model: "unknown-model" },
      { provider: "codex", model: "gpt-5" },
    ];
    const r = resolveModelWithFallback(primary, fallbacks, surface());
    expect(r).toEqual({ outcome: "resolved", ref: { provider: "codex", model: "gpt-5" } });
  });

  test("resolves a fallback candidate with no model specified if provider is available", () => {
    const primary = { provider: "cursor", model: "auto" };
    const fallbacks = [{ provider: "codex" }];
    const r = resolveModelWithFallback(primary, fallbacks, surface());
    expect(r).toEqual({ outcome: "resolved", ref: { provider: "codex" } });
  });

  test("returns unavailable when primary and all fallbacks cannot run", () => {
    const primary = { provider: "cursor", model: "auto" };
    const fallbacks = [
      { provider: "droid", model: "kimi" },
      { provider: "claudeAgent", model: "non-existent" },
    ];
    const r = resolveModelWithFallback(primary, fallbacks, surface());
    expect(r).toEqual({
      outcome: "unavailable",
      tried: [primary, ...fallbacks],
    });
  });

  test("returns unavailable when primary is unavailable and fallbacks list is empty", () => {
    const primary = { provider: "cursor", model: "auto" };
    const r = resolveModelWithFallback(primary, [], surface());
    expect(r).toEqual({
      outcome: "unavailable",
      tried: [primary],
    });
  });
});
