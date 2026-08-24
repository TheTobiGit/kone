import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { lintSkillAt, signalsForSkillAt } from "./skillInspect.js";

function makeSkillDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kone-skill-inspect-"));
}

describe("lintSkillAt", () => {
  // The rules themselves are skillLint's own tests; what matters here is that
  // the file reaches them intact — a well-formed skill raises nothing at error
  // severity, and every finding arrives as a sentence.
  test("raises no errors for a well-formed skill", async () => {
    const dir = makeSkillDir();
    const skillDir = path.join(dir, "tidy-skill");
    mkdirSync(skillDir);
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: tidy-skill\ndescription: Tidies a thing when the user asks to tidy a thing.\n---\n# Tidy\n\nSteps.\n",
    );

    const findings = await lintSkillAt(path.join(skillDir, "SKILL.md"));
    expect(findings.some((f) => f.severity === "error")).toBe(false);
    expect(findings.every((f) => f.message.trim().endsWith("."))).toBe(true);
  });

  test("reports a name that disagrees with the folder it sits in", async () => {
    const dir = makeSkillDir();
    const skillDir = path.join(dir, "on-disk-name");
    mkdirSync(skillDir);
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: frontmatter-name\ndescription: Does a thing when a thing needs doing.\n---\n# Body\n",
    );

    const findings = await lintSkillAt(path.join(skillDir, "SKILL.md"));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => Boolean(f.message && f.message.length > 0))).toBe(true);
  });

  test("yields no findings for a path that is not a readable SKILL.md", async () => {
    const dir = makeSkillDir();
    expect(await lintSkillAt(path.join(dir, "SKILL.md"))).toEqual([]);
    expect(await lintSkillAt(path.join(dir, "README.md"))).toEqual([]);
    expect(await lintSkillAt("relative/SKILL.md")).toEqual([]);
  });
});

describe("signalsForSkillAt", () => {
  test("counts the listing cost from frontmatter", async () => {
    const dir = makeSkillDir();
    const skillDir = path.join(dir, "costed");
    mkdirSync(skillDir);
    const description = "Runs the report.";
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: costed\ndescription: ${description}\n---\n# Costed\n`,
    );

    const signals = await signalsForSkillAt(path.join(skillDir, "SKILL.md"), {
      origin: "claude",
      scope: "user",
    });
    expect(signals).not.toBeNull();
    if (!signals) return;
    expect(signals.cost.descriptionChars).toBe(description.length);
    expect(signals.cost.overSpecCap).toBe(false);
    expect(signals.limitation.length).toBeGreaterThan(0);
  });

  test("passes the executable bit through to the signals", async () => {
    const dir = makeSkillDir();
    const skillDir = path.join(dir, "with-script");
    mkdirSync(skillDir);
    const script = path.join(skillDir, "run.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    chmodSync(script, 0o755);
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: with-script\ndescription: Runs a bundled script when asked.\n---\n# Run\n\nRun ./run.sh.\n",
    );

    const signals = await signalsForSkillAt(path.join(skillDir, "SKILL.md"), {
      origin: "claude",
      scope: "user",
    });
    expect(signals).not.toBeNull();
    if (!signals) return;
    expect(signals.security.some((s) => s.id.includes("executable") || s.id.includes("script"))).toBe(
      true,
    );
  });

  test("resolves to null for a path that cannot be read", async () => {
    const dir = makeSkillDir();
    expect(await signalsForSkillAt(path.join(dir, "SKILL.md"), { origin: "claude", scope: "user" }))
      .toBeNull();
  });
});
