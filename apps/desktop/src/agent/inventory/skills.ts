// FILE: skills.ts
// Purpose: read-only cross-CLI skills inventory for the Agents page. Walks
// every known "skills" root — five user/global home-dir roots plus the
// project's ancestor chain — for directories that directly contain a
// SKILL.md, parses their frontmatter, and dedupes by name so the page shows
// one merged list instead of five per-CLI ones.
// skillsCatalog.ts (SKILL_ORIGIN_ROOTS multi-origin scan, BFS-to-depth-2 skill
// detection, alias-tolerant frontmatter reads, origin-preference dedup, the
// Claude-plugin realpath containment check) — see docs/skills-mcp-research.md
// §3 for the exact discovery-root matrix this follows. Never writes anything.
// Exports: discoverSkills

import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import type { InventoryError, SkillEntry } from "./types.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES_PER_DIR = 500;
const MAX_BFS_DEPTH = 2;
const MAX_PROJECT_ANCESTORS = 25;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SkillOrigin = "claude" | "codex" | "opencode" | "cursor" | "agents";

type SkillRoot = {
  readonly dir: string;
  readonly origin: SkillOrigin;
  readonly scope: "user" | "project";
};

// The five user/global roots kone scans today (docs/skills-mcp-research.md §3).
function userSkillRoots(home: string): SkillRoot[] {
  return [
    { dir: path.join(home, ".claude", "skills"), origin: "claude", scope: "user" },
    { dir: path.join(home, ".codex", "skills"), origin: "codex", scope: "user" },
    { dir: path.join(home, ".cursor", "skills"), origin: "cursor", scope: "user" },
    { dir: path.join(home, ".config", "opencode", "skills"), origin: "opencode", scope: "user" },
    { dir: path.join(home, ".agents", "skills"), origin: "agents", scope: "user" },
  ];
}

const PROJECT_SKILL_DIRS: ReadonlyArray<{ dirName: string; origin: SkillOrigin }> = [
  { dirName: ".claude", origin: "claude" },
  { dirName: ".opencode", origin: "opencode" },
  { dirName: ".cursor", origin: "cursor" },
  { dirName: ".codex", origin: "codex" },
  { dirName: ".agents", origin: "agents" },
];

function projectAncestors(projectPath: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(projectPath);
  while (ancestors.length < MAX_PROJECT_ANCESTORS) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

// Project skill folders, nearest-ancestor first: the project's own
// `.claude/skills` (etc) is listed before the same folder name several
// directories up (a monorepo root), for a stable dedup order.
function projectSkillRoots(projectPath: string): SkillRoot[] {
  return projectAncestors(projectPath).flatMap((ancestor) =>
    PROJECT_SKILL_DIRS.map(({ dirName, origin }) => ({
      dir: path.join(ancestor, dirName, "skills"),
      origin,
      scope: "project" as const,
    })),
  );
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Fan-out cap: a huge/odd directory can't make one root's scan hang.
    return entries.slice(0, MAX_ENTRIES_PER_DIR);
  } catch {
    return [];
  }
}

async function isWalkableDirectory(parentDir: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(parentDir, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

// A directory IS a skill when it directly contains SKILL.md. BFS to depth 2
// so a namespaced layout (`skills/vendor/tool-name/SKILL.md`) is still found,
// while a pathologically deep tree can't make the scan hang.
async function collectSkillMarkdownPaths(rootDir: string): Promise<string[]> {
  async function visit(dir: string, depth: number): Promise<string[]> {
    try {
      const skillMdPath = path.join(dir, "SKILL.md");
      const info = await stat(skillMdPath);
      if (info.isFile()) return [skillMdPath];
    } catch {
      // Not a skill directory itself — keep walking if depth allows.
    }
    if (depth >= MAX_BFS_DEPTH) return [];

    const entries = await readdirOrEmpty(dir);
    const subdirNames = (
      await Promise.all(
        entries.map(async (entry) => ({ name: entry.name, isDir: await isWalkableDirectory(dir, entry) })),
      )
    )
      .filter((entry) => entry.isDir)
      .map((entry) => entry.name);

    const nested = await Promise.all(subdirNames.map((name) => visit(path.join(dir, name), depth + 1)));
    return nested.flat();
  }
  return visit(rootDir, 0);
}

function readAliasField(frontmatter: Record<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = frontmatter[key]?.trim();
    if (value) return value;
  }
  return null;
}

async function readSkillEntry(
  skillMdPath: string,
  origin: string,
  scope: SkillEntry["scope"],
): Promise<SkillEntry | null> {
  let info;
  try {
    info = await stat(skillMdPath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;

  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  const directory = path.dirname(skillMdPath);
  const name = frontmatter.name?.trim() || path.basename(directory);
  const description = frontmatter.description?.trim() || null;

  return {
    name,
    description,
    path: skillMdPath,
    directory,
    origin,
    scope,
    displayName: readAliasField(frontmatter, ["display-name", "displayName", "title"]),
    shortDescription: readAliasField(frontmatter, ["short-description", "shortDescription", "summary"]),
  };
}

async function scanRoots(roots: readonly SkillRoot[], errors: InventoryError[]): Promise<SkillEntry[]> {
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      try {
        const skillPaths = await collectSkillMarkdownPaths(root.dir);
        const entries = await Promise.all(skillPaths.map((skillPath) => readSkillEntry(skillPath, root.origin, root.scope)));
        return entries.filter((entry): entry is SkillEntry => entry !== null);
      } catch (error) {
        errors.push({ source: `skills:${root.origin}:${root.dir}`, message: errorMessage(error) });
        return [];
      }
    }),
  );
  return perRoot.flat();
}

// ── Claude plugin skills ─────────────────────────────────────────────────────
// Claude Code plugins can ship their own `skills/` folder; the installed set
// is recorded in `~/.claude/plugins/installed_plugins.json`. That file's
// shape isn't a published contract, so this reads it defensively (array or
// object-map form) and realpath-checks every plugin path so a malformed or
// hostile manifest entry can't walk the scan outside the plugins directory.

type InstalledPlugin = { name?: string; installPath?: string };

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractInstalledPlugins(manifest: unknown): InstalledPlugin[] {
  if (Array.isArray(manifest)) {
    return manifest
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        name: readOptionalString(item.name),
        installPath: readOptionalString(item.path) ?? readOptionalString(item.installPath),
      }));
  }
  if (manifest && typeof manifest === "object") {
    return Object.entries(manifest as Record<string, unknown>).map(([key, value]) => {
      if (typeof value === "string") return { name: key, installPath: value };
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return { name: key, installPath: readOptionalString(record.path) ?? readOptionalString(record.installPath) };
      }
      return { name: key };
    });
  }
  return [];
}

function isContainedIn(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readClaudePluginSkills(home: string): Promise<SkillEntry[]> {
  const pluginsDir = path.join(home, ".claude", "plugins");
  const manifestPath = path.join(pluginsDir, "installed_plugins.json");

  let info;
  try {
    info = await stat(manifestPath);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return [];
  }

  const pluginsRealRoot = await realpath(pluginsDir).catch(() => pluginsDir);
  const plugins = extractInstalledPlugins(manifest);

  const perPlugin = await Promise.all(
    plugins.map(async (plugin) => {
      if (!plugin.installPath) return [];
      const skillsDir = path.join(plugin.installPath, "skills");
      const resolvedSkillsDir = await realpath(skillsDir).catch(() => null);
      if (!resolvedSkillsDir || !isContainedIn(resolvedSkillsDir, pluginsRealRoot)) return [];

      const skillPaths = await collectSkillMarkdownPaths(skillsDir);
      const entries = await Promise.all(
        skillPaths.map(async (skillPath) => {
          const entry = await readSkillEntry(skillPath, "claude", "plugin");
          if (!entry) return null;
          const pluginId = plugin.name ?? path.basename(plugin.installPath ?? "");
          return { ...entry, name: `${pluginId}:${entry.name}` };
        }),
      );
      return entries.filter((entry): entry is SkillEntry => entry !== null);
    }),
  );
  return perPlugin.flat();
}

/** Scans every known skills root — user/global plus the project's ancestor
 *  chain, plus Claude plugin skills — and dedupes by lowercased name.
 *
 *  Precedence mirrors Claude Code's own documented rule
 *  (docs/skills-mcp-research.md §3: "enterprise > personal > project"): user
 *  roots win first, then plugin skills, then project roots — so a
 *  repo-committed `.claude/skills/x` can never silently shadow something the
 *  user already keeps for themselves in `~/.claude/skills/x`.
 *
 *  Every individual root's failure (missing dir, EACCES, ...) is caught into
 *  `errors` — this function never rejects. */
export async function discoverSkills(projectPath: string | null): Promise<{
  skills: SkillEntry[];
  errors: InventoryError[];
}> {
  const home = homedir();
  const errors: InventoryError[] = [];

  const [userSkills, projectSkills] = await Promise.all([
    scanRoots(userSkillRoots(home), errors),
    projectPath ? scanRoots(projectSkillRoots(projectPath), errors) : Promise.resolve([]),
  ]);

  let pluginSkills: SkillEntry[] = [];
  try {
    pluginSkills = await readClaudePluginSkills(home);
  } catch (error) {
    errors.push({ source: "skills:claude-plugins", message: errorMessage(error) });
  }

  const ordered = [...userSkills, ...pluginSkills, ...projectSkills];
  const byName = new Map<string, SkillEntry>();
  for (const skill of ordered) {
    const key = skill.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, skill);
  }

  return { skills: [...byName.values()], errors };
}
