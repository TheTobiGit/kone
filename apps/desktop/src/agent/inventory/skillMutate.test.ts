import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  SOURCE_MANIFEST_FILENAME,
  applyFrontmatterEdits,
  deleteSkillToTrash,
  editSkillFrontmatter,
  installSkillFromGit,
  scaffoldSkill,
  validateSkillDescription,
  validateSkillName,
} from "./skillMutate.js";

// The module builds derived paths on realpath(root), and macOS /var is a
// symlink — canonicalize every fixture dir so path-equality assertions hold.
function makeTemp(prefix = "kone-mutate-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function writeFile(parent: string, rel: string, content: string): string {
  const file = path.join(parent, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

/** Initialize a commit-able repo at `dir` with the given files. */
function makeGitRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@kone.dev"]);
  git(dir, ["config", "user.name", "kone test"]);
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
}

function skillMarkdown(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: A test skill.\n${extra}---\n\n# body\n`;
}

function asOk(result: { ok: boolean; text?: string; error?: string }): string {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.text!;
}

// ── pure frontmatter line editing ────────────────────────────────────────────

describe("applyFrontmatterEdits", () => {
  const kitchenSink = [
    "---",
    "# a comment kone must keep",
    "name: alpha",
    "metadata:",
    "  nested: yes",
    "  deep:",
    "    - a",
    "    - b",
    "",
    "description: Old description.",
    "license: MIT",
    "---",
    "",
    "# body keeps every byte",
    "some markdown",
    "",
  ].join("\n");

  test("set replaces only the target line and preserves everything else byte-for-byte", () => {
    const result = applyFrontmatterEdits(kitchenSink, [{ op: "set", key: "description", value: "New description." }]);
    const text = asOk(result);
    expect(text).toBe(kitchenSink.replace("description: Old description.", "description: New description."));
  });

  test("set preserves the on-disk spelling of the key it edits", () => {
    const raw = "---\nDescription: old\nlicense: MIT\n---\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "set", key: "Description", value: "new" }]));
    expect(text).toBe("---\nDescription: new\nlicense: MIT\n---\n");
  });

  test("set on a key with a nested map replaces the whole subtree, not just its first line", () => {
    const raw = "---\nname: alpha\nmetadata:\n  nested: yes\n  other: 2\nlicense: MIT\n---\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "set", key: "metadata", value: "{}" }]));
    expect(text).toBe("---\nname: alpha\nmetadata: {}\nlicense: MIT\n---\n");
  });

  test("set on a block-scalar key replaces the scalar's continuation lines too", () => {
    const raw = "---\nname: alpha\nwhen_to_use: |\n  first line\n  second line\nlicense: MIT\n---\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "set", key: "when_to_use", value: "flat now" }]));
    expect(text).toBe("---\nname: alpha\nwhen_to_use: flat now\nlicense: MIT\n---\n");
  });

  test("set of an absent key inserts one line before the closing delimiter", () => {
    const raw = "---\nname: alpha\n---\nbody\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "set", key: "license", value: "MIT" }]));
    expect(text).toBe("---\nname: alpha\nlicense: MIT\n---\nbody\n");
  });

  test("a file with no frontmatter gets a block prepended, body intact", () => {
    const text = asOk(
      applyFrontmatterEdits("# just body\n\nsome markdown\n", [
        { op: "set", key: "name", value: "alpha" },
        { op: "set", key: "description", value: "d" },
      ]),
    );
    expect(text).toBe("---\nname: alpha\ndescription: d\n---\n# just body\n\nsome markdown\n");
  });

  test("set with an empty value writes a bare key line", () => {
    const text = asOk(applyFrontmatterEdits("---\nname: alpha\n---\n", [{ op: "set", key: "license", value: "" }]));
    expect(text).toBe("---\nname: alpha\nlicense:\n---\n");
  });

  test("delete removes exactly the key line", () => {
    const raw = "---\nname: alpha\ndescription: old\nlicense: MIT\n---\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "delete", key: "license" }]));
    expect(text).toBe("---\nname: alpha\ndescription: old\n---\n");
  });

  test("delete of a nested-map key removes its subtree", () => {
    const raw = "---\nname: alpha\nmetadata:\n  nested: yes\n  deep:\n    - a\nlicense: MIT\n---\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "delete", key: "metadata" }]));
    expect(text).toBe("---\nname: alpha\nlicense: MIT\n---\n");
  });

  test("delete of an absent key is a no-op, not an error", () => {
    const text = asOk(applyFrontmatterEdits("---\nname: alpha\n---\n", [{ op: "delete", key: "license" }]));
    expect(text).toBe("---\nname: alpha\n---\n");
  });

  test("CRLF files keep CRLF and only the edited line changes", () => {
    const raw = ["---", "# comment", "name: alpha", "description: old", "---", "body"].join("\r\n") + "\r\n";
    const text = asOk(applyFrontmatterEdits(raw, [{ op: "set", key: "description", value: "new" }]));
    expect(text).toBe(["---", "# comment", "name: alpha", "description: new", "---", "body"].join("\r\n") + "\r\n");
  });

  test("edits apply in order, a later set wins", () => {
    const text = asOk(
      applyFrontmatterEdits("---\nname: alpha\n---\n", [
        { op: "set", key: "license", value: "MIT" },
        { op: "set", key: "license", value: "Apache-2.0" },
      ]),
    );
    expect(text).toBe("---\nname: alpha\nlicense: Apache-2.0\n---\n");
  });

  test("a key that exists only as a nested field is refused, not flattened", () => {
    const raw = "---\nname: alpha\nmetadata:\n  nested: yes\n---\n";
    const set = applyFrontmatterEdits(raw, [{ op: "set", key: "nested", value: "x" }]);
    expect(set.ok).toBe(false);
    const del = applyFrontmatterEdits(raw, [{ op: "delete", key: "nested" }]);
    expect(del.ok).toBe(false);
  });

  test("invalid keys and multi-line values are refused", () => {
    expect(applyFrontmatterEdits("---\nname: alpha\n---\n", [{ op: "set", key: "my key", value: "x" }]).ok).toBe(false);
    expect(applyFrontmatterEdits("---\nname: alpha\n---\n", [{ op: "set", key: "my:key", value: "x" }]).ok).toBe(false);
    expect(applyFrontmatterEdits("---\nname: alpha\n---\n", [{ op: "set", key: "license", value: "a\nb" }]).ok).toBe(false);
  });

  test("an opening --- with no closing --- is refused, never rewritten", () => {
    const result = applyFrontmatterEdits("---\nname: alpha\n", [{ op: "set", key: "license", value: "MIT" }]);
    expect(result.ok).toBe(false);
  });
});

// ── name/description validation ─────────────────────────────────────────────

describe("validateSkillName / validateSkillDescription", () => {
  test("accepts valid names and rejects everything else", () => {
    expect(validateSkillName("demo")).toBeNull();
    expect(validateSkillName("my-skill-name")).toBeNull();
    expect(validateSkillName("a1-b2")).toBeNull();
    expect(validateSkillName("Demo")).not.toBeNull();
    expect(validateSkillName("my_skill")).not.toBeNull();
    expect(validateSkillName("my.skill")).not.toBeNull();
    expect(validateSkillName("")).not.toBeNull();
    expect(validateSkillName("a".repeat(65))).not.toBeNull();
    expect(validateSkillName("a".repeat(64))).toBeNull();
  });

  test("descriptions must exist, be single-line, and stay under 1024 chars", () => {
    expect(validateSkillDescription("Does a thing.")).toBeNull();
    expect(validateSkillDescription("")).not.toBeNull();
    expect(validateSkillDescription("   ")).not.toBeNull();
    expect(validateSkillDescription("line one\nline two")).not.toBeNull();
    expect(validateSkillDescription("x".repeat(1024))).toBeNull();
    expect(validateSkillDescription("x".repeat(1025))).not.toBeNull();
  });
});

// ── scaffold ────────────────────────────────────────────────────────────────

describe("scaffoldSkill", () => {
  test("creates the folder and a minimal valid SKILL.md", async () => {
    const root = makeTemp();
    const result = await scaffoldSkill(root, "demo-skill", "A demo skill.");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("scaffold");
    expect(result.path).toBe(path.join(root, "demo-skill", "SKILL.md"));
    expect(readFileSync(result.path!, "utf8")).toBe("---\nname: demo-skill\ndescription: A demo skill.\n---\n");
  });

  test("refuses invalid names and descriptions without touching disk", async () => {
    const root = makeTemp();
    for (const name of ["My Skill", "my_skill", "my.skill", "", "a".repeat(65)]) {
      const result = await scaffoldSkill(root, name, "fine description");
      expect(result.ok).toBe(false);
    }
    for (const description of ["", "line1\nline2", "x".repeat(1025)]) {
      const result = await scaffoldSkill(root, "fine-name", description);
      expect(result.ok).toBe(false);
    }
    expect(existsSync(path.join(root, "fine-name"))).toBe(false);
  });

  test("refuses an existing target and leaves the original untouched", async () => {
    const root = makeTemp();
    const skillDir = writeFile(root, "demo/SKILL.md", "---\nname: demo\ndescription: original\n---\n");
    const before = readFileSync(skillDir, "utf8");
    const result = await scaffoldSkill(root, "demo", "trying to shadow");
    expect(result.ok).toBe(false);
    expect(result.path).toBe(path.join(root, "demo"));
    expect(readFileSync(skillDir, "utf8")).toBe(before);
  });

  test("creates a missing root and writes under it", async () => {
    const parent = makeTemp();
    const root = path.join(parent, "deep", "skills");
    const result = await scaffoldSkill(root, "demo", "A demo skill.");
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(root, "demo", "SKILL.md"))).toBe(true);
  });

  test("refuses a root that is a file and a non-absolute root", async () => {
    const parent = makeTemp();
    const fileRoot = writeFile(parent, "not-a-dir", "x");
    expect((await scaffoldSkill(fileRoot, "demo", "d")).ok).toBe(false);
    expect((await scaffoldSkill("relative/root", "demo", "d")).ok).toBe(false);
  });
});

// ── edit frontmatter ────────────────────────────────────────────────────────

describe("editSkillFrontmatter", () => {
  test("surgically edits one field, preserving comments, nested maps, and body", async () => {
    const root = makeTemp();
    const skillMd = writeFile(
      root,
      "demo/SKILL.md",
      [
        "---",
        "# a comment kone must keep",
        "name: demo",
        "metadata:",
        "  nested: yes",
        "description: Old description.",
        "license: MIT",
        "---",
        "",
        "# body keeps every byte",
        "some markdown",
        "",
      ].join("\n"),
    );
    const before = readFileSync(skillMd, "utf8");
    const result = await editSkillFrontmatter(skillMd, [{ op: "set", key: "description", value: "New description." }]);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(skillMd);
    expect(readFileSync(skillMd, "utf8")).toBe(before.replace("description: Old description.", "description: New description."));
  });

  test("a name edit must match the folder name", async () => {
    const root = makeTemp();
    const skillMd = writeFile(root, "demo/SKILL.md", skillMarkdown("demo"));
    const mismatch = await editSkillFrontmatter(skillMd, [{ op: "set", key: "name", value: "other" }]);
    expect(mismatch.ok).toBe(false);
    expect(readFileSync(skillMd, "utf8")).toBe(skillMarkdown("demo"));
    const match = await editSkillFrontmatter(skillMd, [{ op: "set", key: "name", value: "demo" }]);
    expect(match.ok).toBe(true);
  });

  test("deleting the name field is refused", async () => {
    const root = makeTemp();
    const skillMd = writeFile(root, "demo/SKILL.md", skillMarkdown("demo"));
    const result = await editSkillFrontmatter(skillMd, [{ op: "delete", key: "name" }]);
    expect(result.ok).toBe(false);
  });

  test("deleting a nested-map field removes it cleanly", async () => {
    const root = makeTemp();
    const skillMd = writeFile(root, "demo/SKILL.md", skillMarkdown("demo", "metadata:\n  nested: yes\n"));
    const result = await editSkillFrontmatter(skillMd, [{ op: "delete", key: "metadata" }]);
    expect(result.ok).toBe(true);
    expect(readFileSync(skillMd, "utf8")).toBe(skillMarkdown("demo"));
  });

  test("refuses a description over 1024 characters", async () => {
    const root = makeTemp();
    const skillMd = writeFile(root, "demo/SKILL.md", skillMarkdown("demo"));
    const result = await editSkillFrontmatter(skillMd, [{ op: "set", key: "description", value: "x".repeat(1025) }]);
    expect(result.ok).toBe(false);
  });

  test("refuses plugin-owned paths, bad paths, and missing files", async () => {
    const root = makeTemp();
    const pluginMd = writeFile(root, ".claude/plugins/cache/p/v1/skill/SKILL.md", skillMarkdown("skill"));
    const plugin = await editSkillFrontmatter(pluginMd, [{ op: "set", key: "description", value: "x" }]);
    expect(plugin.ok).toBe(false);
    expect(plugin.detail).toContain("plugin");

    expect((await editSkillFrontmatter("relative/SKILL.md", [{ op: "set", key: "description", value: "x" }])).ok).toBe(false);
    expect((await editSkillFrontmatter(path.join(root, "demo", "SKILL.txt"), [{ op: "set", key: "description", value: "x" }])).ok).toBe(false);
    expect((await editSkillFrontmatter(path.join(root, "nope", "SKILL.md"), [{ op: "set", key: "description", value: "x" }])).ok).toBe(false);
  });

  test("refuses a file over the byte cap", async () => {
    const root = makeTemp();
    const skillMd = writeFile(root, "demo/SKILL.md", "---\nname: demo\n---\n" + "x".repeat(300 * 1024));
    const result = await editSkillFrontmatter(skillMd, [{ op: "set", key: "description", value: "x" }]);
    expect(result.ok).toBe(false);
  });
});

// ── delete to trash ─────────────────────────────────────────────────────────

describe("deleteSkillToTrash", () => {
  test("moves the folder into the trash with its contents intact", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    writeFile(root, "demo/SKILL.md", skillMarkdown("demo"));
    writeFile(root, "demo/scripts/run.sh", "#!/bin/sh\n");

    const result = await deleteSkillToTrash(path.join(root, "demo"), trash);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(root, "demo"))).toBe(false);
    expect(readFileSync(path.join(trash, "demo", "SKILL.md"), "utf8")).toBe(skillMarkdown("demo"));
    expect(existsSync(path.join(trash, "demo", "scripts", "run.sh"))).toBe(true);
  });

  test("collisions get a numeric suffix instead of overwriting trash contents", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    writeFile(root, "demo/SKILL.md", skillMarkdown("demo"));
    writeFile(trash, "demo/SKILL.md", "older trip\n");

    const result = await deleteSkillToTrash(path.join(root, "demo"), trash);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(trash, "demo", "SKILL.md"), "utf8")).toBe("older trip\n");
    expect(readFileSync(path.join(trash, "demo 2", "SKILL.md"), "utf8")).toBe(skillMarkdown("demo"));
  });

  test("refuses plugin-owned paths", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    const pluginDir = path.join(root, ".claude", "plugins", "cache", "p", "v1", "skill");
    writeFile(pluginDir, "SKILL.md", skillMarkdown("skill"));
    const result = await deleteSkillToTrash(pluginDir, trash);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("plugin");
    expect(existsSync(pluginDir)).toBe(true);
  });

  test("refuses missing paths, plain files, and relative paths", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    expect((await deleteSkillToTrash(path.join(root, "nope"), trash)).ok).toBe(false);
    const file = writeFile(root, "just-a-file", "x");
    expect((await deleteSkillToTrash(file, trash)).ok).toBe(false);
    expect((await deleteSkillToTrash("relative/dir", trash)).ok).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

// ── install from git ────────────────────────────────────────────────────────

describe("installSkillFromGit", () => {
  test("clones a skill repo, keeps its git history, and writes the source manifest", async () => {
    const root = makeTemp();
    const repo = path.join(makeTemp("kone-src-"), "demo-skill");
    makeGitRepo(repo, { "SKILL.md": skillMarkdown("demo-skill") });

    const result = await installSkillFromGit(repo, root);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("install");
    const dir = result.path!;
    expect(dir).toBe(path.join(root, "demo-skill"));
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(skillMarkdown("demo-skill"));
    expect(existsSync(path.join(dir, ".git"))).toBe(true);

    const manifest = JSON.parse(readFileSync(path.join(dir, SOURCE_MANIFEST_FILENAME), "utf8"));
    expect(manifest.source).toBe("git");
    expect(manifest.url).toBe(repo);
    expect(typeof manifest.installedAt).toBe("string");
  });

  test("renames the clone when the frontmatter name does not match the repo folder", async () => {
    const root = makeTemp();
    const repo = path.join(makeTemp("kone-src-"), "weird-repo-name");
    makeGitRepo(repo, { "SKILL.md": skillMarkdown("nice-skill") });

    const result = await installSkillFromGit(repo, root);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(root, "nice-skill"));
    expect(existsSync(path.join(root, "weird-repo-name"))).toBe(false);
    expect(existsSync(path.join(root, "nice-skill", SOURCE_MANIFEST_FILENAME))).toBe(true);
    expect(result.detail).toContain("renamed");
  });

  test("a repo without a root SKILL.md is refused and the clone is parked in the trash", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    const repo = path.join(makeTemp("kone-src-"), "no-skill");
    makeGitRepo(repo, { "README.md": "# not a skill\n" });

    const result = await installSkillFromGit(repo, root, { trashDir: trash });
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(root, "no-skill"))).toBe(false);
    expect(existsSync(path.join(trash, "no-skill", "README.md"))).toBe(true);
  });

  test("a plugin-shaped repo is refused and handed off, not installed as a skill", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    const repo = path.join(makeTemp("kone-src-"), "plugin-repo");
    makeGitRepo(repo, {
      "SKILL.md": skillMarkdown("plugin-repo"),
      ".claude-plugin/plugin.json": "{}\n",
    });

    const result = await installSkillFromGit(repo, root, { trashDir: trash });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("plugin");
    expect(existsSync(path.join(root, "plugin-repo"))).toBe(false);
    expect(existsSync(path.join(trash, "plugin-repo", "SKILL.md"))).toBe(true);
  });

  test("a repo whose frontmatter name is missing or invalid is refused", async () => {
    const root = makeTemp();
    const trash = makeTemp("kone-trash-");
    const repo = path.join(makeTemp("kone-src-"), "bad-name");
    makeGitRepo(repo, { "SKILL.md": "---\ndescription: no name here\n---\n" });

    const result = await installSkillFromGit(repo, root, { trashDir: trash });
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(root, "bad-name"))).toBe(false);
  });

  test("refuses non-git sources and existing destinations", async () => {
    const root = makeTemp();
    expect((await installSkillFromGit("not a url!!", root)).ok).toBe(false);
    expect((await installSkillFromGit("ftp://example.com/repo.git", root)).ok).toBe(false);
    expect((await installSkillFromGit("github.com/owner/repo", root)).ok).toBe(false);

    const repo = path.join(makeTemp("kone-src-"), "demo-skill");
    makeGitRepo(repo, { "SKILL.md": skillMarkdown("demo-skill") });
    mkdirSync(path.join(root, "demo-skill"));
    const result = await installSkillFromGit(repo, root);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("already exists");
  });
});
