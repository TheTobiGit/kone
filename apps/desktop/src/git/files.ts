import { readdir } from "node:fs/promises";
import path from "node:path";

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

/** List project files for the composer mention picker. Git's tracked +
 * non-ignored untracked view is preferred; plain folders still work through a
 * bounded filesystem walk. */
export async function files(dir: string, query = ""): Promise<GitProjectFile[]> {
  const root = path.resolve(dir);
  try {
    const output = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    return selectFiles(output.split("\0"), query);
  } catch {
    return selectFiles(await walkProjectFiles(root), query);
  }
}
