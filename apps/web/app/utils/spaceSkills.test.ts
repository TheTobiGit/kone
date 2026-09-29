import { describe, expect, test } from "bun:test";
import type { SkillEntry } from "~/types/desktop";
import { groupSkills } from "./spaceSkills";

function skill(name: string, origin: string, extra: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: `${name} description`,
    path: `/skills/${origin}/${name}/SKILL.md`,
    directory: `/skills/${origin}/${name}`,
    origin,
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

const noneOff: ReadonlySet<string> = new Set();

describe("groupSkills", () => {
  test("one group per provider, labelled the way the rest of the app labels it", () => {
    const groups = groupSkills([skill("a", "claude"), skill("b", "codex"), skill("c", "claude")], noneOff);
    expect(groups.map((g) => [g.origin, g.label, g.rows.length])).toEqual([
      ["claude", "Claude", 2],
      ["codex", "Codex", 1],
    ]);
  });

  test("groups follow the shared order, and an origin it doesn't name comes last", () => {
    const groups = groupSkills(
      [
        skill("a", "zed"),
        skill("b", "factory"),
        skill("c", "codex"),
        skill("d", "agents"),
        skill("e", "claude"),
        skill("f", "acme"),
      ],
      noneOff,
    );
    expect(groups.map((g) => g.origin)).toEqual(["agents", "claude", "codex", "factory", "acme", "zed"]);
  });

  test("an origin nobody named reads back as itself", () => {
    expect(groupSkills([skill("a", "newcli")], noneOff)[0]?.label).toBe("newcli");
  });

  test("the project's own skills lead a group, then everything by name", () => {
    const groups = groupSkills(
      [
        skill("zeta", "claude"),
        skill("Beta", "claude", { scope: "project" }),
        skill("alpha", "claude"),
        skill("gamma", "claude", { scope: "project" }),
      ],
      noneOff,
    );
    const rows = groups[0]?.rows ?? [];
    expect(rows.map((r) => r.name)).toEqual(["Beta", "gamma", "alpha", "zeta"]);
    expect(rows.map((r) => r.project)).toEqual([true, true, false, false]);
  });

  test("a system or plugin skill is not the project's", () => {
    const rows = groupSkills(
      [skill("a", "codex", { scope: "system" }), skill("b", "codex", { scope: "plugin" })],
      noneOff,
    )[0]?.rows;
    expect(rows?.map((r) => r.project)).toEqual([false, false]);
  });

  test("a display name stands in for the folder's name; the description falls back to the short one", () => {
    const [row] = groupSkills(
      [skill("pdf-tools", "claude", { displayName: "PDF tools", description: null, shortDescription: "Work with PDFs" })],
      noneOff,
    )[0]?.rows ?? [];
    expect(row?.name).toBe("PDF tools");
    expect(row?.description).toBe("Work with PDFs");
  });

  test("a skill with nothing to say for itself has no description", () => {
    const [row] = groupSkills([skill("a", "claude", { description: null })], noneOff)[0]?.rows ?? [];
    expect(row?.description).toBeNull();
  });

  test("off is whatever the caller says, per skill", () => {
    const off = skill("off", "claude");
    const groups = groupSkills([skill("on", "claude"), off], new Set([off.path]));
    const rows = groups[0]?.rows ?? [];
    expect(rows.map((r) => [r.name, r.off])).toEqual([
      ["off", true],
      ["on", false],
    ]);
  });

  test("two copies of a name in different providers both stand, neither shadowed", () => {
    // The scan keeps one winner per name across every provider; the loser is
    // still what its own provider reads.
    const winner = skill("lint", "claude");
    const loser = skill("lint", "agents", {
      shadowed: true,
      shadowedByWinner: { origin: "claude", scope: "user", path: winner.path },
    });
    const groups = groupSkills([winner, loser], noneOff);
    expect(groups.map((g) => [g.origin, g.rows.map((r) => r.shadowed)])).toEqual([
      ["agents", [false]],
      ["claude", [false]],
    ]);
  });

  test("a copy that loses inside its own provider is shadowed", () => {
    const winner = skill("lint", "claude");
    const loser = skill("lint", "claude", {
      scope: "project",
      path: "/project/.claude/skills/lint/SKILL.md",
      shadowed: true,
      shadowedByWinner: { origin: "claude", scope: "user", path: winner.path },
    });
    const rows = groupSkills([winner, loser], noneOff)[0]?.rows ?? [];
    expect(rows.map((r) => [r.project, r.shadowed])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  test("two copies of a name in one provider keep separate keys", () => {
    const a = skill("lint", "claude");
    const b = skill("lint", "claude", { path: "/elsewhere/SKILL.md" });
    const keys = groupSkills([a, b], noneOff)[0]?.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  test("nothing scanned, nothing grouped", () => {
    expect(groupSkills([], noneOff)).toEqual([]);
  });
});
