import { describe, expect, test } from "bun:test";

import { renderKoneHostContext } from "./appContext.js";
import { createRegistry } from "./registry.js";
import type { ToolEntry } from "./schemas.js";
import { createIrcTools } from "./tools/irc.js";
import { createLaunchTools } from "./tools/launch.js";
import { createScratchpadTools } from "./tools/scratchpad.js";
import { createSpawnTools } from "./tools/spawn.js";

// The real tool set, built the way createGateway builds it. Only the tool
// DEFINITIONS are under test — no handler runs — so each factory gets the
// narrowest store its own interface asks for, and none of them is ever called.
const scratchpadStore = {
  listScratchpads: () => [],
  getScratchpad: () => null,
  saveScratchpad: () => null,
  reserveGatewayOp: () => null,
  completeGatewayOp: () => {},
};
const spawnStore = {
  loadThread: () => null,
  listSubagentPresets: () => [],
  getSubagentPreset: () => null,
  listProjectAgents: () => [],
};

const TOOLS: ToolEntry[] = [
  ...createScratchpadTools({ store: scratchpadStore, emit: () => {} }),
  ...createSpawnTools({ store: spawnStore }),
  ...createIrcTools({}),
  ...createLaunchTools(),
];

/** Every tool the gateway would actually serve. */
const served = TOOLS.filter((tool) => tool.permission !== "deny");

describe("gateway tool prompts", () => {
  // The bug this whole arrangement exists to make impossible: the gateway grew
  // four tools the hand-written host-context paragraph never learned about, and
  // agents went a release without being told they had them.
  test("every tool the gateway serves is announced to the agent", () => {
    const unannounced = served.filter((tool) => !tool.promptSnippet).map((tool) => tool.name);
    expect(unannounced).toEqual([]);
  });

  test("the host-context block names every served tool and nothing else", () => {
    const registry = createRegistry(TOOLS);
    const block = renderKoneHostContext(registry.listToolPrompts());
    const names = served.map((tool) => tool.name);
    for (const name of names) expect(block).toContain(`\`${name}\``);

    for (const match of block.matchAll(/`(kone_[a-z_]+)`/g)) {
      expect(names).toContain(match[1]);
    }
  });

  test("a denied tool is neither served nor described", () => {
    const [first] = served;
    if (!first) throw new Error("the gateway serves no tools");
    const denied: ToolEntry = {
      ...first,
      name: "kone_secret",
      permission: "deny",
      promptSnippet: "Should never be seen.",
    };
    const registry = createRegistry([...TOOLS, denied]);
    expect(registry.listToolPrompts().some((t) => t.name === "kone_secret")).toBe(false);
    expect(renderKoneHostContext(registry.listToolPrompts())).not.toContain("kone_secret");
  });

  test("snippets stay one line — the tool's description carries the rest", () => {
    for (const tool of TOOLS) {
      if (!tool.promptSnippet) continue;
      expect(tool.promptSnippet).not.toContain("\n");
    }
  });

  test("the approval rung is reported, so a plan can allow for the wait", () => {
    const registry = createRegistry(TOOLS);
    const launch = registry.listToolPrompts().find((t) => t.name === "kone_launch");
    expect(launch?.needsApproval).toBe(true);
    expect(renderKoneHostContext(registry.listToolPrompts())).toContain(
      "(stops for the user's approval)",
    );
  });
});
