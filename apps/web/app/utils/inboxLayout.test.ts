import { describe, expect, test } from "bun:test";
import {
  availablePaneWidth,
  CHROME_WIDTH,
  clampListWidth,
  DEFAULT_LIST_WIDTH,
  dragListWidth,
  GUTTER_KEY_STEP,
  GUTTER_KEY_STEP_LARGE,
  gutterKeyWidth,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  MIN_READ_WIDTH,
  resolveListWidth,
} from "./inboxLayout";

// Room enough that neither floor is in play.
const ROOMY = 1400;
// The same room, as the observer reports it — content box plus the rail and gaps.
const ROOMY_CONTENT = CHROME_WIDTH + ROOMY;
// Tight enough that the reading pane's floor is the ceiling: the list keeps 320.
const NARROW_CONTENT = CHROME_WIDTH + MIN_READ_WIDTH + 320;

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

describe("availablePaneWidth", () => {
  test("subtracts the rail and the gaps from what is observed", () => {
    expect(availablePaneWidth(ROOMY_CONTENT)).toBe(ROOMY);
  });

  test("stays wide before the first measurement, so a stored width is honoured", () => {
    expect(availablePaneWidth(0)).toBe(MAX_LIST_WIDTH * 2);
    expect(resolveListWidth(430, 0)).toBe(430);
  });
});

describe("resolveListWidth", () => {
  test("honours a stored width when there is room", () => {
    expect(resolveListWidth(430, ROOMY_CONTENT)).toBe(430);
  });

  test("yields to the reading pane's floor in a narrow window", () => {
    expect(resolveListWidth(MAX_LIST_WIDTH, NARROW_CONTENT)).toBe(320);
  });

  test("stops at the list's floor rather than disappearing", () => {
    expect(resolveListWidth(400, CHROME_WIDTH + MIN_READ_WIDTH)).toBe(MIN_LIST_WIDTH);
  });
});

describe("dragListWidth", () => {
  test("moves with the cursor, with no pointer in it", () => {
    expect(dragListWidth(400, 100, 140, ROOMY_CONTENT)).toBe(440);
    expect(dragListWidth(400, 140, 100, ROOMY_CONTENT)).toBe(360);
  });

  test("holds the list's own floor and ceiling", () => {
    expect(dragListWidth(400, 0, 9000, ROOMY_CONTENT)).toBe(MAX_LIST_WIDTH);
    expect(dragListWidth(400, 9000, 0, ROOMY_CONTENT)).toBe(MIN_LIST_WIDTH);
  });

  test("yields to the reading pane's floor in a narrow window", () => {
    expect(dragListWidth(320, 0, 400, NARROW_CONTENT)).toBe(320);
  });
});

describe("gutterKeyWidth", () => {
  test("nudges by one step, or four with Shift", () => {
    expect(gutterKeyWidth(400, "ArrowLeft", false, ROOMY_CONTENT)).toBe(400 - GUTTER_KEY_STEP);
    expect(gutterKeyWidth(400, "ArrowRight", false, ROOMY_CONTENT)).toBe(400 + GUTTER_KEY_STEP);
    expect(gutterKeyWidth(400, "ArrowLeft", true, ROOMY_CONTENT)).toBe(
      400 - GUTTER_KEY_STEP_LARGE,
    );
    expect(gutterKeyWidth(400, "ArrowRight", true, ROOMY_CONTENT)).toBe(
      400 + GUTTER_KEY_STEP_LARGE,
    );
  });

  test("Home and End respect the reading pane's floor", () => {
    expect(gutterKeyWidth(400, "Home", false, ROOMY_CONTENT)).toBe(MIN_LIST_WIDTH);
    expect(gutterKeyWidth(400, "End", false, ROOMY_CONTENT)).toBe(MAX_LIST_WIDTH);
    expect(gutterKeyWidth(400, "End", false, NARROW_CONTENT)).toBe(320);
    expect(gutterKeyWidth(400, "End", true, NARROW_CONTENT)).toBe(320);
  });

  test("leaves unhandled keys alone", () => {
    expect(gutterKeyWidth(400, "Enter", false, ROOMY_CONTENT)).toBeNull();
  });
});
