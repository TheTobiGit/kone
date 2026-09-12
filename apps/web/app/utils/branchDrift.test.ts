import { describe, expect, test } from "bun:test";
import { resolveBranchDrift } from "./branchDrift";

describe("resolveBranchDrift", () => {
  test("reports the two branches when they differ", () => {
    expect(resolveBranchDrift({ recorded: "main", live: "dev" })).toEqual({
      ranOn: "main",
      nowOn: "dev",
    });
  });

  test("stays quiet when the checkout has not moved", () => {
    expect(resolveBranchDrift({ recorded: "main", live: "main" })).toBeNull();
  });

  test("stays quiet on a thread that has never run", () => {
    expect(resolveBranchDrift({ recorded: null, live: "main" })).toBeNull();
    expect(resolveBranchDrift({ recorded: undefined, live: "main" })).toBeNull();
  });

  test("stays quiet when git cannot name the current branch", () => {
    expect(resolveBranchDrift({ recorded: "main", live: null })).toBeNull();
  });

  test("treats surrounding whitespace as no difference at all", () => {
    expect(resolveBranchDrift({ recorded: " main ", live: "main" })).toBeNull();
  });

  test("does not report an empty branch name as a branch", () => {
    expect(resolveBranchDrift({ recorded: "", live: "main" })).toBeNull();
    expect(resolveBranchDrift({ recorded: "main", live: "   " })).toBeNull();
  });
});

describe("a thread with a working tree of its own", () => {
  test("never reports drift, however far the project has moved", () => {
    // Nothing can check out a different branch inside a dedicated worktree, so
    // the two names disagreeing here is not a hazard — it is the project having
    // moved on somewhere this thread does not live.
    expect(
      resolveBranchDrift({
        recorded: "feature/foo",
        live: "main",
        worktreePath: "/state/worktrees/kone/feature-foo-ab12cd",
      }),
    ).toBeNull();
  });

  test("a worktree still being built is exempt too", () => {
    // Nothing has run yet, and when it does it will not be in the project's
    // checkout either.
    expect(
      resolveBranchDrift({ recorded: "feature", live: "main", envMode: "worktree" }),
    ).toBeNull();
  });

  test("a local thread with no worktree still runs the ordinary check", () => {
    expect(resolveBranchDrift({ recorded: "feature", live: "main", envMode: "local" })).toEqual({
      ranOn: "feature",
      nowOn: "main",
    });
  });

  test("an empty path is not a worktree, and the ordinary check still runs", () => {
    expect(
      resolveBranchDrift({ recorded: "feature", live: "main", worktreePath: "  " }),
    ).toEqual({ ranOn: "feature", nowOn: "main" });
  });
});
