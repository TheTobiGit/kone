import { describe, expect, test } from "bun:test";
import { areaOf, churnOf, dirOf, changeKindOf, nameOf, sideOf } from "./changeLanguage";

describe("areaOf", () => {
  test("stops at the folder the work lives in", () => {
    expect(areaOf("apps/web/app/components/ProjectView.vue")).toBe("apps/web");
    expect(areaOf("packages/git-core/src/status.ts")).toBe("packages/git-core");
    expect(areaOf("docs/peek.md")).toBe("docs");
    expect(areaOf("README.md")).toBe("root");
  });
});

describe("a change", () => {
  test("reads where its work sits, partly staged as its own state", () => {
    expect(sideOf({ path: "a", status: "modified", staged: true, unstaged: false })).toBe("staged");
    expect(sideOf({ path: "a", status: "modified", staged: false, unstaged: true })).toBe("unstaged");
    expect(sideOf({ path: "a", status: "modified", staged: true, unstaged: true })).toBe("partly");
  });

  test("counts both sides of the diff", () => {
    const c = { path: "a", status: "modified" as const, staged: true, unstaged: true, added: 4, removed: 2 };
    expect(churnOf(c)).toBe(6);
    expect(churnOf({ ...c, added: undefined, removed: undefined })).toBe(0);
  });

  test("has a kind and a path split", () => {
    expect(changeKindOf("conflicted").label).toBe("Conflicted");
    expect(changeKindOf("ignored").label).toBe("Ignored");
    expect(nameOf("apps/web/app.vue")).toBe("app.vue");
    expect(dirOf("apps/web/app.vue")).toBe("apps/web/");
    expect(dirOf("README.md")).toBe("");
  });
});
