import { describe, expect, test } from "bun:test";
import { z } from "zod";

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

  test("worker scope returns only worker tools and omits app-steering tools", () => {
    const workerTool: ToolEntry = {
      name: "kone_scratchpad_read",
      description: "Read scratchpad",
      inputSchema: z.object({}),
      jsonSchema: { type: "object" },
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "Read scratchpad",
      target: "worker",
      handler: async () => ({ content: [] }),
    };
    const assistantTool: ToolEntry = {
      name: "app_apply_theme",
      description: "Apply theme",
      inputSchema: z.object({}),
      jsonSchema: { type: "object" },
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "Apply theme",
      target: "assistant",
      handler: async () => ({ content: [] }),
    };
    const reg = createRegistry([workerTool, assistantTool]);
    const workerTools = reg.listTools("worker");
    expect(workerTools.map((t) => t.name)).toEqual(["kone_scratchpad_read"]);

    const assistantTools = reg.listTools("assistant");
    expect(assistantTools.map((t) => t.name)).toEqual(["app_apply_theme"]);
  });

  test("calling an assistant tool from worker scope returns permission_denied", async () => {
    const assistantTool: ToolEntry = {
      name: "app_apply_theme",
      description: "Apply theme",
      inputSchema: z.object({}),
      jsonSchema: { type: "object" },
      permission: "allow",
      requiresActiveTurn: false,
      target: "assistant",
      handler: async () => ({ content: [{ type: "text", text: "applied" }] }),
    };
    const reg = createRegistry([assistantTool]);
    const ctx = {
      threadId: "t1",
      turnId: "turn-1",
      provider: "claude" as const,
      cwd: "/tmp",
    };
    const res = await reg.call(ctx, "app_apply_theme", {}, "worker");
    expect(res.isError).toBe(true);
    // SAFETY: content element text checked
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("permission_denied");
  });
});
