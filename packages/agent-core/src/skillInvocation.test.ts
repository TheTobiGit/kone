import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SkillEntry } from "./inventory/types.js";
import type { SkillStateContext, SkillStateResult } from "./inventory/skillState.js";
import { ProviderKindSchema, SkillReferenceListSchema } from "./types.js";
import {
  MAX_INLINE_SKILL_CHARS,
  SkillUnavailableError,
  buildSkillPrompt,
  inlineSkills,
  isNativeSkillFor,
  listInvokableSkills,
  listInvokableSkillsChecked,
  resolveSkillReferences,
  type InvokableSkillDeps,
} from "./skillInvocation.js";

const HOME = "/home/u";
const PROJECT = "/work/app";

function entry(name: string, skillPath: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: null,
    path: skillPath,
    directory: path.dirname(skillPath),
    origin: "claude",
    scope: "user",
    displayName: null,
    shortDescription: null,
    author: null,
    modifiedAt: 0,
    shadowedBy: [],
    manualOnly: false,
    enabled: true,
    ...overrides,
  };
}

const claudeReview = entry("review", `${HOME}/.claude/skills/review/SKILL.md`, { origin: "claude" });
const agentsReview = entry("review", `${HOME}/.agents/skills/review/SKILL.md`, { origin: "agents" });
const projectLint = entry("lint", `${PROJECT}/.claude/skills/lint/SKILL.md`, { origin: "claude", scope: "project" });
const codexDeploy = entry("Deploy", `${HOME}/.codex/skills/deploy/SKILL.md`, { origin: "codex" });

const enabledState: SkillStateResult = { state: "enabled", reason: null, source: null };

function deps(input: {
  skills: SkillEntry[];
  shadowed?: SkillEntry[];
  disabled?: string[];
  stateFor?: (context: SkillStateContext) => SkillStateResult["state"];
}): InvokableSkillDeps {
  return {
    discover: async () => ({ skills: input.skills, shadowed: input.shadowed ?? [] }),
    readState: async (context) => ({ ...enabledState, state: input.stateFor?.(context) ?? "enabled" }),
    internalSettings: () => ({ disabled: input.disabled ?? [], disabledPlugins: [] }),
  };
}

describe("isNativeSkillFor", () => {
  test("Claude Code loads only .claude/skills; Codex loads .codex and .agents", () => {
    expect(isNativeSkillFor("claudeAgent", claudeReview.path)).toBe(true);
    expect(isNativeSkillFor("claudeAgent", agentsReview.path)).toBe(false);
    expect(isNativeSkillFor("codex", agentsReview.path)).toBe(true);
    expect(isNativeSkillFor("codex", codexDeploy.path)).toBe(true);
    expect(isNativeSkillFor("codex", claudeReview.path)).toBe(false);
  });

  test("a .claude directory that is not the skills root is not native", () => {
    expect(isNativeSkillFor("claudeAgent", `${HOME}/.claude/plugins/cache/x/skills/a/SKILL.md`)).toBe(false);
  });

  test("providers without a skill input have no native roots", () => {
    for (const provider of ["opencode", "cursor", "cline", "droid", "antigravity"] as const) {
      expect(isNativeSkillFor(provider, claudeReview.path)).toBe(false);
    }
  });
});

describe("listInvokableSkills", () => {
  test("one copy per name, sorted, with the provider's native copy winning a collision", async () => {
    const forClaude = await listInvokableSkills(
      "claudeAgent",
      PROJECT,
      deps({ skills: [agentsReview, projectLint], shadowed: [claudeReview] }),
    );
    expect(forClaude.map((s) => [s.name, s.path])).toEqual([
      ["lint", projectLint.path],
      ["review", claudeReview.path],
    ]);

    const forCodex = await listInvokableSkills(
      "codex",
      PROJECT,
      deps({ skills: [claudeReview], shadowed: [agentsReview] }),
    );
    expect(forCodex.map((s) => s.path)).toEqual([agentsReview.path]);
  });

  test("user scope beats project scope when neither copy is native", async () => {
    const userCopy = entry("fmt", `${HOME}/.cursor/skills/fmt/SKILL.md`, { origin: "cursor" });
    const projectCopy = entry("fmt", `${PROJECT}/.cursor/skills/fmt/SKILL.md`, { origin: "cursor", scope: "project" });
    const listed = await listInvokableSkills("opencode", PROJECT, deps({ skills: [projectCopy], shadowed: [userCopy] }));
    expect(listed.map((s) => s.path)).toEqual([userCopy.path]);
  });

  test("kone's internal gate hides a skill by path or by name", async () => {
    const byPath = await listInvokableSkills(
      "claudeAgent",
      PROJECT,
      deps({ skills: [claudeReview, projectLint], disabled: [claudeReview.path] }),
    );
    expect(byPath.map((s) => s.name)).toEqual(["lint"]);
    const byName = await listInvokableSkills("claudeAgent", PROJECT, deps({ skills: [claudeReview], disabled: ["REVIEW"] }));
    expect(byName).toEqual([]);
  });

  test("a skill the provider's own config disables is hidden, checked under both origins", async () => {
    const seen: string[] = [];
    const listed = await listInvokableSkills(
      "codex",
      PROJECT,
      deps({
        skills: [claudeReview, codexDeploy],
        stateFor: (context) => {
          seen.push(`${context.origin}:${context.skillName}`);
          return context.origin === "codex" && context.skillName === "review" ? "disabled" : "enabled";
        },
      }),
    );
    expect(listed.map((s) => s.name)).toEqual(["Deploy"]);
    expect(seen).toContain("claude:review");
    expect(seen).toContain("codex:review");
  });

  test("a disabled copy falls through to an enabled copy of the same name", async () => {
    const listed = await listInvokableSkills(
      "claudeAgent",
      PROJECT,
      deps({
        skills: [claudeReview],
        shadowed: [agentsReview],
        stateFor: (context) => (context.skillPath === claudeReview.path ? "disabled" : "enabled"),
      }),
    );
    expect(listed.map((s) => s.path)).toEqual([agentsReview.path]);
  });

  test("name-only and user-invocable-only skills can still be invoked by the user", async () => {
    const listed = await listInvokableSkills(
      "claudeAgent",
      PROJECT,
      deps({ skills: [claudeReview, projectLint], stateFor: (c) => (c.skillName === "lint" ? "name-only" : "user-invocable-only") }),
    );
    expect(listed).toHaveLength(2);
  });

  test("never rejects: a failing scan or state read lists what it can", async () => {
    const failingScan = await listInvokableSkills("claudeAgent", PROJECT, {
      ...deps({ skills: [] }),
      discover: async () => {
        throw new Error("EACCES");
      },
    });
    expect(failingScan).toEqual([]);
    const failingState = await listInvokableSkills("claudeAgent", PROJECT, {
      ...deps({ skills: [claudeReview] }),
      readState: async () => {
        throw new Error("bad toml");
      },
    });
    expect(failingState.map((s) => s.name)).toEqual(["review"]);
  });

  test("the returned rows carry only picker fields, never inventory state", async () => {
    const [listed] = await listInvokableSkills(
      "claudeAgent",
      PROJECT,
      deps({ skills: [], shadowed: [{ ...claudeReview, shadowed: true, enabled: false }] }),
    );
    expect(listed).toEqual({
      name: claudeReview.name,
      path: claudeReview.path,
      description: claudeReview.description,
      shortDescription: claudeReview.shortDescription,
      scope: claudeReview.scope,
      origin: claudeReview.origin,
    });
    expect(listed).not.toHaveProperty("enabled");
    expect(listed).not.toHaveProperty("shadowed");
  });
});

describe("listInvokableSkillsChecked", () => {
  test("an unknown provider, a relative cwd or a non-string lists nothing", async () => {
    expect(await listInvokableSkillsChecked("gpt", null)).toEqual([]);
    expect(await listInvokableSkillsChecked("claudeAgent", "relative/dir")).toEqual([]);
    // SAFETY: values an IPC sender could put where the declared types promise
    // strings; the check must hold at runtime, not only in the signature.
    expect(await listInvokableSkillsChecked("claudeAgent", 42 as never)).toEqual([]);
    // SAFETY: as above — an object where a provider string is declared.
    expect(await listInvokableSkillsChecked({ provider: "codex" } as never, null)).toEqual([]);
  });
});

describe("shared schemas", () => {
  test("the shared provider schema accepts every known provider and nothing else", () => {
    for (const provider of ["codex", "claudeAgent", "opencode", "cursor", "droid", "cline", "antigravity"]) {
      expect(ProviderKindSchema.safeParse(provider).success).toBe(true);
    }
    expect(ProviderKindSchema.safeParse("gpt").success).toBe(false);
  });

  test("the shared skill list schema stays permissive; strictness lives at the call sites", () => {
    expect(SkillReferenceListSchema.safeParse([]).success).toBe(true);
    expect(SkillReferenceListSchema.safeParse([{ name: "", path: "" }]).success).toBe(true);
  });
});

describe("resolveSkillReferences", () => {
  const available = deps({ skills: [claudeReview, projectLint, codexDeploy] });

  test("no references resolve to none", async () => {
    expect(await resolveSkillReferences("claudeAgent", PROJECT, undefined, available)).toEqual([]);
    expect(await resolveSkillReferences("claudeAgent", PROJECT, [], available)).toEqual([]);
  });

  test("matches by exact path first, then by name case-insensitively, returning the listed copy", async () => {
    const resolved = await resolveSkillReferences(
      "claudeAgent",
      PROJECT,
      [
        { name: "whatever", path: projectLint.path },
        { name: "deploy", path: "/elsewhere/deploy/SKILL.md" },
      ],
      available,
    );
    expect(resolved).toEqual([
      { name: "lint", path: projectLint.path },
      { name: "Deploy", path: codexDeploy.path },
    ]);
  });

  test("the same skill named twice is invoked once", async () => {
    const resolved = await resolveSkillReferences(
      "claudeAgent",
      PROJECT,
      [
        { name: "review", path: claudeReview.path },
        { name: "REVIEW", path: claudeReview.path },
      ],
      available,
    );
    expect(resolved).toHaveLength(1);
  });

  test("malformed references reject with a sentence", async () => {
    const cases: unknown[] = [
      [{ name: "", path: claudeReview.path }],
      [{ name: "review", path: "skills/review/SKILL.md" }],
      [{ name: "review", path: `${HOME}/.claude/skills/review/README.md` }],
      [{ name: "review" }],
      ["review"],
    ];
    for (const refs of cases) {
      // SAFETY: deliberately malformed input, standing in for what an IPC
      // caller could send; resolveSkillReferences must parse it, not trust it.
      const promise = resolveSkillReferences("claudeAgent", PROJECT, refs as never, available);
      await expect(promise).rejects.toBeInstanceOf(SkillUnavailableError);
    }
  });

  test("a SKILL.md that no longer exists says so", async () => {
    const gone = "/nowhere/kone-missing-skill/SKILL.md";
    await expect(
      resolveSkillReferences("claudeAgent", PROJECT, [{ name: "missing", path: gone }], available),
    ).rejects.toThrow(`Skill "missing" is not available: its SKILL.md no longer exists at ${gone}.`);
  });

  test("a skill that exists but is disabled for the provider says so", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-skill-off-"));
    const skillPath = path.join(dir, "SKILL.md");
    writeFileSync(skillPath, "---\nname: off\n---\nbody\n");
    const off = entry("off", skillPath);
    await expect(
      resolveSkillReferences(
        "claudeAgent",
        PROJECT,
        [{ name: "off", path: skillPath }],
        deps({ skills: [off], stateFor: () => "disabled" }),
      ),
    ).rejects.toThrow('Skill "off" is not available: it is disabled for this provider');
  });
});

describe("buildSkillPrompt", () => {
  const files: Record<string, string> = {
    [claudeReview.path]: "---\nname: review\n---\nReview carefully.",
    [agentsReview.path]: "---\nname: review\n---\nAgents review.",
    [projectLint.path]: "---\nname: lint\n---\nRun the linter.",
    [codexDeploy.path]: "---\nname: Deploy\n---\nShip it.",
  };
  const readFile = async (filePath: string): Promise<string> => {
    const content = files[filePath];
    if (content === undefined) throw new Error("ENOENT");
    return content;
  };
  const ref = (skill: SkillEntry) => ({ name: skill.name, path: skill.path });

  test("no skills leave the prompt alone", async () => {
    expect(await buildSkillPrompt("claudeAgent", "hi", undefined, readFile)).toEqual({
      text: "hi",
      inlineBlock: "",
      codexItems: [],
    });
  });

  test("Claude: the first native skill leads as a slash command, nothing inlined", async () => {
    const built = await buildSkillPrompt("claudeAgent", "fix the bug", [ref(claudeReview)], readFile);
    expect(built).toEqual({ text: "/review fix the bug", inlineBlock: "", codexItems: [] });
  });

  test("Claude: a skill-only turn is just the command", async () => {
    const built = await buildSkillPrompt("claudeAgent", "", [ref(claudeReview)], readFile);
    expect(built.text).toBe("/review");
  });

  test("Claude: a second native skill and any foreign skill are inlined", async () => {
    const built = await buildSkillPrompt(
      "claudeAgent",
      "go",
      [ref(claudeReview), ref(projectLint), ref(codexDeploy)],
      readFile,
    );
    expect(built.text).toBe("/review go");
    expect(built.inlineBlock).toStartWith("<invoked_skills>");
    expect(built.inlineBlock).toContain(`<skill name="lint" path=${JSON.stringify(projectLint.path)}>\n---\nname: lint\n---\nRun the linter.\n</skill>`);
    expect(built.inlineBlock).toContain('<skill name="Deploy"');
    expect(built.inlineBlock).not.toContain("Review carefully.");
    expect(built.inlineBlock).toEndWith("</invoked_skills>");
  });

  test("Claude: with no native skill the text is untouched and everything is inlined", async () => {
    const built = await buildSkillPrompt("claudeAgent", "go", [ref(agentsReview)], readFile);
    expect(built.text).toBe("go");
    expect(built.inlineBlock).toContain("Agents review.");
  });

  test("Codex: native skills become skill items plus leading $mentions; foreign ones are inlined", async () => {
    const built = await buildSkillPrompt("codex", "ship", [ref(codexDeploy), ref(agentsReview), ref(projectLint)], readFile);
    expect(built.text).toBe("$Deploy $review ship");
    expect(built.codexItems).toEqual([
      { type: "skill", name: "Deploy", path: codexDeploy.path },
      { type: "skill", name: "review", path: agentsReview.path },
    ]);
    expect(built.inlineBlock).toContain("Run the linter.");
    expect(built.inlineBlock).not.toContain("Ship it.");
  });

  test("a name that is not a single command token is inlined rather than invoked", async () => {
    const spaced = { name: "my skill", path: `${HOME}/.claude/skills/my-skill/SKILL.md` };
    files[spaced.path] = "spaced body";
    const built = await buildSkillPrompt("claudeAgent", "x", [spaced], readFile);
    expect(built.text).toBe("x");
    expect(built.inlineBlock).toContain("spaced body");
  });

  test("other providers inline every skill", async () => {
    for (const provider of ["opencode", "cursor", "cline", "droid", "antigravity"] as const) {
      const built = await buildSkillPrompt(provider, "go", [ref(claudeReview), ref(codexDeploy)], readFile);
      expect(built.text).toBe("go");
      expect(built.codexItems).toEqual([]);
      expect(built.inlineBlock).toContain("Review carefully.");
      expect(built.inlineBlock).toContain("Ship it.");
    }
  });

  test("an oversized SKILL.md is cut and marked", async () => {
    const big = { name: "big", path: "/x/.cursor/skills/big/SKILL.md" };
    files[big.path] = "a".repeat(MAX_INLINE_SKILL_CHARS + 10);
    const built = await buildSkillPrompt("cursor", "", [big], readFile);
    expect(built.inlineBlock).toContain("[skill truncated]");
    expect(built.inlineBlock.length).toBeLessThan(MAX_INLINE_SKILL_CHARS + 1000);
  });

  test("an unreadable inlined skill fails the turn instead of dropping it", async () => {
    const gone = { name: "gone", path: "/x/.cursor/skills/gone/SKILL.md" };
    await expect(buildSkillPrompt("cursor", "go", [gone], readFile)).rejects.toThrow(
      `Skill "gone" is not available: its SKILL.md at ${gone.path} could not be read.`,
    );
  });

  test("inlineSkills appends the block after the composed prompt", async () => {
    expect(await inlineSkills("prompt", undefined, readFile)).toBe("prompt");
    const joined = await inlineSkills("prompt", [ref(projectLint)], readFile);
    expect(joined).toStartWith("prompt\n\n<invoked_skills>");
    const alone = await inlineSkills("", [ref(projectLint)], readFile);
    expect(alone).toStartWith("<invoked_skills>");
  });

  test("reads the real file when no reader is injected", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kone-skill-read-"));
    const skillDir = path.join(root, ".agents", "skills", "real");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "real body");
    const built = await buildSkillPrompt("cline", "", [{ name: "real", path: path.join(skillDir, "SKILL.md") }]);
    expect(built.inlineBlock).toContain("real body");
  });
});
