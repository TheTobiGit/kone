import { describe, expect, test } from "bun:test";

import {
  applyClaudeOverride,
  applyCodexSkillConfig,
  applyOpenCodePermission,
  deriveClaudeSkillState,
  matchOpenCodePattern,
  readClaudeOverrides,
  readCodexSkillConfig,
  readOpenCodePermission,
  readSkillState,
  resolveCodexSkillState,
  resolveOpenCodeSkillState,
  writeSkillState,
} from "./skillState.js";
import type { SkillStateFs } from "./skillState.js";

// The edge functions take an injectable fs + home, so nothing here touches a
// real ~/.claude or any real config file.

function memoryFs(initial: Record<string, string>): SkillStateFs {
  const files = new Map(Object.entries(initial));
  return {
    async readFile(filePath) {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath, contents) {
      files.set(filePath, contents);
    },
  };
}

const HOME = "/home/tester";

describe("readClaudeOverrides", () => {
  test("parses a JSONC settings file with comments and trailing commas", () => {
    const contents = `{
      // a human comment
      "model": "opus[1m]",
      "skillOverrides": {
        "deep-research": "off",
        "frontend": "name-only",
      }, /* trailing comment */
    }`;
    expect(readClaudeOverrides(contents)).toEqual({
      "deep-research": "off",
      frontend: "name-only",
    });
  });

  test("returns {} when the key is absent or the file is invalid", () => {
    expect(readClaudeOverrides(`{ "model": "opus[1m]" }`)).toEqual({});
    expect(readClaudeOverrides(`not json at all`)).toEqual({});
    expect(readClaudeOverrides(`{}`)).toEqual({});
  });

  test("returns {} when skillOverrides is not an object", () => {
    expect(readClaudeOverrides(`{ "skillOverrides": "off" }`)).toEqual({});
  });

  test("drops non-string values", () => {
    expect(readClaudeOverrides(`{ "skillOverrides": { "a": "on", "b": 1 } }`)).toEqual({ a: "on" });
  });
});

describe("deriveClaudeSkillState", () => {
  test("absent key means enabled", () => {
    expect(deriveClaudeSkillState({}, "my-skill", false)).toBe("enabled");
  });

  test("maps each override value", () => {
    expect(deriveClaudeSkillState({ "my-skill": "on" }, "my-skill", false)).toBe("enabled");
    expect(deriveClaudeSkillState({ "my-skill": "off" }, "my-skill", false)).toBe("disabled");
    expect(deriveClaudeSkillState({ "my-skill": "name-only" }, "my-skill", false)).toBe("name-only");
    expect(deriveClaudeSkillState({ "my-skill": "user-invocable-only" }, "my-skill", false)).toBe(
      "user-invocable-only",
    );
  });

  test("an unrecognized value reads as enabled", () => {
    expect(deriveClaudeSkillState({ "my-skill": "banana" }, "my-skill", false)).toBe("enabled");
  });

  test("disable-model-invocation forces user-invocable-only unless the override is off", () => {
    const on = { "my-skill": "on" };
    expect(deriveClaudeSkillState(on, "my-skill", true)).toBe("user-invocable-only");
    expect(deriveClaudeSkillState(on, "my-skill", false)).toBe("enabled");
    const nameOnly = { "my-skill": "name-only" };
    expect(deriveClaudeSkillState(nameOnly, "my-skill", true)).toBe("user-invocable-only");
    const off = { "my-skill": "off" };
    expect(deriveClaudeSkillState(off, "my-skill", true)).toBe("disabled");
    expect(deriveClaudeSkillState({}, "my-skill", true)).toBe("user-invocable-only");
  });
});

describe("applyClaudeOverride", () => {
  const multiline = `{
  "model": "opus[1m]",
  // keep this comment
  "skillOverrides": {
    "deep-research": "off"
  }
}`;

  test("replaces the value token in place, leaving everything else byte-for-byte", () => {
    expect(applyClaudeOverride(multiline, "deep-research", "enabled")).toBe(`{
  "model": "opus[1m]",
  // keep this comment
  "skillOverrides": {
    "deep-research": "on"
  }
}`);
  });

  test("inserts a new skill entry at the end of the existing object", () => {
    expect(applyClaudeOverride(multiline, "new-skill", "disabled")).toBe(`{
  "model": "opus[1m]",
  // keep this comment
  "skillOverrides": {
    "deep-research": "off",
    "new-skill": "off"
  }
}`);
  });

  test("inserts into a single-line object", () => {
    const inline = `{ "a": 1, "skillOverrides": { "x": "on" } }`;
    expect(applyClaudeOverride(inline, "y", "disabled")).toBe(`{ "a": 1, "skillOverrides": { "x": "on", "y": "off" } }`);
    expect(applyClaudeOverride(inline, "x", "disabled")).toBe(`{ "a": 1, "skillOverrides": { "x": "off" } }`);
  });

  test("adds a whole new skillOverrides block when the key is absent", () => {
    expect(applyClaudeOverride(`{ "model": "opus[1m]" }`, "deep-research", "disabled")).toBe(`{ "model": "opus[1m]",
  "skillOverrides": {
    "deep-research": "off"
  }
}`);
    expect(applyClaudeOverride(`{}`, "deep-research", "disabled")).toBe(`{
  "skillOverrides": {
    "deep-research": "off"
  }
}`);
  });

  test("writes the exact state values and round-trips", () => {
    const apply = (state: "enabled" | "name-only" | "user-invocable-only" | "disabled") =>
      applyClaudeOverride(`{}`, "s", state);
    expect(readClaudeOverrides(apply("enabled"))).toEqual({ s: "on" });
    expect(readClaudeOverrides(apply("name-only"))).toEqual({ s: "name-only" });
    expect(readClaudeOverrides(apply("user-invocable-only"))).toEqual({ s: "user-invocable-only" });
    expect(readClaudeOverrides(apply("disabled"))).toEqual({ s: "off" });
  });

  test("refuses to touch a file whose skillOverrides is not an object or that is invalid", () => {
    const notObject = `{ "skillOverrides": "off" }`;
    expect(applyClaudeOverride(notObject, "s", "disabled")).toBe(notObject);
    const invalid = `{ "model": `;
    expect(applyClaudeOverride(invalid, "s", "disabled")).toBe(invalid);
  });
});

describe("readCodexSkillConfig", () => {
  test("parses [[skills.config]] blocks and ignores other sections", () => {
    const contents = `disable_response_storage = true
model_reasoning_effort = "high"

[[skills.config]]
path = "/Users/t/one/SKILL.md"
enabled = false  # user disabled this

[[skills.config]]
name = "by-name"
enabled = true

[features]
steer = true

[[skills.config]]
path = "/Users/t/three/SKILL.md"
`;
    expect(readCodexSkillConfig(contents)).toEqual([
      { path: "/Users/t/one/SKILL.md", name: null, enabled: false },
      { path: null, name: "by-name", enabled: true },
      { path: "/Users/t/three/SKILL.md", name: null, enabled: true },
    ]);
  });

  test("an entry without an enabled line reads as enabled", () => {
    expect(readCodexSkillConfig(`[[skills.config]]\npath = "/a/SKILL.md"`)).toEqual([
      { path: "/a/SKILL.md", name: null, enabled: true },
    ]);
  });

  test("single-quoted paths are honored", () => {
    const contents = `[[skills.config]]\npath = '/a/SKILL.md'\nenabled = false`;
    expect(readCodexSkillConfig(contents)[0]?.path).toBe("/a/SKILL.md");
  });
});

describe("resolveCodexSkillState", () => {
  const entries = readCodexSkillConfig(`[[skills.config]]
path = "/a/SKILL.md"
enabled = false

[[skills.config]]
name = "my-skill"
enabled = false

[[skills.config]]
path = "/b/SKILL.md"
enabled = true
`);

  test("matches by SKILL.md path and by name", () => {
    expect(resolveCodexSkillState(entries, "/a/SKILL.md", "whatever")).toBe("disabled");
    expect(resolveCodexSkillState(entries, "/b/SKILL.md", "whatever")).toBe("enabled");
    expect(resolveCodexSkillState(entries, "/unlisted/SKILL.md", "my-skill")).toBe("disabled");
    expect(resolveCodexSkillState(entries, "/unlisted/SKILL.md", "other")).toBe("enabled");
  });

  test("the last matching entry wins", () => {
    const later = `[[skills.config]]
path = "/a/SKILL.md"
enabled = false

[[skills.config]]
path = "/a/SKILL.md"
enabled = true
`;
    expect(resolveCodexSkillState(readCodexSkillConfig(later), "/a/SKILL.md", "x")).toBe("enabled");
  });

  test("an entry with both selectors is one Codex ignores", () => {
    const both = `[[skills.config]]
path = "/a/SKILL.md"
name = "my-skill"
enabled = false
`;
    expect(resolveCodexSkillState(readCodexSkillConfig(both), "/a/SKILL.md", "my-skill")).toBe("enabled");
  });
});

describe("applyCodexSkillConfig", () => {
  test("flips an existing enabled line in place, preserving the trailing comment", () => {
    const contents = `disable_response_storage = true

[[skills.config]]
path = "/a/SKILL.md"
enabled = false  # user disabled this
`;
    expect(applyCodexSkillConfig(contents, "/a/SKILL.md", true)).toBe(`disable_response_storage = true

[[skills.config]]
path = "/a/SKILL.md"
enabled = true  # user disabled this
`);
  });

  test("adds an enabled line to a block that lacks one", () => {
    const contents = `[[skills.config]]
path = "/a/SKILL.md"
`;
    expect(applyCodexSkillConfig(contents, "/a/SKILL.md", false)).toBe(`[[skills.config]]
path = "/a/SKILL.md"
enabled = false
`);
  });

  test("inserts a new block before the first table header so it stays top-level", () => {
    const contents = `disable_response_storage = true

[features]
steer = true

[mcp_servers.node]
command = "node"
`;
    const applied = applyCodexSkillConfig(contents, "/new/SKILL.md", false);
    expect(applied).toBe(`disable_response_storage = true

[[skills.config]]
path = "/new/SKILL.md"
enabled = false

[features]
steer = true

[mcp_servers.node]
command = "node"
`);
    const topLevel = applied.indexOf("[features]");
    const block = applied.indexOf("[[skills.config]]");
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(topLevel);
  });

  test("enabling a skill with no entry leaves the file unchanged", () => {
    const contents = `disable_response_storage = true\n`;
    expect(applyCodexSkillConfig(contents, "/a/SKILL.md", true)).toBe(contents);
  });

  test("the written block round-trips through the reader", () => {
    const applied = applyCodexSkillConfig(`disable_response_storage = true\n`, "/a/SKILL.md", false);
    expect(resolveCodexSkillState(readCodexSkillConfig(applied), "/a/SKILL.md", "a")).toBe("disabled");
  });
});

describe("readOpenCodePermission", () => {
  test("parses the pattern map, including comments and trailing commas", () => {
    const contents = `{
  "permission": {
    // skills map
    "skill": {
      "*": "allow",
      "internal-*": "deny",
    },
  },
}`;
    expect(readOpenCodePermission(contents)).toEqual({ "*": "allow", "internal-*": "deny" });
  });

  test("the shorthand string form reads as the wildcard pattern", () => {
    expect(readOpenCodePermission(`{ "permission": { "skill": "deny" } }`)).toEqual({ "*": "deny" });
    expect(readOpenCodePermission(`{ "permission": "deny" }`)).toEqual({});
    expect(readOpenCodePermission(`{}`)).toEqual({});
  });
});

describe("matchOpenCodePattern", () => {
  test("matches exact names, wildcards and ?", () => {
    expect(matchOpenCodePattern("my-skill", "my-skill")).toBe(true);
    expect(matchOpenCodePattern("my-skill", "other")).toBe(false);
    expect(matchOpenCodePattern("*", "anything-at-all")).toBe(true);
    expect(matchOpenCodePattern("internal-*", "internal-website")).toBe(true);
    expect(matchOpenCodePattern("internal-*", "website")).toBe(false);
    expect(matchOpenCodePattern("my-?kill", "my-skill")).toBe(true);
    expect(matchOpenCodePattern("my-?kill", "my-sskill")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(matchOpenCodePattern("a.b", "axb")).toBe(false);
    expect(matchOpenCodePattern("a.b", "a.b")).toBe(true);
    expect(matchOpenCodePattern("a.b", "a.banything")).toBe(false);
  });
});

describe("resolveOpenCodeSkillState", () => {
  test("the last matching pattern in file order wins", () => {
    expect(resolveOpenCodeSkillState({ "*": "allow", "my-skill": "deny" }, "my-skill").state).toBe("disabled");
    expect(resolveOpenCodeSkillState({ "my-skill": "deny", "*": "allow" }, "my-skill").state).toBe("enabled");
  });

  test("deny is disabled; allow, ask and absence are enabled", () => {
    expect(resolveOpenCodeSkillState({ "*": "deny" }, "anything").state).toBe("disabled");
    expect(resolveOpenCodeSkillState({ "*": "allow" }, "anything").state).toBe("enabled");
    expect(resolveOpenCodeSkillState({ "*": "ask" }, "anything").state).toBe("enabled");
    expect(resolveOpenCodeSkillState({}, "anything").state).toBe("enabled");
    expect(resolveOpenCodeSkillState({ "internal-*": "deny" }, "internal-x").pattern).toBe("internal-*");
  });
});

describe("applyOpenCodePermission", () => {
  test("adds a deny entry at the end of the skill map so it beats earlier wildcards", () => {
    const contents = `{
  "permission": {
    "skill": {
      "*": "allow",
      "internal-*": "deny"
    }
  }
}`;
    const applied = applyOpenCodePermission(contents, "my-skill", "deny");
    expect(applied).toBe(`{
  "permission": {
    "skill": {
      "*": "allow",
      "internal-*": "deny",
      "my-skill": "deny"
    }
  }
}`);
    expect(resolveOpenCodeSkillState(readOpenCodePermission(applied), "my-skill").state).toBe("disabled");
  });

  test("updates an existing entry in place", () => {
    const contents = `{ "permission": { "skill": { "my-skill": "allow", "other": "allow" } } }`;
    expect(applyOpenCodePermission(contents, "my-skill", "deny")).toBe(
      `{ "permission": { "skill": { "my-skill": "deny", "other": "allow" } } }`,
    );
  });

  test("inserts a fresh permission block when none exists", () => {
    const applied = applyOpenCodePermission(`{ "provider": { "openai": { "name": "OpenAI" } } }`, "my-skill", "deny");
    expect(readOpenCodePermission(applied)).toEqual({ "my-skill": "deny" });
    expect(applied).toContain(`"permission": {`);
  });

  test("inserts a skill map into an existing permission object", () => {
    const contents = `{ "permission": { "bash": "allow" } }`;
    const applied = applyOpenCodePermission(contents, "my-skill", "deny");
    expect(readOpenCodePermission(applied)).toEqual({ "my-skill": "deny" });
  });

  test("converts the shorthand skill string into an object preserving the wildcard", () => {
    const contents = `{ "permission": { "skill": "deny" } }`;
    const applied = applyOpenCodePermission(contents, "my-skill", "deny");
    expect(applied).toBe(`{ "permission": { "skill": { "*": "deny", "my-skill": "deny" } } }`);
    expect(applyOpenCodePermission(contents, "my-skill", "remove")).toBe(contents);
  });

  test("removes an entry and keeps its neighbours byte-for-byte", () => {
    const contents = `{
  "permission": {
    "skill": {
      "*": "allow",
      "internal-*": "deny",
      "my-skill": "deny"
    }
  }
}`;
    const applied = applyOpenCodePermission(contents, "my-skill", "remove");
    expect(applied).toBe(`{
  "permission": {
    "skill": {
      "*": "allow",
      "internal-*": "deny"
    }
  }
}`);
    expect(applyOpenCodePermission(contents, "absent-skill", "remove")).toBe(contents);
  });

  test("removing the only entry leaves a valid empty map", () => {
    const applied = applyOpenCodePermission(`{ "permission": { "skill": { "my-skill": "deny" } } }`, "my-skill", "remove");
    expect(readOpenCodePermission(applied)).toEqual({});
    expect(resolveOpenCodeSkillState(readOpenCodePermission(applied), "my-skill").state).toBe("enabled");
  });

  test("leaves invalid files alone", () => {
    const invalid = `{ "permission": { "skill": { `;
    expect(applyOpenCodePermission(invalid, "s", "deny")).toBe(invalid);
    const notObject = `{ "permission": "deny" }`;
    expect(applyOpenCodePermission(notObject, "s", "deny")).toBe(notObject);
  });
});

describe("readSkillState edge", () => {
  test("cursor is unsupported with a stated reason", async () => {
    const result = await readSkillState({ origin: "cursor", skillName: "x", home: HOME, fs: memoryFs({}) });
    expect(result.state).toBe("unsupported");
    expect(result.reason).toMatch(/no per-skill switch/);
    expect(result.source).toBeNull();
  });

  test("the shared agents root is unsupported", async () => {
    const result = await readSkillState({ origin: "agents", skillName: "x", home: HOME, fs: memoryFs({}) });
    expect(result.state).toBe("unsupported");
    expect(result.reason).toMatch(/shared \.agents root/);
  });

  test("claude plugin skills are unsupported", async () => {
    const result = await readSkillState({
      origin: "claude",
      skillName: "x",
      scope: "plugin",
      home: HOME,
      fs: memoryFs({}),
    });
    expect(result.state).toBe("unsupported");
    expect(result.reason).toMatch(/owned by the plugin/);
  });

  test("claude user settings drive the state", async () => {
    const fs = memoryFs({
      [`${HOME}/.claude/settings.json`]: `{ "skillOverrides": { "deep-research": "off" } }`,
    });
    const result = await readSkillState({ origin: "claude", skillName: "deep-research", home: HOME, fs });
    expect(result.state).toBe("disabled");
    expect(result.reason).toContain("~/.claude/settings.json");
    expect(result.source).toBe("Claude user settings (~/.claude/settings.json).");
  });

  test("claude local project settings win over user settings", async () => {
    const fs = memoryFs({
      [`${HOME}/.claude/settings.json`]: `{ "skillOverrides": { "s": "off" } }`,
      "/repo/app/.claude/settings.local.json": `{ "skillOverrides": { "s": "on" } }`,
    });
    const result = await readSkillState({
      origin: "claude",
      skillName: "s",
      projectPath: "/repo/app",
      home: HOME,
      fs,
    });
    expect(result.state).toBe("enabled");
    expect(result.source).toBe("Claude local project settings (/repo/app/.claude/settings.local.json).");
  });

  test("a plain skill with nothing recorded is enabled with no reason", async () => {
    const result = await readSkillState({ origin: "claude", skillName: "s", home: HOME, fs: memoryFs({}) });
    expect(result).toEqual({ state: "enabled", reason: null, source: null });
  });

  test("disable-model-invocation frontmatter forces user-invocable-only", async () => {
    const fs = memoryFs({
      "/repo/app/.claude/skills/s/SKILL.md": `---\nname: s\ndisable-model-invocation: true\n---\nbody\n`,
    });
    const result = await readSkillState({
      origin: "claude",
      skillName: "s",
      scope: "project",
      skillPath: "/repo/app/.claude/skills/s/SKILL.md",
      projectPath: "/repo/app",
      home: HOME,
      fs,
    });
    expect(result.state).toBe("user-invocable-only");
    expect(result.source).toBe("The skill's own frontmatter (/repo/app/.claude/skills/s/SKILL.md).");
  });

  test("codex config.toml drives the state", async () => {
    const fs = memoryFs({
      [`${HOME}/.codex/config.toml`]: `[[skills.config]]\npath = "/a/SKILL.md"\nenabled = false\n`,
    });
    const disabled = await readSkillState({
      origin: "codex",
      skillName: "a",
      skillPath: "/a/SKILL.md",
      home: HOME,
      fs,
    });
    expect(disabled.state).toBe("disabled");
    expect(disabled.reason).toContain("~/.codex/config.toml");

    const enabled = await readSkillState({
      origin: "codex",
      skillName: "b",
      skillPath: "/b/SKILL.md",
      home: HOME,
      fs,
    });
    expect(enabled).toEqual({ state: "enabled", reason: null, source: null });
  });

  test("opencode permission.skill deny drives the state, including wildcard patterns", async () => {
    const fs = memoryFs({
      [`${HOME}/.config/opencode/opencode.json`]: `{ "permission": { "skill": { "*": "allow", "internal-*": "deny" } } }`,
    });
    const denied = await readSkillState({ origin: "opencode", skillName: "internal-x", home: HOME, fs });
    expect(denied.state).toBe("disabled");
    expect(denied.reason).toContain('pattern "internal-*"');

    const allowed = await readSkillState({ origin: "opencode", skillName: "my-skill", home: HOME, fs });
    expect(allowed).toEqual({ state: "enabled", reason: null, source: null });
  });
});

describe("writeSkillState edge", () => {
  test("claude: writes the override, then reports a no-op on a second write", async () => {
    const fs = memoryFs({});
    const first = await writeSkillState({
      origin: "claude",
      skillName: "deep-research",
      state: "disabled",
      home: HOME,
      fs,
    });
    expect(first.ok).toBe(true);
    expect(first.wrotePath).toBe(`${HOME}/.claude/settings.json`);
    expect(readClaudeOverrides((await fs.readFile(`${HOME}/.claude/settings.json`)) ?? "")).toEqual({
      "deep-research": "off",
    });

    const second = await writeSkillState({
      origin: "claude",
      skillName: "deep-research",
      state: "disabled",
      home: HOME,
      fs,
    });
    expect(second.ok).toBe(true);
    expect(second.wrotePath).toBeNull();
  });

  test("claude: enabling with no settings file is a no-op", async () => {
    const fs = memoryFs({});
    const result = await writeSkillState({ origin: "claude", skillName: "s", state: "enabled", home: HOME, fs });
    expect(result).toEqual({
      ok: true,
      wrotePath: null,
      reason: "No settings file exists, and an absent override already means the skill is enabled; nothing was written.",
    });
  });

  test("claude: project scope writes settings.local.json, and fails without a project", async () => {
    const fs = memoryFs({});
    const result = await writeSkillState({
      origin: "claude",
      skillName: "s",
      state: "name-only",
      scope: "project",
      projectPath: "/repo/app",
      home: HOME,
      fs,
    });
    expect(result.ok).toBe(true);
    expect(result.wrotePath).toBe("/repo/app/.claude/settings.local.json");

    const noProject = await writeSkillState({ origin: "claude", skillName: "s", state: "disabled", scope: "project", home: HOME, fs });
    expect(noProject.ok).toBe(false);
    expect(noProject.reason).toContain("No project is open");
  });

  test("claude: plugin skills are refused", async () => {
    const result = await writeSkillState({
      origin: "claude",
      skillName: "p:s",
      state: "disabled",
      scope: "plugin",
      home: HOME,
      fs: memoryFs({}),
    });
    expect(result.ok).toBe(false);
    expect(result.wrotePath).toBeNull();
  });

  test("codex: writes the TOML block and flips it back", async () => {
    const fs = memoryFs({});
    const disabled = await writeSkillState({
      origin: "codex",
      skillName: "a",
      skillPath: "/a/SKILL.md",
      state: "disabled",
      home: HOME,
      fs,
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.wrotePath).toBe(`${HOME}/.codex/config.toml`);
    expect(resolveCodexSkillState(readCodexSkillConfig((await fs.readFile(`${HOME}/.codex/config.toml`)) ?? ""), "/a/SKILL.md", "a")).toBe("disabled");

    const enabled = await writeSkillState({
      origin: "codex",
      skillName: "a",
      skillPath: "/a/SKILL.md",
      state: "enabled",
      home: HOME,
      fs,
    });
    expect(enabled.ok).toBe(true);
    expect(resolveCodexSkillState(readCodexSkillConfig((await fs.readFile(`${HOME}/.codex/config.toml`)) ?? ""), "/a/SKILL.md", "a")).toBe("enabled");
  });

  test("codex: refuses a state it has no boolean for", async () => {
    const result = await writeSkillState({
      origin: "codex",
      skillName: "a",
      skillPath: "/a/SKILL.md",
      state: "name-only",
      home: HOME,
      fs: memoryFs({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("boolean");
  });

  test("opencode: deny writes, remove re-enables, wildcard block is reported", async () => {
    const fs = memoryFs({});
    const deny = await writeSkillState({ origin: "opencode", skillName: "my-skill", state: "disabled", home: HOME, fs });
    expect(deny.ok).toBe(true);
    expect(deny.wrotePath).toBe(`${HOME}/.config/opencode/opencode.json`);
    const stored = (await fs.readFile(`${HOME}/.config/opencode/opencode.json`)) ?? "";
    expect(readOpenCodePermission(stored)).toEqual({ "my-skill": "deny" });

    const enable = await writeSkillState({ origin: "opencode", skillName: "my-skill", state: "enabled", home: HOME, fs });
    expect(enable.ok).toBe(true);
    expect(readOpenCodePermission((await fs.readFile(`${HOME}/.config/opencode/opencode.json`)) ?? "")).toEqual({});

    const wildcard = memoryFs({
      [`${HOME}/.config/opencode/opencode.json`]: `{ "permission": { "skill": { "*": "deny" } } }`,
    });
    const blocked = await writeSkillState({ origin: "opencode", skillName: "my-skill", state: "enabled", home: HOME, fs: wildcard });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('"*" wildcard');
  });

  test("cursor and agents writes are refused honestly", async () => {
    const cursor = await writeSkillState({ origin: "cursor", skillName: "s", state: "disabled", home: HOME, fs: memoryFs({}) });
    expect(cursor.ok).toBe(false);
    expect(cursor.reason).toMatch(/no per-skill switch/);

    const agents = await writeSkillState({ origin: "agents", skillName: "s", state: "disabled", home: HOME, fs: memoryFs({}) });
    expect(agents.ok).toBe(false);
  });
});
