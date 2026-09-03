import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverSkills, skillRootTargets } from "./skills.js";

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
    writeSkill(path.join(project, ".agents", "skills", name), `name: ${name}`);

    const { skills } = await discoverSkills(project);
    const matches = skills.filter((s) => s.name === name);
    expect(matches).toHaveLength(1);
    const winner = matches[0]!;
    expect(winner.origin).toBe("claude");
    expect(winner.enabled).toBe(true);
    expect(winner.path).toBe(path.join(project, ".claude", "skills", name, "SKILL.md"));
    expect(winner.shadowedBy).toEqual([
      {
        origin: "agents",
        scope: "project",
        path: path.join(project, ".agents", "skills", name, "SKILL.md"),
      },
    ]);
  });

  test("v1 stable: only current project scanned, ancestor copy not shadowed", async () => {
    const root = makeProject();
    const project = path.join(root, "nested", "app");
    const name = `nested-${path.basename(root)}`;
    writeSkill(path.join(project, ".agents", "skills", name), `name: ${name}`);
    writeSkill(path.join(root, ".claude", "skills", name), `name: ${name}`);

    // v1 stable MAX_PROJECT_ANCESTORS=1 — only the given project dir scanned.
    const { skills } = await discoverSkills(project);
    const matches = skills.filter((s) => s.name === name);
    expect(matches).toHaveLength(1);
    const winner = matches[0]!;
    expect(winner.path).toBe(path.join(project, ".agents", "skills", name, "SKILL.md"));
    expect(winner.shadowedBy).toEqual([]);
  });

  test("a unique skill reports an empty shadowedBy", async () => {
    const project = makeProject();
    const name = `only-${path.basename(project)}`;
    writeSkill(path.join(project, ".claude", "skills", name), `name: ${name}`);

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.shadowedBy).toEqual([]);
    expect(winner.enabled).toBe(true);
  });

  test("shadowedBy caps at 8 entries (v1: max 1 loser for claude+agents)", async () => {
    const project = makeProject();
    const name = `cap-${path.basename(project)}`;
    // v1 stable: 1 ancestor × 2 origins = 2 copies; dedupe yields 1 winner + 1 loser.
    writeSkill(path.join(project, ".claude", "skills", name), `name: ${name}`);
    writeSkill(path.join(project, ".agents", "skills", name), `name: ${name}`);

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.shadowedBy).toHaveLength(1);
    expect(winner.shadowedBy[0]).toEqual({
      origin: "agents",
      scope: "project",
      path: path.join(project, ".agents", "skills", name, "SKILL.md"),
    });
  });
});

describe("discoverSkills author", () => {
  test("reads a top-level author field", async () => {
    const project = makeProject();
    const name = `auth-top-${path.basename(project)}`;
    writeSkill(
      path.join(project, ".claude", "skills", name),
      `name: ${name}\nauthor: Jane Doe`,
    );

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.author).toBe("Jane Doe");
  });

  test("reads a literal metadata.author field", async () => {
    const project = makeProject();
    const name = `auth-dot-${path.basename(project)}`;
    writeSkill(
      path.join(project, ".claude", "skills", name),
      `name: ${name}\nmetadata.author: Jane Doe`,
    );

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.author).toBe("Jane Doe");
  });

  test("reads an author nested under metadata", async () => {
    const project = makeProject();
    const name = `auth-nested-${path.basename(project)}`;
    writeSkill(
      path.join(project, ".claude", "skills", name),
      `name: ${name}\nmetadata:\n  author: Jane Doe`,
    );

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.author).toBe("Jane Doe");
  });

  test("reads an author inline in the metadata value", async () => {
    const project = makeProject();
    const name = `auth-inline-${path.basename(project)}`;
    writeSkill(
      path.join(project, ".claude", "skills", name),
      `name: ${name}\nmetadata: author: Jane Doe, source: https://example.com/skills`,
    );

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.author).toBe("Jane Doe");
  });

  test("is null when no author is credited", async () => {
    const project = makeProject();
    const name = `auth-none-${path.basename(project)}`;
    writeSkill(path.join(project, ".claude", "skills", name), `name: ${name}`);

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.author).toBeNull();
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

    const expected = {
      absent: false,
      "kebab-true": true,
      "kebab-upper": true,
      "camel-true": true,
      "kebab-false": false,
      "kebab-yes": false,
    } satisfies Record<string, boolean>;
    const { skills } = await discoverSkills(project);
    for (const { key } of cases) {
      const entry = skills.find((s) => s.name === `${prefix}-${key}`);
      expect(entry).not.toBeNull();
      expect(entry?.manualOnly).toBe(expected[key]);
    }
  });
});

describe("discoverSkills agents", () => {
  test("discovers skills from project .agents/skills", async () => {
    const project = makeProject();
    const name = `agents-proj-${path.basename(project)}`;
    writeSkill(
      path.join(project, ".agents", "skills", name),
      `name: ${name}\ndescription: Agents project skill\ndisplay-name: Agents Test`,
    );

    const winner = await findSkill(name, project);
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(winner.origin).toBe("agents");
    expect(winner.scope).toBe("project");
    expect(winner.description).toBe("Agents project skill");
    expect(winner.displayName).toBe("Agents Test");
    expect(winner.enabled).toBe(true);
  });
});

describe("skillRootTargets", () => {
  test("offers one folder per CLI, marking the ones that exist", async () => {
    const project = makeProject();
    mkdirSync(path.join(project, ".claude", "skills"), { recursive: true });

    const targets = await skillRootTargets(project);
    const projectTargets = targets.filter((t) => t.scope === "project");

    // v1: all providers we offer — claude/codex/cursor/opencode/agents/factory
    const origins = projectTargets.map((t) => t.origin);
    expect(new Set(origins).size).toBe(origins.length);
    expect(origins).toEqual(expect.arrayContaining(["claude", "codex", "cursor", "opencode", "agents", "factory"]));
    expect(origins).toHaveLength(6);

    const claude = projectTargets.find((t) => t.origin === "claude");
    expect(claude?.dir).toBe(path.join(project, ".claude", "skills"));
    expect(claude?.exists).toBe(true);
    expect(projectTargets.find((t) => t.origin === "agents")?.exists).toBe(false);

    // Only this project's own folders: an ancestor several levels up is not
    // what someone adding a skill here means.
    for (const target of projectTargets) {
      expect(path.dirname(path.dirname(target.dir))).toBe(project);
    }
  });

  test("user folders are offered with no project at all, and come first", async () => {
    const targets = await skillRootTargets(null);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.scope === "user")).toBe(true);
    // v1: all global roots
    const origins = targets.map((t) => t.origin);
    expect(new Set(origins).size).toBe(origins.length);
    expect(origins).toEqual(expect.arrayContaining(["claude", "codex", "cursor", "opencode", "agents", "factory"]));
  });
});
