import { describe, expect, test } from "bun:test";

import { markedMergedAt, prMergeSettlesThread } from "./threadSettlement.js";

describe("prMergeSettlesThread", () => {
  test("settles when the user never wrote", () => {
    expect(prMergeSettlesThread({ mergedAt: 1000, lastUserAuthoredAt: null })).toBe(true);
  });

  test("settles when the last prompt came at or before the merge", () => {
    expect(prMergeSettlesThread({ mergedAt: 1000, lastUserAuthoredAt: 1000 })).toBe(true);
    expect(prMergeSettlesThread({ mergedAt: 1000, lastUserAuthoredAt: 999 })).toBe(true);
  });

  test("leaves a thread the user wrote to after the merge", () => {
    expect(prMergeSettlesThread({ mergedAt: 1000, lastUserAuthoredAt: 1001 })).toBe(false);
  });

  test("refuses when the merge time is unknown but the user has written", () => {
    expect(prMergeSettlesThread({ mergedAt: null, lastUserAuthoredAt: 5 })).toBe(false);
  });

  test("settles a merge with no timestamp when the user has not written", () => {
    expect(prMergeSettlesThread({ mergedAt: null, lastUserAuthoredAt: null })).toBe(true);
  });
});
