import { describe, expect, test } from "bun:test";

import {
  brandsForOrigin,
  formatModelChain,
  originLabel,
  toDirectives,
} from "./detailFormat";

describe("toDirectives", () => {
  test("empty input reads as no directives", () => {
    expect(toDirectives(undefined)).toEqual([]);
    expect(toDirectives("")).toEqual([]);
  });

  test("a **lead** opener is lifted off its paragraph", () => {
    expect(toDirectives("**Never.** Do this thing.")).toEqual([
      { lead: "Never.", body: "Do this thing." },
    ]);
  });

  test("a paragraph with no opener reads as plain prose", () => {
    expect(toDirectives("Just a sentence.")).toEqual([{ lead: "", body: "Just a sentence." }]);
  });

  test("blank-line runs split paragraphs", () => {
    expect(toDirectives("**A.** One.\n\n\n**B.** Two.")).toEqual([
      { lead: "A.", body: "One." },
      { lead: "B.", body: "Two." },
    ]);
  });
});

describe("formatModelChain", () => {
  test("no pinned model reads as null; the caller names the fallback", () => {
    expect(formatModelChain(null, [])).toBeNull();
    expect(formatModelChain(undefined, null)).toBeNull();
  });

  test("a lone model reads bare, preferring its label", () => {
    expect(
      formatModelChain({ provider: "codex", model: "gpt-5", label: "GPT 5" }, []),
    ).toBe("GPT 5");
    expect(formatModelChain({ provider: "codex", model: "gpt-5" }, null)).toBe("gpt-5");
  });

  test("fallbacks join the head with arrows", () => {
    expect(
      formatModelChain(
        { provider: "codex", model: "gpt-5", label: "GPT 5" },
        [
          { provider: "cursor", model: "composer-1", label: "Composer" },
          { provider: "cursor", model: "auto" },
        ],
      ),
    ).toBe("GPT 5 → Composer → auto");
  });
});

describe("brandsForOrigin", () => {
  test("shared skills wear every harness mark", () => {
    expect(brandsForOrigin("agents")).toEqual(["codex", "cursor", "opencode", "droid", "antigravity"]);
  });

  test("known origins resolve to one mark", () => {
    expect(brandsForOrigin("claude")).toEqual(["claude"]);
    expect(brandsForOrigin("factory")).toEqual(["droid"]);
  });

  test("unknown origins fall through to the dot", () => {
    expect(brandsForOrigin("kone")).toEqual(["generic"]);
  });
});

describe("originLabel", () => {
  test("known origins read as names", () => {
    expect(originLabel("agents")).toBe("Shared");
    expect(originLabel("opencode")).toBe("OpenCode");
  });

  test("unknown origins read back as themselves", () => {
    expect(originLabel("kone")).toBe("kone");
  });
});
