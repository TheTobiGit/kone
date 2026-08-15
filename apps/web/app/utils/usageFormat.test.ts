import { describe, expect, test } from "bun:test";

import { formatTokens } from "./usageFormat";

describe("formatTokens", () => {
  test("sub-thousand values are plain integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("picks the right magnitude band", () => {
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(1_230_000)).toBe("1.23M");
    expect(formatTokens(10_000_000_000)).toBe("10B");
  });

  test("a value that rounds to the next magnitude rolls over instead of printing 1000", () => {
    expect(formatTokens(999_950)).toBe("1M");
    expect(formatTokens(999_999_999)).toBe("1B");
    expect(formatTokens(999_999_000_000)).toBe("1T");
  });
});
