import { describe, expect, test } from "bun:test";
import type { UsageBySlice } from "~/types/desktop";
import { OTHER_KEY, TOP_MODELS, rankModels, ringSlices } from "./spaceModels";
import { PROVIDER_COLORS } from "./usageProviders";

const colors = PROVIDER_COLORS.light;

function model(
  key: string,
  provider: string | undefined,
  prompts: number,
  extra: Partial<UsageBySlice> = {},
): UsageBySlice {
  return {
    key,
    label: extra.label ?? key,
    provider,
    tokens: 1000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    prompts,
    costUsd: 0,
    unpricedRecords: 0,
    ...extra,
  };
}

describe("rankModels", () => {
  test("ranks by responses, breaking ties on output tokens", () => {
    const { entries } = rankModels(
      [
        model("a", "codex", 5, { outputTokens: 10 }),
        model("b", "codex", 9),
        model("c", "codex", 5, { outputTokens: 99 }),
      ],
      colors,
    );
    expect(entries.map((e) => e.key)).toEqual(["b", "c", "a"]);
  });

  test("leaves out models with no responses, no tokens, or no known agent", () => {
    const { entries, total, count } = rankModels(
      [
        model("kept", "codex", 4),
        model("silent", "codex", 0),
        model("empty", "codex", 3, { tokens: 0 }),
        model("orphan", undefined, 3),
        model("foreign", "gemini", 3),
      ],
      colors,
    );
    expect(entries.map((e) => e.key)).toEqual(["kept"]);
    expect(total).toBe(4);
    expect(count).toBe(1);
  });

  test("an older report without output tokens still ranks", () => {
    const { entries } = rankModels([model("a", "codex", 2), model("b", "codex", 2)], colors);
    expect(entries.every((e) => e.kind === "model" && e.outputTokens === 0)).toBe(true);
  });

  test("shares add up to the whole", () => {
    const { entries } = rankModels(
      Array.from({ length: 8 }, (_, i) => model(`m${i}`, "claudeAgent", i + 1)),
      colors,
    );
    expect(entries.reduce((sum, e) => sum + e.share, 0)).toBeCloseTo(1, 10);
  });

  test("folds everything past the top few into one other entry", () => {
    const { entries, count, total } = rankModels(
      Array.from({ length: TOP_MODELS + 3 }, (_, i) => model(`m${i}`, "codex", 100 - i)),
      colors,
    );
    expect(entries).toHaveLength(TOP_MODELS + 1);
    expect(count).toBe(TOP_MODELS + 3);
    const other = entries.at(-1)!;
    expect(other.kind).toBe("other");
    expect(other.key).toBe(OTHER_KEY);
    if (other.kind !== "other") throw new Error("unreachable");
    expect(other.models).toBe(3);
    expect(other.responses).toBe(95 + 94 + 93);
    expect(other.share).toBeCloseTo((95 + 94 + 93) / total, 10);
  });

  test("names no other entry when nothing folds", () => {
    const { entries } = rankModels(
      Array.from({ length: TOP_MODELS }, (_, i) => model(`m${i}`, "codex", i + 1)),
      colors,
    );
    expect(entries.some((e) => e.kind === "other")).toBe(false);
  });

  test("every model from one agent gets its own tint", () => {
    const { entries } = rankModels(
      Array.from({ length: TOP_MODELS }, (_, i) => model(`m${i}`, "claudeAgent", 50 - i)),
      colors,
    );
    const tints = entries.map((e) => e.color);
    expect(new Set(tints).size).toBe(TOP_MODELS);
    // The first keeps the agent's own colour.
    expect(tints[0]).toBe(colors.claudeAgent);
  });

  test("a different agent starts again from its own colour", () => {
    const { entries } = rankModels([model("a", "claudeAgent", 9), model("b", "codex", 8)], colors);
    expect(entries.map((e) => e.color)).toEqual([colors.claudeAgent, colors.codex]);
  });

  test("strips a free-tier suffix from the name and flags it", () => {
    const { entries } = rankModels(
      [model("x", "opencode", 3, { label: "glm-4.7-free" }), model("y", "opencode", 2, { label: "glm-4.7" })],
      colors,
    );
    const [free, paid] = entries;
    if (free?.kind !== "model" || paid?.kind !== "model") throw new Error("expected two models");
    expect(free.free).toBe(true);
    expect(free.name).not.toMatch(/free$/i);
    expect(paid.free).toBe(false);
    expect(free.name).toBe(paid.name);
  });
});

describe("ringSlices", () => {
  const part = (key: string, share: number) => ({ key, share, color: "#000" });

  test("a lone slice is the whole half-ring", () => {
    const [only, ...rest] = ringSlices([part("a", 1)]);
    expect(rest).toEqual([]);
    expect(only!.from).toBe(180);
    expect(only!.to).toBeCloseTo(0, 9);
  });

  test("slices close the arc at exactly 0°, with a gap between each", () => {
    const slices = ringSlices([part("a", 0.6), part("b", 0.3), part("c", 0.1)]);
    expect(slices[0]!.from).toBe(180);
    expect(slices.at(-1)!.to).toBeCloseTo(0, 9);
    for (let i = 1; i < slices.length; i++) expect(slices[i - 1]!.to - slices[i]!.from).toBeCloseTo(2.2, 9);
  });

  test("a tiny model keeps a sliver, and the rest give way for it", () => {
    const slices = ringSlices([part("big", 0.9999), part("tiny", 0.0001)]);
    const spans = slices.map((s) => s.from - s.to);
    expect(spans[1]!).toBeGreaterThan(2.5);
    expect(slices.at(-1)!.to).toBeCloseTo(0, 9);
  });

  test("a model with no share gets no slice, and nothing gives no ring", () => {
    expect(ringSlices([part("a", 1), part("none", 0)]).map((s) => s.key)).toEqual(["a"]);
    expect(ringSlices([])).toEqual([]);
  });

  test("no arc asks for the large-arc flag", () => {
    for (const s of ringSlices([part("a", 1)])) expect(s.d).not.toMatch(/A [\d.]+ [\d.]+ 0 1 /);
  });
});
