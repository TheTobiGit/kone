import { describe, expect, test } from "bun:test";
import {
  clampListWidth,
  DEFAULT_LIST_WIDTH,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  MIN_READ_WIDTH,
} from "./inboxLayout";

// Room enough that neither floor is in play.
const ROOMY = 1400;

describe("clampListWidth", () => {
  test("honours a width that fits", () => {
    expect(clampListWidth(430, ROOMY)).toBe(430);
  });

  test("holds the list's own floor and ceiling", () => {
    expect(clampListWidth(0, ROOMY)).toBe(MIN_LIST_WIDTH);
    expect(clampListWidth(9000, ROOMY)).toBe(MAX_LIST_WIDTH);
  });

  test("gives way to the reading pane's floor in a narrow window", () => {
    const available = MIN_READ_WIDTH + 320;
    expect(clampListWidth(MAX_LIST_WIDTH, available)).toBe(320);
  });

  test("stops at the list's floor rather than disappearing", () => {
    // Too tight to honour both. The list yields, but only as far as its own
    // minimum — a list narrowed to nothing is worse than a cramped reader.
    expect(clampListWidth(400, MIN_READ_WIDTH)).toBe(MIN_LIST_WIDTH);
    expect(clampListWidth(400, 0)).toBe(MIN_LIST_WIDTH);
  });

  test("falls back to the default when the stored value is not a number", () => {
    expect(clampListWidth(Number.NaN, ROOMY)).toBe(DEFAULT_LIST_WIDTH);
  });

  test("always returns whole pixels", () => {
    expect(clampListWidth(412.6, ROOMY)).toBe(413);
  });
});
