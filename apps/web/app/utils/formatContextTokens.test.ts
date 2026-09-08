import { describe, expect, test } from "bun:test";

import { formatContextTokens, formatWindowPercent } from "./formatContextTokens";

describe("formatContextTokens", () => {
  test("small counts stay bare", () => {
    expect(formatContextTokens(0)).toBe("0");
    expect(formatContextTokens(48)).toBe("48");
    expect(formatContextTokens(999)).toBe("999");
  });

  test("thousands take one decimal under 10k, then round", () => {
    expect(formatContextTokens(1400)).toBe("1.4k");
    expect(formatContextTokens(200000)).toBe("200k");
    expect(formatContextTokens(48000)).toBe("48k");
  });

  test("millions take one decimal", () => {
    expect(formatContextTokens(1000000)).toBe("1m");
    expect(formatContextTokens(2500000)).toBe("2.5m");
  });

  test("unknown is zero, never blank", () => {
    expect(formatContextTokens(undefined)).toBe("0");
    expect(formatContextTokens(Number.NaN)).toBe("0");
  });
});

describe("formatWindowPercent", () => {
  test("one decimal under 10%, bare when exact", () => {
    expect(formatWindowPercent(5.83)).toBe("5.8%");
    expect(formatWindowPercent(6)).toBe("6%");
    expect(formatWindowPercent(0)).toBe("0%");
  });

  test("integer-rounded at and above 10%", () => {
    expect(formatWindowPercent(10)).toBe("10%");
    expect(formatWindowPercent(48.4)).toBe("48%");
    expect(formatWindowPercent(99.6)).toBe("100%");
  });
});
