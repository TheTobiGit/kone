import { describe, expect, test } from "bun:test";
import { branchNameProblem, kindOf, localNameOf, shortAge, standing } from "./branchStanding";

describe("standing", () => {
  test("reads a branch against its remote", () => {
    const b = { name: "x", current: false, remote: false };
    expect(standing(b)).toBe("unpushed");
    expect(standing({ ...b, upstream: "origin/x" })).toBe("even");
    expect(standing({ ...b, upstream: "origin/x", ahead: 2 })).toBe("ahead");
    expect(standing({ ...b, upstream: "origin/x", behind: 1 })).toBe("behind");
    expect(standing({ ...b, upstream: "origin/x", ahead: 1, behind: 1 })).toBe("both");
    expect(standing({ ...b, upstream: "origin/x", gone: true })).toBe("gone");
  });
});

describe("names", () => {
  test("splits remote and kind", () => {
    expect(localNameOf("origin/feat/a")).toBe("feat/a");
    expect(kindOf("feat/a")).toBe("feat");
    expect(kindOf("main")).toBeNull();
  });

  test("names what git would refuse", () => {
    expect(branchNameProblem("feat/login")).toBeNull();
    expect(branchNameProblem("")).toBeNull();
    for (const bad of ["a b", "-x", "a..b", "a/", "/a", "a//b", "a~1", "a:b", "x.lock", "a/.b", "a@{1}", "a."]) {
      expect(branchNameProblem(bad)).not.toBeNull();
    }
  });

  test("ages read short", () => {
    expect(shortAge(null)).toBe("");
    expect(shortAge(0.5)).toBe("12h");
    expect(shortAge(3)).toBe("3d");
    expect(shortAge(21)).toBe("3w");
    expect(shortAge(90)).toBe("3mo");
    expect(shortAge(800)).toBe("2y");
  });
});
