import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readSkillDetail } from "./skillDetail.js";
import { MAX_FILE_BYTES } from "./skills.js";

// The renderer-facing byte cap, reused from the scan so both reads refuse the
// same files.
const MAX_BODY_CHARS = 20_000;

function makeSkillDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kone-skill-detail-"));
}

describe("readSkillDetail", () => {
  test("reads frontmatter, body, and resources for a SKILL.md", async () => {
    const dir = makeSkillDir();
    mkdirSync(path.join(dir, "scripts"));
    writeFileSync(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\n");
    writeFileSync(path.join(dir, "README.md"), "# Readme\n");
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\ndescription: Do the thing.\nname: demo\n---\n# Demo\n\nBody prose.\n",
    );

    const detail = await readSkillDetail(path.join(dir, "SKILL.md"));
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.path).toBe(path.join(dir, "SKILL.md"));
    expect(detail.directory).toBe(dir);
    expect(detail.bytes).toBeGreaterThan(0);
    expect(detail.modifiedAt).toBeGreaterThan(0);
    expect(detail.frontmatter).toEqual({ description: "Do the thing.", name: "demo" });
    expect(detail.body).toBe("# Demo\n\nBody prose.");
    expect(detail.bodyTruncated).toBe(false);
    // Directories sort before files, each alphabetically.
    expect(detail.resources).toEqual([
      { name: "scripts", kind: "directory" },
      { name: "README.md", kind: "file" },
    ]);
  });

  test("classifies a symlinked resource by its target", async () => {
    const dir = makeSkillDir();
    mkdirSync(path.join(dir, "real"));
    writeFileSync(path.join(dir, "real", "tool.js"), "// tool\n");
    symlinkSync(path.join(dir, "real"), path.join(dir, "linked-dir"));
    symlinkSync(path.join(dir, "real", "tool.js"), path.join(dir, "linked-file.js"));
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo\n---\nbody\n");

    const detail = await readSkillDetail(path.join(dir, "SKILL.md"));
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.resources).toEqual([
      { name: "linked-dir", kind: "directory" },
      { name: "real", kind: "directory" },
      { name: "linked-file.js", kind: "file" },
    ]);
  });

  test("refuses a path whose basename is not SKILL.md", async () => {
    const dir = makeSkillDir();
    writeFileSync(path.join(dir, "README.md"), "# hi\n");
    expect(await readSkillDetail(path.join(dir, "README.md"))).toBeNull();
  });

  test("refuses a relative path", async () => {
    expect(await readSkillDetail("some/dir/SKILL.md")).toBeNull();
  });

  test("refuses a file over the byte cap", async () => {
    const dir = makeSkillDir();
    writeFileSync(path.join(dir, "SKILL.md"), "x".repeat(MAX_FILE_BYTES + 1));
    expect(await readSkillDetail(path.join(dir, "SKILL.md"))).toBeNull();
  });

  test("returns null for a missing SKILL.md", async () => {
    const dir = makeSkillDir();
    expect(await readSkillDetail(path.join(dir, "SKILL.md"))).toBeNull();
  });

  test("caps the body at the char limit and marks it truncated", async () => {
    const dir = makeSkillDir();
    const body = "y".repeat(MAX_BODY_CHARS + 5_000);
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: big\n---\n${body}\n`);

    const detail = await readSkillDetail(path.join(dir, "SKILL.md"));
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.body).toHaveLength(MAX_BODY_CHARS);
    expect(detail.bodyTruncated).toBe(true);
    expect(detail.body).toBe("y".repeat(MAX_BODY_CHARS));
  });

  test("excludes SKILL.md itself and dotfiles from resources", async () => {
    const dir = makeSkillDir();
    writeFileSync(path.join(dir, "SKILL.md"), "# demo\n");
    writeFileSync(path.join(dir, "README.md"), "# readme\n");
    writeFileSync(path.join(dir, ".hidden"), "nope\n");
    writeFileSync(path.join(dir, ".DS_Store"), "");

    const detail = await readSkillDetail(path.join(dir, "SKILL.md"));
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.resources).toEqual([{ name: "README.md", kind: "file" }]);
  });
});
