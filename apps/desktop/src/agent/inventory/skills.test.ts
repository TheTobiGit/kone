import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverSkills } from "./skills.js";

// discoverSkills reads the REAL homedir for the user-scope roots, so every
// fixture lives in a temp project tree and each skill name derives from its
// tmpdir basename — a random string a real ~/.claude/skills copy can't share,
// which keeps a user's actual skills from shadowing the fixture's winner.

function makeProject(): string {
  return mkdtempSync(path.join(tmpdir(), "kone-skills-"));
}

function writeSkill(skillDir: string, frontmatter: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`);
}

async function findSkill(name: string, projectPath: string) {
  const { skills } = await discoverSkills(projectPath);
  return skills.find((s) => s.name === name) ?? null;
}

describe("discoverSkills shadowing", () => {
  test("two project copies of one name collapse to one entry naming the loser", async () => {
    const project = makeProject();
    const name = `dup-${path.basename(project)}`;
    writeSkill(path.join(project, ".claude", "skills", name), `name: ${name}`);
    writeSkill(path.join(project, ".codex", "skills", name), `name: ${name}`);

    const { skills } = await discoverSkills(project);
    const matches = skills.filter((s) => s.name === name);
    expect(matches).toHaveLength(1);
    const winner = matches[0]!;
    expect(winner.origin).toBe("claude");
    expect(winner.path).toBe(path.join(project, ".claude", "skills", name, "SKILL.md"));
    expect(winner.shadowedBy).toEqual([
      {
        origin: "codex",
        scope: "project",
        path: path.join(project, ".codex", "skills", name, "SKILL.md"),
      },
    ]);
  });

  test("a loser from a higher ancestor is recorded with its own path", async () => {
    const root = makeProject();
    const project = path.join(root, "nested", "app");
    const name = `nested-${path.basename(root)}`;
    writeSkill(path.join(project, ".codex", "skills", name), `name: ${name}`);
    writeSkill(path.join(root, ".claude", "skills", name), `name: ${name}`);

    // The project's own copy is scanned first (nearest ancestor first), so it
    // wins even though the monorepo root's .claude copy is the "more natural"
    // home — the loser is still named, at the ancestor's real path.
    const { skills } = await discoverSkills(project);
    const matches = skills.filter((s) => s.name === name);
    expect(matches).toHaveLength(1);
    const winner = matches[0]!;
    expect(winner.path).toBe(path.join(project, ".codex", "skills", name, "SKILL.md"));
    expect(winner.shadowedBy).toEqual([
      {
        origin: "claude",
        scope: "project",
        path: path.join(root, ".claude", "skills", name, "SKILL.md"),
      },
    ]);
  });

  test("a unique skill reports an empty shadowedBy", async () => {
    const project = makeProject();
    const name = `only-${path.basename(project)}`;
    writeSkill(path.join(project, ".claude", "skills", name), `name: ${name}`);

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.shadowedBy).toEqual([]);
  });

  test("shadowedBy caps at 8 entries, nearest losers first", async () => {
    const root = makeProject();
    const project = path.join(root, "a", "b");
    const name = `cap-${path.basename(root)}`;
    // Three ancestor levels × five CLI origins = fifteen copies of one name;
    // the first copy (b/.claude) wins and records eight losers before the cap.
    for (const ancestor of [project, path.join(root, "a"), root]) {
      for (const origin of ["claude", "opencode", "cursor", "codex", "agents"]) {
        writeSkill(path.join(ancestor, `.${origin}`, "skills", name), `name: ${name}`);
      }
    }

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.shadowedBy).toHaveLength(8);
    expect(winner.shadowedBy[0]).toEqual({
      origin: "opencode",
      scope: "project",
      path: path.join(project, ".opencode", "skills", name, "SKILL.md"),
    });
    expect(winner.shadowedBy[7]).toEqual({
      origin: "codex",
      scope: "project",
      path: path.join(root, "a", ".codex", "skills", name, "SKILL.md"),
    });
  });
});

describe("discoverSkills manualOnly", () => {
  test("is true only when a disable-model-invocation alias is literally true", async () => {
    const project = makeProject();
    const prefix = `mo-${path.basename(project)}`;
    const cases = [
      { key: "absent", fm: "" },
      { key: "kebab-true", fm: "disable-model-invocation: true" },
      { key: "kebab-upper", fm: "disable-model-invocation: TRUE" },
      { key: "camel-true", fm: "disableModelInvocation: true" },
      { key: "kebab-false", fm: "disable-model-invocation: false" },
      { key: "kebab-yes", fm: "disable-model-invocation: yes" },
    ] as const;
    for (const { key, fm } of cases) {
      writeSkill(path.join(project, ".claude", "skills", `${prefix}-${key}`), `${fm}\nname: ${prefix}-${key}`);
    }

    const expected: Record<string, boolean> = {
      absent: false,
      "kebab-true": true,
      "kebab-upper": true,
      "camel-true": true,
      "kebab-false": false,
      "kebab-yes": false,
    };
    const { skills } = await discoverSkills(project);
    for (const { key } of cases) {
      const entry = skills.find((s) => s.name === `${prefix}-${key}`);
      expect(entry).not.toBeNull();
      expect(entry?.manualOnly).toBe(expected[key]);
    }
  });
});
