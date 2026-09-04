// FILE: skills.ts
// Purpose: read-only cross-CLI skills inventory for the Agents page. Scans
// global + project roots for each provider we offer (claude/codex/cursor/
// opencode/agents/factory) — single-level, no ancestor walk, no plugin scan.
// Dedupes by name so the page shows one merged list; losers recorded as
// `shadowedBy`. Never writes anything. Exports: discoverSkills

import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import type { InventoryError, PluginEntry, SkillEntry } from "./types.js";

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES_PER_DIR = 500;
const MAX_BFS_DEPTH = 4;
const MAX_PROJECT_ANCESTORS = 1;
// A pathological number of same-named copies must not make the payload
// unbounded — eight is more than any real skill has ever had.
const MAX_SHADOWED_COPIES = 8;

// v1 stable uses claude + agents only (t3 parity: .claude/skills + .agents/skills).
// Other origins (codex/cursor/factory/opencode) deferred to v2 — type kept wide
// so the deferred plugin scanners still typecheck while unused.
type SkillOrigin = "claude" | "codex" | "opencode" | "cursor" | "factory" | "agents";

type SkillRoot = {
  readonly dir: string;
  readonly origin: SkillOrigin;
  readonly scope: "user" | "project";
};

export type SkillRootTarget = SkillRoot & { readonly exists: boolean };

// The user/global roots kone scans across installed agent providers.
// Per online docs 2026 + Synara parity:
// - Claude Code: ~/.claude/skills (global) + plugin cache ~/.claude/plugins/cache
// - Codex CLI: ~/.codex/skills (global, includes .system)
// - Cursor: ~/.cursor/skills + legacy ~/.cursor/skills-cursor (global)
// - OpenCode: ~/.config/opencode/skills (primary) plus compat ~/.claude/skills, ~/.agents/skills
// - Shared: ~/.agents/skills
// - Factory/Droid: ~/.factory/skills
function userSkillRoots(home: string): SkillRoot[] {
  return [
    { dir: path.join(home, ".claude", "skills"), origin: "claude", scope: "user" },
    { dir: path.join(home, ".codex", "skills"), origin: "codex", scope: "user" },
    { dir: path.join(home, ".cursor", "skills"), origin: "cursor", scope: "user" },
    { dir: path.join(home, ".cursor", "skills-cursor"), origin: "cursor", scope: "user" },
    { dir: path.join(home, ".config", "opencode", "skills"), origin: "opencode", scope: "user" },
    { dir: path.join(home, ".agents", "skills"), origin: "agents", scope: "user" },
    { dir: path.join(home, ".factory", "skills"), origin: "factory", scope: "user" },
  ];
}

const PROJECT_SKILL_DIRS: ReadonlyArray<{ dirName: string; origin: SkillOrigin }> = [
  { dirName: ".claude", origin: "claude" },
  { dirName: ".codex", origin: "codex" },
  { dirName: ".cursor", origin: "cursor" },
  { dirName: ".opencode", origin: "opencode" },
  { dirName: ".agents", origin: "agents" },
  { dirName: ".factory", origin: "factory" },
];

/** A root that cannot be stat'd is one nothing has been written into yet, which
 *  is the same answer as absent as far as offering it goes. */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

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

// A `metadata:` value can carry the author inline as a subkey
// (`metadata: author: Somebody`); metadataSubkey plucks it out of the
// comma/semicolon/newline-separated list.
function metadataSubkey(value: string, key: string): string {
  const match = new RegExp(`(?:^|[,\n;])\\s*${key}\\s*:\\s*([^,\n;]+)`).exec(value);
  return match?.[1]?.trim() ?? "";
}

function readSkillAuthor(frontmatter: Record<string, string>): string | null {
  const direct = readAliasField(frontmatter, ["author", "metadata.author"]);
  if (direct) return direct;
  const metadata = readAliasField(frontmatter, ["metadata"]);
  if (!metadata) return null;
  return metadataSubkey(metadata, "author") || null;
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

  // Frontmatter parses to strings only (frontmatter.ts's contract) — the
  // boolean coercion happens here, and only "true" counts.
  const manualInvocation = readAliasField(frontmatter, ["disable-model-invocation", "disableModelInvocation"]);

  // System-bundled skills live under a `.system` segment (e.g. ~/.codex/skills/.system/…)
  // — mark them as system-owned regardless of which root they were found under.
  const effectiveScope = skillMdPath.includes("/.system/") ? "system" as const : scope;

  return {
    name,
    description,
    path: skillMdPath,
    directory,
    origin,
    scope: effectiveScope,
    displayName: readAliasField(frontmatter, ["display-name", "displayName", "title"]),
    shortDescription: readAliasField(frontmatter, ["short-description", "shortDescription", "summary"]),
    author: readSkillAuthor(frontmatter),
    modifiedAt: info.mtimeMs,
    shadowedBy: [],
    manualOnly: manualInvocation?.toLowerCase() === "true",
    enabled: true,
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
        errors.push({
          source: `skills:${root.origin}:${root.dir}`,
          message: error instanceof Error ? error.message : String(error),
        });
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

// One decoded value from a parsed plugin manifest (installed_plugins.json,
// known_marketplaces.json, marketplace.json); none of those shapes is a
// published contract, so every helper below branches on these domain values
// instead of interrogating representations.
type PluginManifestValue = string | number | boolean | null | PluginManifestValue[] | { [key: string]: PluginManifestValue };

type PluginManifestRecord = { [key: string]: PluginManifestValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isManifestNumber(value: PluginManifestValue | undefined): value is number {
  return Number.isFinite(value);
}

/** Text is the one manifest variant left after every other variant is excluded
 *  by value — booleans by identity, numbers by finiteness, composites by
 *  their constructors. */
function manifestText(value: PluginManifestValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isManifestNumber(value)) return null;
  return value;
}

function isManifestRecord(value: PluginManifestValue | undefined): value is PluginManifestRecord {
  return value instanceof Object && !Array.isArray(value);
}

type InstalledPlugin = { name?: string; installPath?: string };

function extractInstalledPlugins(manifest: PluginManifestValue | undefined): InstalledPlugin[] {
  if (Array.isArray(manifest)) {
    return manifest
      .filter((item): item is PluginManifestRecord => isManifestRecord(item))
      .map((item) => ({
        name: manifestText(item.name) ?? undefined,
        installPath: manifestText(item.path) ?? manifestText(item.installPath) ?? undefined,
      }));
  }
  if (isManifestRecord(manifest)) {
    return Object.entries(manifest).map(([key, value]) => {
      const direct = manifestText(value);
      if (direct !== null) return { name: key, installPath: direct };
      if (isManifestRecord(value)) {
        return { name: key, installPath: manifestText(value.path) ?? manifestText(value.installPath) ?? undefined };
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

// v2: plugin scan deferred — kept for restoration, not called in v1 stable.
export async function readClaudePluginSkills(home: string): Promise<SkillEntry[]> {
  const pluginsDir = path.join(home, ".claude", "plugins");
  const manifestPath = path.join(pluginsDir, "installed_plugins.json");

  let info;
  try {
    info = await stat(manifestPath);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return [];

  let manifest: PluginManifestValue | undefined;
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

export async function readFactoryPluginSkills(home: string): Promise<SkillEntry[]> {
  const factoryDir = path.join(home, ".factory");
  const marketplacesManifest = path.join(factoryDir, "plugins", "known_marketplaces.json");

  let info;
  try {
    info = await stat(marketplacesManifest);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return [];

  let known: PluginManifestValue | undefined;
  try {
    known = JSON.parse(await readFile(marketplacesManifest, "utf8"));
  } catch {
    return [];
  }
  if (!isManifestRecord(known)) return [];

  const factoryRealRoot = await realpath(factoryDir).catch(() => factoryDir);

  const perMarketplace = await Promise.all(
    Object.entries(known).map(async ([, reg]) => {
      if (!isManifestRecord(reg)) return [];
      const installLocation = manifestText(reg.installLocation)?.trim();
      if (!installLocation) return [];

      const marketplaceDir = path.resolve(factoryDir, installLocation.trim());
      const marketplaceRealDir = await realpath(marketplaceDir).catch(() => null);
      if (!marketplaceRealDir || !isContainedIn(marketplaceRealDir, factoryRealRoot)) return [];

      const manifestPath = path.join(marketplaceRealDir, ".factory-plugin", "marketplace.json");
      let manifestRaw: string;
      try {
        manifestRaw = await readFile(manifestPath, "utf8");
      } catch {
        return [];
      }

      let manifest: PluginManifestValue | undefined;
      try {
        manifest = JSON.parse(manifestRaw);
      } catch {
        return [];
      }
      if (!isManifestRecord(manifest) || !Array.isArray(manifest.plugins)) {
        return [];
      }

      const plugins = manifest.plugins.filter((item): item is PluginManifestRecord => isManifestRecord(item));
      const perPlugin = await Promise.all(
        plugins.map(async (plugin) => {
          const source = manifestText(plugin.source)?.trim() ?? null;
          const pluginName = manifestText(plugin.name)?.trim() ?? null;
          if (!source || !pluginName) return [];

          const pluginDir = path.resolve(marketplaceRealDir, source);
          const pluginRealDir = await realpath(pluginDir).catch(() => null);
          if (!pluginRealDir || !isContainedIn(pluginRealDir, marketplaceRealDir)) return [];

          const skillsDir = path.join(pluginRealDir, "skills");
          const resolvedSkillsDir = await realpath(skillsDir).catch(() => null);
          if (!resolvedSkillsDir || !isContainedIn(resolvedSkillsDir, marketplaceRealDir)) return [];

          const skillPaths = await collectSkillMarkdownPaths(skillsDir);
          const entries = await Promise.all(
            skillPaths.map(async (skillPath) => {
              const entry = await readSkillEntry(skillPath, "factory", "plugin");
              if (!entry) return null;
              return { ...entry, name: `${pluginName}:${entry.name}` };
            }),
          );
          return entries.filter((entry): entry is SkillEntry => entry !== null);
        }),
      );
      return perPlugin.flat();
    }),
  );

  return perMarketplace.flat();
}

export async function discoverClaudePlugins(home: string): Promise<PluginEntry[]> {
  const pluginsDir = path.join(home, ".claude", "plugins");
  const manifestPath = path.join(pluginsDir, "installed_plugins.json");
  let info;
  try {
    info = await stat(manifestPath);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return [];
  let manifest: PluginManifestValue | undefined;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const pluginsRealRoot = await realpath(pluginsDir).catch(() => pluginsDir);
  const plugins = extractInstalledPlugins(manifest);
  const entries = await Promise.all(
    plugins.map(async (plugin) => {
      if (!plugin.installPath) return null;
      const skillsDir = path.join(plugin.installPath, "skills");
      const resolvedSkillsDir = await realpath(skillsDir).catch(() => null);
      if (!resolvedSkillsDir || !isContainedIn(resolvedSkillsDir, pluginsRealRoot)) return null;
      const skillPaths = await collectSkillMarkdownPaths(skillsDir);
      const skills = (
        await Promise.all(skillPaths.map((p) => readSkillEntry(p, "claude", "plugin")))
      ).filter((e): e is SkillEntry => e !== null);
      if (skills.length === 0) return null;
      const name = plugin.name ?? path.basename(plugin.installPath ?? "");
      const entry: PluginEntry = {
        name,
        description: null,
        path: plugin.installPath,
        origin: "claude",
        scope: "plugin",
        skills,
      };
      return entry;
    }),
  );
  return entries.filter((e): e is PluginEntry => e !== null);
}

export async function discoverFactoryPlugins(home: string): Promise<PluginEntry[]> {
  const factoryDir = path.join(home, ".factory");
  const marketplacesManifest = path.join(factoryDir, "plugins", "known_marketplaces.json");
  let info;
  try {
    info = await stat(marketplacesManifest);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return [];
  let known: PluginManifestValue | undefined;
  try {
    known = JSON.parse(await readFile(marketplacesManifest, "utf8"));
  } catch {
    return [];
  }
  if (!isManifestRecord(known)) return [];
  const factoryRealRoot = await realpath(factoryDir).catch(() => factoryDir);
  const perMarketplace = await Promise.all(
    Object.entries(known).map(async ([, reg]) => {
      if (!isManifestRecord(reg)) return [];
      const installLocation = manifestText(reg.installLocation)?.trim();
      if (!installLocation) return [];
      const marketplaceDir = path.resolve(factoryDir, installLocation.trim());
      const marketplaceRealDir = await realpath(marketplaceDir).catch(() => null);
      if (!marketplaceRealDir || !isContainedIn(marketplaceRealDir, factoryRealRoot)) return [];
      const manifestPath = path.join(marketplaceRealDir, ".factory-plugin", "marketplace.json");
      let manifestRaw: string;
      try {
        manifestRaw = await readFile(manifestPath, "utf8");
      } catch {
        return [];
      }
      let manifest: PluginManifestValue | undefined;
      try {
        manifest = JSON.parse(manifestRaw);
      } catch {
        return [];
      }
      if (!isManifestRecord(manifest) || !Array.isArray(manifest.plugins)) return [];
      const plugins = manifest.plugins.filter((item): item is PluginManifestRecord => isManifestRecord(item));
      const perPlugin = await Promise.all(
        plugins.map(async (plugin) => {
          const source = manifestText(plugin.source)?.trim() ?? null;
          const pluginName = manifestText(plugin.name)?.trim() ?? null;
          if (!source || !pluginName) return null;
          const pluginDir = path.resolve(marketplaceRealDir, source);
          const pluginRealDir = await realpath(pluginDir).catch(() => null);
          if (!pluginRealDir || !isContainedIn(pluginRealDir, marketplaceRealDir)) return null;
          const skillsDir = path.join(pluginRealDir, "skills");
          const resolvedSkillsDir = await realpath(skillsDir).catch(() => null);
          if (!resolvedSkillsDir || !isContainedIn(resolvedSkillsDir, marketplaceRealDir)) return null;
          const skillPaths = await collectSkillMarkdownPaths(skillsDir);
          const skills = (
            await Promise.all(skillPaths.map((p) => readSkillEntry(p, "factory", "plugin")))
          ).filter((e): e is SkillEntry => e !== null);
          if (skills.length === 0) return null;
          const entry: PluginEntry = {
            name: pluginName,
            description: manifestText(plugin.description) ?? null,
            path: pluginRealDir,
            origin: "factory",
            scope: "plugin",
            skills,
          };
          return entry;
        }),
      );
      return perPlugin.filter((e): e is PluginEntry => e !== null);
    }),
  );
  return perMarketplace.flat();
}

export async function discoverClaudeCachePlugins(home: string): Promise<PluginEntry[]> {
  const cacheDir = path.join(home, ".claude", "plugins", "cache");
  let entries: Dirent[];
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cacheReal = await realpath(cacheDir).catch(() => cacheDir);
  const byName = new Map<string, PluginEntry>();
  for (const entry of entries) {
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path.join(cacheDir, entry.name)).then((s) => s.isDirectory()).catch(() => false)));
    if (!isDir) continue;
    const pluginGroupDir = path.join(cacheDir, entry.name);
    let subEntries: Dirent[];
    try {
      subEntries = await readdir(pluginGroupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      const subIsDir = sub.isDirectory() || (sub.isSymbolicLink() && (await stat(path.join(pluginGroupDir, sub.name)).then((s) => s.isDirectory()).catch(() => false)));
      if (!subIsDir) continue;
      const pluginName = sub.name;
      const pluginBase = path.join(pluginGroupDir, pluginName);
      let versions: Dirent[];
      try {
        versions = await readdir(pluginBase, { withFileTypes: true });
      } catch {
        continue;
      }
      // keep only the latest version (lexicographically last) to avoid duplicate cards for same plugin
      const versionDirs = versions.filter((v) => v.isDirectory() || v.isSymbolicLink());
      if (versionDirs.length === 0) continue;
      // pick last sorted by name (semver-ish)
      versionDirs.sort((a, b) => a.name.localeCompare(b.name));
      const latest = versionDirs[versionDirs.length - 1]!;
      const versionDir = path.join(pluginBase, latest.name);
      const skillsDir = path.join(versionDir, "skills");
      const resolvedSkillsDir = await realpath(skillsDir).catch(() => null);
      if (!resolvedSkillsDir || !isContainedIn(resolvedSkillsDir, cacheReal)) continue;
      const skillPaths = await collectSkillMarkdownPaths(skillsDir);
      const skills = (await Promise.all(skillPaths.map((p) => readSkillEntry(p, "claude", "plugin")))).filter((e): e is SkillEntry => e !== null);
      if (skills.length === 0) continue;
      // dedupe by plugin name — keep the one with more skills (latest version)
      const existing = byName.get(pluginName);
      if (!existing || skills.length > existing.skills.length) {
        byName.set(pluginName, {
          name: pluginName,
          description: null,
          path: versionDir,
          origin: "claude",
          scope: "plugin",
          skills,
        });
      }
    }
  }
  return [...byName.values()];
}

export async function discoverPlugins(home: string, errors: InventoryError[]): Promise<PluginEntry[]> {
  const out: PluginEntry[] = [];
  try {
    out.push(...(await discoverClaudePlugins(home)));
  } catch (error) {
    errors.push({ source: "plugins:claude", message: error instanceof Error ? error.message : String(error) });
  }
  try {
    out.push(...(await discoverFactoryPlugins(home)));
  } catch (error) {
    errors.push({ source: "plugins:factory", message: error instanceof Error ? error.message : String(error) });
  }
  try {
    out.push(...(await discoverClaudeCachePlugins(home)));
  } catch (error) {
    errors.push({ source: "plugins:cache", message: error instanceof Error ? error.message : String(error) });
  }
  return out;
}

/** Scans every known skills root — user/global plus the project's ancestor
 *  chain, plus plugin skills — and dedupes by lowercased name.
 *
 *  Precedence mirrors the documented enterprise > personal > project rule: user
 *  roots win first, then plugin skills, then project roots — so a
 *  repo-committed `.claude/skills/x` can never silently shadow something the
 *  user already keeps for themselves in `~/.claude/skills/x`.
 *
 *  A copy that loses the contest is still a real, findable path — it is
 *  recorded on the winner's `shadowedBy` (encounter order, nearest loser
 *  first, capped) rather than dropped, so the UI can show every place a name
 *  lives and offer to clean the shadowed ones up.
 *
 *  Every individual root's failure (missing dir, EACCES, ...) is caught into
 *  `errors` — this function never rejects. */

/** Where a new skill could be written. The scan reports what exists; this
 *  reports where something could be put, which is a different question and the
 *  only one an "add a skill" flow can be answered with — a machine with no
 *  skills at all still has folders each CLI would read.
 *
 *  A root that does not exist yet is still offered, marked `exists: false`;
 *  creating it is what writing the first skill into it means. Never rejects. */
function normalizeProjectPaths(input: string | string[] | null): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((p) => p.length > 0).map((p) => path.resolve(p));
  return [path.resolve(input)];
}

export async function skillRootTargets(
  projectPath: string | string[] | null,
): Promise<SkillRootTarget[]> {
  const home = homedir();
  const targets: SkillRootTarget[] = [];

  const userRoots = userSkillRoots(home);
  // Cursor has two differently-named global dirs (skills vs skills-cursor) — offer only one
  const cursorRoots = userRoots.filter((r) => r.origin === "cursor");
  let cursorPick = cursorRoots[0];
  for (const r of cursorRoots) {
    if (await directoryExists(r.dir)) {
      cursorPick = r;
      break;
    }
  }
  for (const root of userRoots) {
    if (root.origin === "cursor" && root.dir !== cursorPick?.dir) continue;
    targets.push({ ...root, exists: await directoryExists(root.dir) });
  }

  for (const proj of normalizeProjectPaths(projectPath)) {
    for (const { dirName, origin } of PROJECT_SKILL_DIRS) {
      const dir = path.join(proj, dirName, "skills");
      targets.push({ dir, origin, scope: "project", exists: await directoryExists(dir) });
    }
  }

  return targets;
}

export async function discoverSkills(
  projectPath: string | string[] | null,
): Promise<{
  skills: SkillEntry[];
  shadowed: SkillEntry[];
  errors: InventoryError[];
}> {
  const home = homedir();
  const errors: InventoryError[] = [];

  const projectPaths = normalizeProjectPaths(projectPath);
  const projectRoots = projectPaths.flatMap((p) => projectSkillRoots(p));

  const [userSkills, projectSkills] = await Promise.all([
    scanRoots(userSkillRoots(home), errors),
    projectRoots.length ? scanRoots(projectRoots, errors) : Promise.resolve<SkillEntry[]>([]),
  ]);

  // v1 stable: no plugin scan.
  const pluginSkills: SkillEntry[] = [];

  const ordered = [...userSkills, ...pluginSkills, ...projectSkills];
  const byName = new Map<string, { winner: SkillEntry; shadowed: SkillEntry[] }>();
  const seenPaths = new Set<string>();

  for (const skill of ordered) {
    if (seenPaths.has(skill.path)) continue;
    seenPaths.add(skill.path);

    const key = skill.name.toLowerCase();
    const group = byName.get(key);
    if (!group) {
      byName.set(key, { winner: skill, shadowed: [] });
      continue;
    }
    // The loser is recorded on the winner in encounter order — nearest loser
    // first, since project roots walk nearest-ancestor first — so the UI can
    // point at exactly which copy lost. A copy at the winner's own path *is*
    // the winner (a root can legitimately resolve to it twice), so it never
    // shadows itself.
    if (group.winner.shadowedBy.length < MAX_SHADOWED_COPIES && skill.path !== group.winner.path) {
      group.winner.shadowedBy.push({ origin: skill.origin, scope: skill.scope, path: skill.path });
    }
    skill.shadowed = true;
    skill.shadowedByWinner = {
      origin: group.winner.origin,
      scope: group.winner.scope,
      path: group.winner.path,
    };
    group.shadowed.push(skill);
  }

  // `skills` is always the winners-only list (stable cardinality); every
  // losing copy is returned separately in `shadowed` so callers that render
  // all copies can merge without a mode flag.
  const skills = [...byName.values()].map((g) => g.winner);
  const shadowed = [...byName.values()].flatMap((g) => g.shadowed);

  return { skills, shadowed, errors };
}
