import { describe, expect, test } from "bun:test";
import { LONGER_USAGE_RANGES, USAGE_RANGES, USAGE_RANGE_IDS } from "./usageRanges";

describe("usage ranges", () => {
  test("run shortest window first — the order a pass over them should read in", () => {
    expect(USAGE_RANGE_IDS).toEqual(["1d", "7d", "30d", "all"]);
  });

  test("give every window a name for each place it is shown", () => {
    for (const range of USAGE_RANGES) {
      expect(range.label).not.toBe("");
      expect(range.short).not.toBe("");
      expect(range.long).not.toBe("");
    }
  });

  test("the longer windows are all but today", () => {
    expect(LONGER_USAGE_RANGES.map((r) => r.id)).toEqual(["7d", "30d", "all"]);
  });
});
