import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { createKeyedSingleFlightCache } from "../singleFlightCache.js";
import { git } from "./core.js";
import type { GitProjectFile } from "./types.js";

const MAX_RESULTS = 80;
const MAX_WALKED_FILES = 10_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".nuxt",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const INDEX_TTL_MS = 8_000;
const INDEX_MAX_KEYS = 8;

const fileIndex = createKeyedSingleFlightCache<string[]>({
  ttlMs: INDEX_TTL_MS,
  maxEntries: INDEX_MAX_KEYS,
});

function toProjectFile(relativePath: string): GitProjectFile | null {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) return null;
  const separator = normalized.lastIndexOf("/");
  return {
    path: normalized,
    name: separator === -1 ? normalized : normalized.slice(separator + 1),
    parent: separator === -1 ? "" : normalized.slice(0, separator),
  };
}

function rankFile(file: GitProjectFile, query: string): number {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const pathValue = file.path.toLowerCase();
  const nameValue = file.name.toLowerCase();
  if (nameValue === needle) return 0;
  if (nameValue.startsWith(needle)) return 1;
  if (pathValue.startsWith(needle)) return 2;
  if (nameValue.includes(needle)) return 3;
  if (pathValue.includes(needle)) return 4;
  return Number.POSITIVE_INFINITY;
}

function selectFiles(paths: Iterable<string>, queryInput: string): GitProjectFile[] {
  const query = queryInput.trim().replaceAll("\\", "/").toLowerCase();
  const queryLeaf = query.slice(query.lastIndexOf("/") + 1);
  const includeDotfiles = queryLeaf.startsWith(".");
  const seen = new Set<string>();
  const files: GitProjectFile[] = [];

  for (const rawPath of paths) {
    const file = toProjectFile(rawPath);
    if (!file || seen.has(file.path)) continue;
    if (!includeDotfiles && file.path.split("/").some((part) => part.startsWith("."))) continue;
    seen.add(file.path);
    const rank = rankFile(file, query);
    if (rank !== Number.POSITIVE_INFINITY) files.push(file);
  }

  files.sort((left, right) => {
    const rankDiff = rankFile(left, query) - rankFile(right, query);
    return rankDiff || left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  });
  return files.slice(0, MAX_RESULTS);
}

async function walkProjectFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];

  while (pending.length > 0 && result.length < MAX_WALKED_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolute);
      } else if (entry.isFile()) {
        result.push(path.relative(root, absolute));
        if (result.length >= MAX_WALKED_FILES) break;
      }
    }
  }

  return result;
}

async function loadPaths(root: string): Promise<string[]> {
  try {
    const output = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    return output.split("\0").filter((p) => p.length > 0);
  } catch {
    return walkProjectFiles(root);
  }
}

/** Canonical folder for the index map. `path.resolve` keeps a symlink and its
 *  target as two keys, so a watcher that learned the real path would miss the
 *  listing the picker populated from the path the renderer sent. */
function indexKey(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** List project files for the composer mention picker. Git's tracked +
 * non-ignored untracked view is preferred; plain folders still work through a
 * bounded filesystem walk.
 *
 * The path list is cached per resolved root (8s, bounded to 8 roots), so typing
 * successive queries in one project walks the tree once and filters in memory.
 * Call invalidateFileIndex after a working-tree or index change that may have
 * added or removed files so the next search sees them. */
export async function files(dir: string, query = ""): Promise<GitProjectFile[]> {
  const root = indexKey(dir);
  const paths = await fileIndex.get(root, () => loadPaths(root));
  return selectFiles(paths, query);
}

/** Drop the cached path list for `dir` so the next files() rebuilds from disk.
 *  Call when the working tree or index may have gained or lost files. */
export function invalidateFileIndex(dir: string): void {
  fileIndex.invalidate(indexKey(dir));
}

/** Drop every cached listing. Tests use this so one case cannot leak into the next. */
export function resetFileIndexForTests(): void {
  fileIndex.invalidateAll();
}
