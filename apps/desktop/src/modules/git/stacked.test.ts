import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

mock.module("electron", () => ({ shell: { openExternal: () => {} } }));

const { git } = await import("./core.js");
const { runStackedAction } = await import("./stacked.js");
import type { GitActionProgressEvent } from "./types.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-stacked-test-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@kone.app"]);
  await git(dir, ["config", "user.name", "Kone Test"]);
  await writeFile(path.join(dir, "init.txt"), "hello\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "initial commit"]);
  return dir;
}

describe("runStackedAction", () => {
  test("commits already staged changes and returns sha", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "feature.ts"), "export const a = 1;\n", "utf8");
    await git(dir, ["add", "feature.ts"]);

    const events: GitActionProgressEvent[] = [];
    const res = await runStackedAction(
      dir,
      {
        dir,
        action: "commit",
        message: "feat: add feature module",
        body: "First feature implementation",
      },
      (ev: GitActionProgressEvent) => events.push(ev),
    );

    expect(res.action).toBe("commit");
    expect(res.commitSha).toBeDefined();
    expect(res.commitSha?.length).toBe(40);
    expect(res.subject).toBe("feat: add feature module");
    expect(events.some((e: GitActionProgressEvent) => e.phase === "commit")).toBe(true);

    const logOut = await git(dir, ["log", "-1", "--pretty=%B"]);
    expect(logOut).toContain("feat: add feature module");
    expect(logOut).toContain("First feature implementation");
  });

  test("stages selective filePaths and commits only those files", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "f1.txt"), "1\n", "utf8");
    await writeFile(path.join(dir, "f2.txt"), "2\n", "utf8");

    const res = await runStackedAction(dir, {
      dir,
      action: "commit",
      message: "feat: add f1 only",
      filePaths: ["f1.txt"],
    });

    expect(res.commitSha).toBeDefined();

    // f2.txt should remain untracked
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status).toContain("?? f2.txt");
    expect(status).not.toContain("f1.txt");
  });

  test("creates feature branch when requested and commits onto it", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "feat.txt"), "new feature\n", "utf8");

    const res = await runStackedAction(dir, {
      dir,
      action: "commit_new_branch",
      branchName: "feature/new-login",
      message: "feat: implement new login",
    });

    expect(res.branch).toBe("feature/new-login");
    const currentBranch = (await git(dir, ["branch", "--show-current"])).trim();
    expect(currentBranch).toBe("feature/new-login");
  });
});
