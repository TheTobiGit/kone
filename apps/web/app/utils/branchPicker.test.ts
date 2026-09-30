import { describe, expect, test } from "bun:test";
import type { GitBranch } from "../types/desktop";
import { branchPickerOptions, checkoutErrorMessage } from "./branchPicker";

const local = (name: string, current = false, upstream?: string): GitBranch => ({
  name, current, remote: false, upstream,
});
const remote = (name: string): GitBranch => ({ name, current: false, remote: true });

describe("branchPickerOptions", () => {
  test("includes GitHub branches without duplicating their local copies", () => {
    const options = branchPickerOptions([
      local("dev"),
      local("linux/desktop-shell", true, "origin/linux/desktop-shell"),
      local("main", false, "origin/main"),
      local("wip/handoff-2026-09-22"),
      remote("origin/dev"),
      remote("origin/feat/agent-roles"),
      remote("origin/linux/desktop-shell"),
      remote("origin/main"),
      remote("origin/review/lsp-ast-presets-slash"),
      remote("origin/wip/handoff-2026-09-22"),
    ]);
    expect(options.map((branch) => branch.name)).toEqual([
      "linux/desktop-shell", "dev", "main", "wip/handoff-2026-09-22",
      "origin/feat/agent-roles", "origin/review/lsp-ast-presets-slash",
    ]);
  });

  test("keeps the remote explicit when two remotes have the same branch", () => {
    expect(branchPickerOptions([
      local("main", true), remote("origin/feature/login"), remote("upstream/feature/login"),
    ]).map((branch) => branch.name)).toEqual([
      "main", "origin/feature/login", "upstream/feature/login",
    ]);
  });

  test("recognizes a local copy with a different name through its upstream", () => {
    expect(branchPickerOptions([
      local("my-feature", false, "origin/feature/login"), remote("origin/feature/login"),
    ]).map((branch) => branch.name)).toEqual(["my-feature"]);
  });

  test("supports a project without remotes or branches", () => {
    expect(branchPickerOptions([local("feature/login", true)])).toEqual([local("feature/login", true)]);
    expect(branchPickerOptions([])).toEqual([]);
  });
});

describe("checkoutErrorMessage", () => {
  test("turns git's overwrite refusal into the commit-or-stash hint", () => {
    const err =
      "Error invoking remote method 'git:checkout': GitError: error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting";
    expect(checkoutErrorMessage(err)).toBe("Couldn’t switch — commit or stash changes first");
  });

  test("shows git's own line for any other failure", () => {
    const err =
      "Error invoking remote method 'git:checkout': GitError: Branch origin/gone no longer exists — refresh the branch list.";
    expect(checkoutErrorMessage(err)).toBe("Branch origin/gone no longer exists — refresh the branch list.");
  });

  test("falls back when git said nothing", () => {
    expect(checkoutErrorMessage("")).toBe("Couldn’t switch branches");
  });
});
