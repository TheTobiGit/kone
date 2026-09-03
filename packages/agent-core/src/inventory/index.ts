// FILE: index.ts
// Purpose: the Agents-page inventory entrypoint. Runs the skills, MCP-server
// and instruction-file scans concurrently, catches every individual failure
// into `errors` instead of letting the whole scan reject, and caches the
// result per project for a short TTL so a page that re-renders quickly
// doesn't re-walk the filesystem (same short-TTL shape as the skills
// catalog cache — docs/skills-mcp-research.md §4).
// Exports: scanAgentInventory, on-demand doc indexer utilities

import { discoverInstructions } from "./instructions.js";
import { discoverMcpServers } from "./mcp.js";
import { discoverPlugins, discoverSkills } from "./skills.js";
import { homedir } from "node:os";
import type { AgentInventory, InventoryError, PluginEntry } from "./types.js";

export * from "./onDemandDocs.js";

const CACHE_TTL_MS = 15_000;

type CacheEntry = { at: number; inventory: AgentInventory };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AgentInventory>>();

function cacheKey(projectPath: string | string[] | null): string {
  if (!projectPath) return "no-project";
  if (Array.isArray(projectPath)) return [...projectPath].sort().join("|") || "no-project";
  return projectPath;
}

/** Scans skills, MCP servers, and instruction files for `projectPath` (or
 *  just the user-scope roots when null). Accepts a single path or an array of
 *  project paths — the pane now passes every project added in the app so its
 *  list covers `~/.claude/skills` + each project's `.claude/.codex/.cursor/
 *  .opencode/.agents/.factory/skills`. Read-only, and NEVER rejects — every
 *  scan step's own failures are caught and reported inline via
 *  `AgentInventory.errors` alongside whatever partial result it managed. */
export async function scanAgentInventory(
  projectPath: string | string[] | null,
): Promise<AgentInventory> {
  const key = cacheKey(projectPath);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) {
    return cached.inventory;
  }

  const running = inflight.get(key);
  if (running) return running;

  const scan = (async (): Promise<AgentInventory> => {
    const errors: InventoryError[] = [];

    const firstPath = Array.isArray(projectPath) ? (projectPath[0] ?? null) : projectPath;

    const [skillsResult, pluginsResult, mcpResult, instructionsResult] = await Promise.all([
      discoverSkills(projectPath).catch((error) => {
        errors.push({
          source: "skills",
          message: error instanceof Error ? error.message : String(error),
        });
        return { skills: [], errors: [] };
      }),
      discoverPlugins(homedir(), errors).catch((error) => {
        errors.push({
          source: "plugins",
          message: error instanceof Error ? error.message : String(error),
        });
        const empty: PluginEntry[] = [];
        return empty;
      }),
      discoverMcpServers(firstPath).catch((error) => {
        errors.push({
          source: "mcp",
          message: error instanceof Error ? error.message : String(error),
        });
        return { servers: [], errors: [] };
      }),
      discoverInstructions(firstPath).catch((error) => {
        errors.push({
          source: "instructions",
          message: error instanceof Error ? error.message : String(error),
        });
        return { instructions: [], errors: [] };
      }),
    ]);
    const plugins = Array.isArray(pluginsResult) ? pluginsResult : [];

    const inventory: AgentInventory = {
      scannedAt: Date.now(),
      projectPath: firstPath,
      skills: skillsResult.skills,
      plugins,
      mcpServers: mcpResult.servers,
      instructions: instructionsResult.instructions,
      errors: [...errors, ...skillsResult.errors, ...mcpResult.errors, ...instructionsResult.errors],
    };

    cache.set(key, { at: Date.now(), inventory });
    return inventory;
  })();

  inflight.set(key, scan);
  try {
    return await scan;
  } finally {
    inflight.delete(key);
  }
}

/** Test-only escape hatch — never called from product code. */
export function clearAgentInventoryCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
