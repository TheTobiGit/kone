import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeAboutDrift, withDrift } from "./messageAbout.js";

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-about-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  let n = 0;
  const commit = (msg: string) => {
    writeFileSync(path.join(dir, "f.txt"), `${msg} ${++n}`);
    git("add", "f.txt");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { dir, commit, git };
}

describe("describeAboutDrift", () => {
  test("says nothing while the branch is where the message left it", () => {
    const r = repo();
    const at = r.commit("one");
    expect(describeAboutDrift(r.dir, { branch: "main", commit: at })).toBeNull();
    expect(describeAboutDrift(r.dir, { branch: "main", commit: at.slice(0, 7) })).toBeNull();
  });

  test("counts the commits the branch has moved past it", () => {
    const r = repo();
    const at = r.commit("one");
    r.commit("two");
    const tip = r.commit("three");
    expect(describeAboutDrift(r.dir, { branch: "main", commit: at })).toBe(
      `This message is about main at ${at.slice(0, 7)}; the branch has moved 2 commits past it since (tip ${tip.slice(0, 7)}). Check what changed before acting on this.`,
    );
  });

  test("a rewritten branch, and a deleted one, are said so", () => {
    const r = repo();
    r.commit("one");
    const dropped = r.commit("two");
    r.git("reset", "-q", "--hard", "HEAD~1");
    r.commit("other");
    expect(describeAboutDrift(r.dir, { branch: "main", commit: dropped })).toContain("was rewritten since");
    r.git("branch", "-q", "side");
    expect(describeAboutDrift(r.dir, { branch: "gone", commit: dropped })).toContain("no longer exists");
  });

  test("kone says nothing it cannot tell: no repository, or a commit it does not know", () => {
    const r = repo();
    r.commit("one");
    expect(describeAboutDrift(r.dir, { branch: "main", commit: "deadbeefdeadbeef" })).toBeNull();
    expect(describeAboutDrift(path.join(r.dir, "missing"), { branch: "main", commit: "abc1234" })).toBeNull();
  });
});

test("withDrift sets kone's line under the message's own words", () => {
  expect(withDrift({ message: "Fix it." })).toBe("Fix it.");
  expect(withDrift({ message: "Fix it.", aboutDrift: "moved" })).toBe("Fix it.\n(kone: moved)");
});
