import { describe, expect, test } from "bun:test";
import {
  BUILTIN_SLASH_COMMANDS,
  SLASH_COMMANDS,
  slashAllowed,
  type SlashCapabilities,
  useComposerSlash,
} from "./useComposerSlash";
import { slashCommandTitle } from "~/utils/composerMentions";

const ALL_ON: SlashCapabilities = {
  agent: true,
  model: true,
  compact: true,
  branch: true,
  create: true,
};

describe("SLASH_COMMANDS", () => {
  test("every row has a gate, a description, and an icon", () => {
    for (const [name, def] of Object.entries(SLASH_COMMANDS)) {
      expect(def.gatedBy).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.icon).toBeTruthy();
      expect(slashCommandTitle(name)).toBe(`/${name}`);
    }
  });

  test("the menu rows derive from the table, alphabetical by name", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((item) => item.name);
    expect(names).toEqual(["agent", "branch", "compact", "model", "new"]);
    const tableIcons = Object.entries(SLASH_COMMANDS)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, def]) => def.icon);
    expect(BUILTIN_SLASH_COMMANDS.map((item) => item.icon)).toEqual(tableIcons);
  });
});

describe("slashAllowed", () => {
  test("allows every known command when all gates are open", () => {
    for (const name of Object.keys(SLASH_COMMANDS)) {
      expect(slashAllowed(ALL_ON, name)).toBe(true);
    }
  });

  test("each gate closes exactly its own rows", () => {
    const cases: [SlashCapabilities, string, boolean][] = [
      [{ ...ALL_ON, agent: false }, "agent", false],
      [{ ...ALL_ON, agent: false }, "model", true],
      [{ ...ALL_ON, model: false }, "model", false],
      [{ ...ALL_ON, model: false }, "agent", true],
      [{ ...ALL_ON, compact: false }, "compact", false],
      [{ ...ALL_ON, branch: false }, "branch", false],
      [{ ...ALL_ON, create: false }, "new", false],
      [{ ...ALL_ON, create: false }, "compact", true],
    ];
    for (const [gates, name, expected] of cases) {
      expect(slashAllowed(gates, name)).toBe(expected);
    }
  });

  test("unknown names are never allowed — the provider owns them", () => {
    expect(slashAllowed(ALL_ON, "unknown")).toBe(false);
    expect(slashAllowed(ALL_ON, "")).toBe(false);
  });
});

describe("useComposerSlash skill rows", () => {
  const open = () => true;
  const gates = { canSwitchAgent: open, canSwitchModel: open, canCompact: open, canBranch: open, canCreate: open };
  const entry = (name: string) => ({
    name,
    description: null,
    path: `/s/${name}/SKILL.md`,
    directory: `/s/${name}`,
    origin: "claude",
    scope: "user" as const,
    displayName: null,
    shortDescription: null,
    author: null,
    modifiedAt: 0,
    shadowedBy: [],
    manualOnly: false,
    enabled: true,
  });

  test("skills follow the commands, and only skill rows carry a skill", () => {
    const { slashItemsFor } = useComposerSlash({ ...gates, skills: () => [entry("tdd")] });
    const rows = slashItemsFor("");
    expect(rows.at(-1)?.name).toBe("tdd");
    expect(rows.filter((r) => r.skill).map((r) => r.name)).toEqual(["tdd"]);
  });

  test("a skill named like a hidden command is still left out", () => {
    const { slashItemsFor } = useComposerSlash({
      ...gates,
      canCompact: () => false,
      skills: () => [entry("compact")],
    });
    expect(slashItemsFor("comp")).toEqual([]);
  });

  test("no skills leaves the command list as it was", () => {
    const { slashItemsFor } = useComposerSlash(gates);
    expect(slashItemsFor("").every((r) => !r.skill)).toBe(true);
  });
});
