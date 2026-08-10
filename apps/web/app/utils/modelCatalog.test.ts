import { describe, expect, test } from "bun:test";

import type { ModelDescriptor } from "~/types/desktop";
import { buildModelCatalog, parseModelTsvRows } from "./modelCatalog";

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

  test("a vendor that gained a mark resolves to it, not the generic dot", () => {
    expect(brandFor("opencode-go/grok-4.5")).toEqual({ brand: "grok", vendor: "xAI" });
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

describe("parseModelTsvRows — defensive provider model-table parsing", () => {
  test("collapses slug<TAB>label rows (Antigravity `agy models` style)", () => {
    expect(
      parseModelTsvRows([
        "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
        "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n")),
    ).toEqual([
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
      { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  test("tolerates CRLF endings and stray ANSI colour codes", () => {
    expect(
      parseModelTsvRows("\x1b[32mgemini-3.6-flash\tGemini 3.6 Flash\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6\r\n"),
    ).toEqual([
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    ]);
  });

  test("tolerates a blank label column and extra whitespace around cells", () => {
    expect(
      parseModelTsvRows([
        "  gemini-3.6-flash  \t  Gemini 3.6 Flash  ",
        "claude-sonnet-4-6\t",
        "gemini-3.1-pro\t",
      ].join("\n")),
    ).toEqual([
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
      { id: "gemini-3.1-pro", label: "gemini-3.1-pro" },
    ]);
  });

  test("parses headerless single-column output (id is its own label)", () => {
    expect(parseModelTsvRows("gemini-3.6-flash\nclaude-sonnet-4-6\n")).toEqual([
      { id: "gemini-3.6-flash", label: "gemini-3.6-flash" },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    ]);
  });

  test("skips a leading header row but not a model actually named like one", () => {
    expect(parseModelTsvRows("slug\tname\ngemini-3.6-flash\tGemini 3.6 Flash\n")).toEqual([
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    ]);
    expect(parseModelTsvRows("model\tGemini 3.6 Flash\n")).toEqual([
      { id: "model", label: "Gemini 3.6 Flash" },
    ]);
  });

  test("skips malformed rows and blank lines instead of throwing", () => {
    expect(
      parseModelTsvRows("gemini-3.6-flash\tGemini 3.6 Flash\n\n\t\n   \n\t\t\nclaude-sonnet-4-6\n"),
    ).toEqual([
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    ]);
    expect(parseModelTsvRows("")).toEqual([]);
    expect(parseModelTsvRows("   \n\t\n")).toEqual([]);
  });
});

describe("buildModelCatalog — malformed descriptors never become garbage entries", () => {
  test("skips descriptors with a blank or non-string id", () => {
    const models = [
      { id: "", label: "Empty id" },
      { id: "   ", label: "Whitespace id" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ] as unknown as ModelDescriptor[];
    expect(buildModelCatalog(models).map((o) => o.key)).toEqual(["gpt-5.6-terra"]);
  });

  test("falls back to the prettified id when the label is blank", () => {
    const models = [
      { id: "gemini-3.6-flash", label: "" },
      { id: "claude-sonnet-4-6", label: "   " },
    ] as unknown as ModelDescriptor[];
    const catalog = buildModelCatalog(models);
    expect(catalog.map((o) => o.label)).toEqual(["Gemini 3.6 Flash", "Claude Sonnet 4.6"]);
  });
});
