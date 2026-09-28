import { describe, expect, test } from "bun:test";

import { emptySnapshot, resolveModelRates } from "./resolver.js";

describe("resolveModelRates free tiers", () => {
  test("an uncatalogued free-tier id prices at nothing instead of going unpriced", () => {
    for (const model of ["opencode/muse-spark-1.3-contributor-free", "meta-llama/llama-4:free"]) {
      const rates = resolveModelRates(emptySnapshot, model);
      expect(rates).not.toBeNull();
      expect(rates?.inputPerMillion).toBe(0);
      expect(rates?.outputPerMillion).toBe(0);
    }
  });

  test("a name that merely contains 'free' is still unknown", () => {
    expect(resolveModelRates(emptySnapshot, "freestyle-large")).toBeNull();
    expect(resolveModelRates(emptySnapshot, "mystery-model")).toBeNull();
  });

  test("a catalogued model keeps its real rates even if its id ends in -free", () => {
    const snapshot = {
      primary: {
        entries: {
          "paid-but-named-free": {
            inputPerMillion: 1,
            outputPerMillion: 2,
            cacheWritePerMillion: 1,
            cacheReadPerMillion: 0.1,
            cacheReadIsExplicit: true,
            fastMultiplier: 1,
          },
        },
      },
      secondary: { entries: {} },
    };
    expect(resolveModelRates(snapshot, "paid-but-named-free")?.inputPerMillion).toBe(1);
  });
});
