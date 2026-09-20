import { describe, expect, test } from "bun:test";
import { ownsKey } from "./surfaceKeys";

/** A press nothing has consumed yet, and one a nested composer or dialog has. */
const FRESH = { defaultPrevented: false };
const HANDLED = { defaultPrevented: true };

describe("ownsKey", () => {
  test("the surface in front owns the key", () => {
    expect(ownsKey("inbox", "inbox", FRESH)).toBe(true);
  });

  test("a surface that is not in front owns nothing", () => {
    expect(ownsKey("assistant", "inbox", FRESH)).toBe(false);
  });

  test("any of several owners counts as owning it", () => {
    expect(ownsKey("stage", ["studio", "stage"], FRESH)).toBe(true);
    expect(ownsKey("studio", ["studio", "stage"], FRESH)).toBe(true);
  });

  test("a surface outside the owner list still owns nothing", () => {
    expect(ownsKey("inbox", ["studio", "stage"], FRESH)).toBe(false);
  });

  // The whole reason this check lives in here: a composer or a dialog nested in
  // the surface gets the event first, and an owner that answers anyway fires a
  // second time on a key that has already been spent.
  test("an event something nested has already handled is owned by nobody", () => {
    expect(ownsKey("inbox", "inbox", HANDLED)).toBe(false);
    expect(ownsKey("stage", ["studio", "stage"], HANDLED)).toBe(false);
  });
});
