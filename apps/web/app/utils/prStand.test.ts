import { describe, expect, test } from "bun:test";

import { prStandOf, type PrStandInput } from "./prStand";

const base: PrStandInput = {
  state: "open",
  isDraft: false,
  mergeability: "clean",
  reviewDecision: "approved",
  reviewers: [{ state: "approved" }],
  failingChecks: 0,
  pendingChecks: 0,
};

describe("prStandOf", () => {
  test("a clean, approved, green pull request is ready", () => {
    expect(prStandOf(base)).toBe("ready");
  });

  test("an open review request outranks an approval", () => {
    expect(prStandOf({ ...base, reviewers: [{ state: "approved" }, { state: "pending" }] })).toBe("review");
  });

  test("the repository's merge rules hold back an otherwise ready one", () => {
    expect(prStandOf({ ...base, mergeability: "blocked" })).toBe("blocked");
    expect(prStandOf({ ...base, mergeability: "behind" })).toBe("behind");
    expect(prStandOf({ ...base, mergeability: "unknown" })).toBe("checking");
    expect(prStandOf({ ...base, mergeability: "unstable" })).toBe("ready");
  });

  test("obstacles come in the order they'd be dealt with", () => {
    expect(prStandOf({ ...base, mergeability: "conflicting", failingChecks: 1 })).toBe("conflict");
    expect(prStandOf({ ...base, failingChecks: 1, reviewDecision: "changes-requested" })).toBe("failing");
    expect(prStandOf({ ...base, reviewDecision: "changes-requested", pendingChecks: 1 })).toBe("changes");
    expect(prStandOf({ ...base, pendingChecks: 1, mergeability: "blocked" })).toBe("running");
    expect(prStandOf({ ...base, isDraft: true, failingChecks: 1 })).toBe("draft");
    expect(prStandOf({ ...base, state: "merged", isDraft: true })).toBe("merged");
  });
});
