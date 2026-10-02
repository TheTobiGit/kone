import { describe, expect, test } from "bun:test";
import { AiChipIcon } from "@hugeicons/core-free-icons";
import type { SkillEntry } from "~/types/desktop";
import {
  filterSlashCommandItems,
  splitComposerMentionSegments,
  type SlashCommandItem,
} from "./composerMentions";
import {
  buildSkillSlashItems,
  composeSkillTurn,
  resolvePickedSkills,
  skillKey,
  splitComposerDraftSegments,
  type ComposerDraftPart,
} from "./composerSkills";

function skillEntry(name: string, extra: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: null,
    path: `/home/u/.claude/skills/${name}/SKILL.md`,
    directory: `/home/u/.claude/skills/${name}`,
    origin: "claude",
    scope: "user",
    displayName: null,
    shortDescription: null,
    author: null,
    modifiedAt: 0,
    shadowedBy: [],
    manualOnly: false,
    enabled: true,
    ...extra,
  };
}

const commands: SlashCommandItem[] = [
  { name: "compact", description: "Compact the thread", icon: AiChipIcon },
  { name: "model", description: "Switch model", icon: AiChipIcon },
];

describe("buildSkillSlashItems", () => {
  test("lists skills by name with their short description, sorted", () => {
    const rows = buildSkillSlashItems(commands, [
      skillEntry("tdd", { description: "Long description", shortDescription: "Red, green, refactor" }),
      skillEntry("animate-text", { description: "Text animation catalog" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["animate-text", "tdd"]);
    expect(rows[0]?.description).toBe("Text animation catalog");
    expect(rows[1]?.description).toBe("Red, green, refactor");
    expect(rows[0]?.skill).toEqual({
      name: "animate-text",
      path: "/home/u/.claude/skills/animate-text/SKILL.md",
    });
  });

  test("never lets a skill take a command's name, whatever its case", () => {
    const rows = buildSkillSlashItems(commands, [skillEntry("Model"), skillEntry("review")]);
    expect(rows.map((r) => r.name)).toEqual(["review"]);
  });

  test("lists one row per name and skips blank names", () => {
    const rows = buildSkillSlashItems(commands, [skillEntry("tdd"), skillEntry("TDD"), skillEntry("  ")]);
    expect(rows.map((r) => r.name)).toEqual(["tdd"]);
  });

  test("an empty list adds nothing — a provider with no skills shows commands only", () => {
    expect(buildSkillSlashItems(commands, [])).toEqual([]);
  });
});

describe("filterSlashCommandItems with skills", () => {
  const items = [...commands, ...buildSkillSlashItems(commands, [
    skillEntry("better-typography", { description: "Web typography" }),
    skillEntry("code-review", { description: "Review the diff" }),
  ])];

  test("prefix matches lead, commands before skills", () => {
    expect(filterSlashCommandItems(items, "c").map((i) => i.name)).toEqual(["compact", "code-review"]);
  });

  test("a skill also answers to a word inside its name or description", () => {
    expect(filterSlashCommandItems(items, "typo").map((i) => i.name)).toEqual(["better-typography"]);
    expect(filterSlashCommandItems(items, "diff").map((i) => i.name)).toEqual(["code-review"]);
  });

  test("commands stay prefix-only", () => {
    expect(filterSlashCommandItems(items, "odel").map((i) => i.name)).toEqual([]);
  });
});

describe("skillKey", () => {
  test("folds case and surrounding space", () => {
    expect(skillKey({ name: " Animate-Text " })).toBe(skillKey({ name: "animate-text" }));
  });
});

describe("resolvePickedSkills", () => {
  const claude = [skillEntry("tdd"), skillEntry("animate-text")];

  test("resolves picks by name and takes the current list's path", () => {
    const picked = [{ name: "TDD", path: "/old/codex/tdd/SKILL.md" }];
    expect(resolvePickedSkills(picked, claude)).toEqual({
      resolved: [{ name: "tdd", path: "/home/u/.claude/skills/tdd/SKILL.md" }],
      missing: [],
    });
  });

  test("a pick the list no longer has is missing — removed, or a provider switch", () => {
    const picked = [
      { name: "tdd", path: "/home/u/.claude/skills/tdd/SKILL.md" },
      { name: "gone", path: "/home/u/.claude/skills/gone/SKILL.md" },
    ];
    const result = resolvePickedSkills(picked, claude);
    expect(result.resolved.map((s) => s.name)).toEqual(["tdd"]);
    expect(result.missing.map((s) => s.name)).toEqual(["gone"]);
  });

  test("every pick is missing against an empty list", () => {
    const picked = [{ name: "tdd", path: "/x/tdd/SKILL.md" }];
    expect(resolvePickedSkills(picked, []).missing).toEqual(picked);
  });

  test("the same skill picked twice resolves once", () => {
    const picked = [
      { name: "tdd", path: "/a/SKILL.md" },
      { name: "Tdd", path: "/a/SKILL.md" },
    ];
    expect(resolvePickedSkills(picked, claude).resolved).toHaveLength(1);
  });
});

describe("composeSkillTurn", () => {
  const anim = { name: "animate-text", path: "/s/animate-text/SKILL.md" };
  const typo = { name: "better-typography", path: "/s/better-typography/SKILL.md" };
  const text = (t: string): ComposerDraftPart => ({ type: "text", text: t });
  const chip = (skill: typeof anim): ComposerDraftPart => ({ type: "skill", skill });

  test("a chip-only draft sends no text", () => {
    expect(composeSkillTurn([chip(anim), text(" ")])).toEqual({ input: "", skills: [anim] });
  });

  test("leading and trailing chips drop out of the text", () => {
    expect(composeSkillTurn([chip(anim), text(" fix the heading "), chip(typo)])).toEqual({
      input: "fix the heading",
      skills: [anim, typo],
    });
  });

  test("a chip mid-sentence stays as its bare name, never a /token", () => {
    const turn = composeSkillTurn([text("use "), chip(anim), text(" on the heading")]);
    expect(turn.input).toBe("use animate-text on the heading");
    expect(turn.input).not.toContain("/");
  });

  test("a run of leading chips all drop", () => {
    expect(composeSkillTurn([chip(anim), text(" "), chip(typo), text(" go")]).input).toBe("go");
  });

  test("dedupes skills on the case-insensitive name, first pick wins", () => {
    const loud = { name: "Animate-Text", path: anim.path };
    expect(composeSkillTurn([chip(anim), text(" a "), chip(loud), text(" b")]).skills).toEqual([anim]);
  });

  test("a typed /name is prose — only chips invoke", () => {
    expect(composeSkillTurn([text("/animate-text the heading")])).toEqual({
      input: "/animate-text the heading",
      skills: [],
    });
  });

  test("keeps line breaks inside the prose", () => {
    expect(composeSkillTurn([text("first\n"), chip(anim), text(" second")]).input).toBe(
      "first\nanimate-text second",
    );
  });
});

describe("splitComposerDraftSegments", () => {
  const anim = { name: "animate-text", path: "/s/animate-text/SKILL.md" };
  const tdd = { name: "plugin:tdd", path: "/s/tdd/SKILL.md" };
  const skills = [anim, tdd];

  test("re-chips a saved /name that names an invokable skill", () => {
    expect(splitComposerDraftSegments("/animate-text fix it", skills)).toEqual([
      { type: "skill", skill: anim, source: "/animate-text" },
      { type: "text", text: " fix it" },
    ]);
  });

  test("matches without case and allows namespaced names", () => {
    const segments = splitComposerDraftSegments("run /PLUGIN:TDD", skills);
    expect(segments).toEqual([
      { type: "text", text: "run " },
      { type: "skill", skill: tdd, source: "/PLUGIN:TDD" },
    ]);
  });

  test("leaves paths, unknown names and partial words as prose", () => {
    const value = "see /usr/bin and /unknown and /animate-texts ";
    expect(splitComposerDraftSegments(value, skills)).toEqual([{ type: "text", text: value }]);
  });

  test("keeps @mentions as mentions alongside skill chips", () => {
    expect(splitComposerDraftSegments("@src/a.ts /animate-text ", skills)).toEqual([
      { type: "mention", path: "src/a.ts", source: "@src/a.ts" },
      { type: "text", text: " " },
      { type: "skill", skill: anim, source: "/animate-text" },
      { type: "text", text: " " },
    ]);
  });

  test("with no skills it is the plain mention split", () => {
    expect(splitComposerDraftSegments("/animate-text ", [])).toEqual(
      splitComposerMentionSegments("/animate-text "),
    );
  });
});
