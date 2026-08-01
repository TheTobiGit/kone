import { describe, expect, test } from "bun:test";

import type { ModelDescriptor } from "~/types/desktop";
import { buildModelCatalog } from "./modelCatalog";

/** One descriptor per raw slug, labelled the way OpenCode's `models --verbose`
 *  labels them (the `name` field), so we exercise the real catalog path. */
function catalogOf(...ids: string[]) {
  const models: ModelDescriptor[] = ids.map((id) => ({ id, label: id }));
  return buildModelCatalog(models);
}

function brandFor(id: string) {
  const entry = catalogOf(id)[0]!;
  return { brand: entry.brand, vendor: entry.vendor };
}

describe("brandOf — OpenCode is a house of providers", () => {
  // The whole point: a gateway prefix must not brand the model. Before this,
  // every `opencode*/…` slug matched startsWith("opencode") and every hosted
  // model wore the OpenCode mark.
  test("resolves hosted models to the vendor that made them, not the gateway", () => {
    expect(brandFor("opencode-go/deepseek-v4-flash")).toEqual({ brand: "deepseek", vendor: "DeepSeek" });
    expect(brandFor("opencode-go/qwen3.6-plus")).toEqual({ brand: "qwen", vendor: "Alibaba" });
    expect(brandFor("opencode-go/kimi-k3")).toEqual({ brand: "kimi", vendor: "Moonshot AI" });
    expect(brandFor("opencode-go/glm-5.1")).toEqual({ brand: "zai", vendor: "Z.ai" });
    expect(brandFor("opencode-go/minimax-m3")).toEqual({ brand: "minimax", vendor: "MiniMax" });
    expect(brandFor("opencode-go/mimo-v2.5-pro")).toEqual({ brand: "xiaomi", vendor: "Xiaomi" });
    expect(brandFor("opencode/nemotron-3-ultra-free")).toEqual({ brand: "nvidia", vendor: "NVIDIA" });
    expect(brandFor("opencode-go/gpt-5.6-luna")).toEqual({ brand: "gpt", vendor: "OpenAI" });
  });

  test("a non-OpenCode gateway is equally transparent", () => {
    expect(brandFor("cerebras/gemma-4-31b")).toEqual({ brand: "gemini", vendor: "Google" });
    expect(brandFor("cerebras/gpt-oss-120b")).toEqual({ brand: "gpt", vendor: "OpenAI" });
    expect(brandFor("cerebras/zai-glm-4.7")).toEqual({ brand: "zai", vendor: "Z.ai" });
    expect(brandFor("zai-coding-plan/glm-4.7")).toEqual({ brand: "zai", vendor: "Z.ai" });
  });

  test("falls back to the gateway only when the model id names no vendor", () => {
    // OpenCode's own models keep the OpenCode mark — that fallback is correct.
    expect(brandFor("opencode/big-pickle")).toEqual({ brand: "opencode", vendor: "OpenCode" });
    expect(brandFor("opencode-go/hy3")).toEqual({ brand: "opencode", vendor: "OpenCode" });
    // A gateway we know but whose model id we don't: named, no mark.
    expect(brandFor("cerebras/something-unknown")).toEqual({ brand: "generic", vendor: "Cerebras" });
  });

  test("names a vendor even with no logomark, rather than mis-marking it", () => {
    expect(brandFor("opencode-go/grok-4.5")).toEqual({ brand: "generic", vendor: "xAI" });
  });

  test("bare single-vendor ids (Codex, Claude) are unchanged", () => {
    expect(brandFor("gpt-5.6-terra")).toEqual({ brand: "gpt", vendor: "OpenAI" });
    expect(brandFor("claude-sonnet-4-5")).toEqual({ brand: "claude", vendor: "Anthropic" });
    expect(brandFor("gemini-2.5-pro")).toEqual({ brand: "gemini", vendor: "Google" });
    expect(brandFor("totally-unknown-model")).toEqual({ brand: "generic", vendor: "" });
  });

  test("every model in one gateway can carry a different mark", () => {
    const catalog = catalogOf(
      "opencode-go/deepseek-v4-pro",
      "opencode-go/glm-5.2",
      "opencode-go/kimi-k2.6",
      "opencode-go/minimax-m2.7",
    );
    expect(catalog.map((o) => o.brand)).toEqual(["deepseek", "zai", "kimi", "minimax"]);
  });
});
