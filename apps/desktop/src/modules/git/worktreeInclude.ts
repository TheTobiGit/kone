import { constants } from "node:fs";
import { cp, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { git, pathExists } from "@kone/git-core/core.js";

// Bringing a project's private files into a fresh worktree.
//
// A worktree is a checkout, so it holds what git tracks and nothing else. The
// files a project needs to start but keeps out of git — `.env` above all — are
// exactly the ones missing, and a desk without them fails in ways that look
// like the agent's fault. So a new worktree gets them copied across:
//
//   - every ignored `.env` / `.env.*` file, at any depth, with no setup at all;
//   - anything else the project lists in a `.worktreeinclude` file at its root,
//     written like a `.gitignore` (one pattern per line, `#` comments, `!` to
//     take a match back, a trailing `/` for a directory).
//
// Only IGNORED files are candidates. A file git would track is either already
// in the worktree or is an unsaved change, and bringing unsaved changes along
// is a separate decision the user makes, not a side effect of this one.
//
// Copies are clones where the disk can make them, so a large directory costs
// nothing until one side changes it. Nothing in the worktree is overwritten.
// Best effort throughout: a file that will not copy is a worse desk, not a
// failed one, and the build carries on.

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** What every project gets without a `.worktreeinclude`: its env files. */
const DEFAULT_PATTERNS = [".env", ".env.*"];

export type IncludeRule = Rule;
type Rule = { negate: boolean; dirOnly: boolean; anchored: boolean; regex: RegExp; source: string };

/** One `.gitignore`-style line as a rule, or null for a blank or a comment. */
function parseRule(line: string): Rule | null {
  let text = line.replace(/\s+$/, "");
  if (!text || text.startsWith("#")) return null;
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1);
  }
  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.replace(/\/+$/, "");
  // A slash anywhere but the end ties the pattern to the project root; a bare
  // name matches at any depth, the way `.gitignore` reads it.
  const anchored = text.includes("/");
  text = text.replace(/^\/+/, "");
  if (!text) return null;
  let body = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "*") {
      if (text[i + 1] === "*") {
        // `**/` is any number of directories, including none; a bare `**` is
        // anything at all.
        if (text[i + 2] === "/") {
          body += "(?:.*/)?";
          i += 2;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { negate, dirOnly, anchored, regex: new RegExp(`^${body}$`), source: text };
}

export function parseIncludeRules(text: string): Rule[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const rule = parseRule(line);
    return rule ? [rule] : [];
  });
}

function ruleMatches(rule: Rule, relPath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.anchored) return rule.regex.test(relPath);
  return rule.regex.test(path.posix.basename(relPath));
}

/** Whether a project-relative path is wanted, by the last rule that speaks to
 *  it — the same "last match wins" `.gitignore` uses, so `!` can take one back. */
export function isIncluded(rules: Rule[], relPath: string, isDir: boolean): boolean {
  let wanted = false;
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDir)) wanted = !rule.negate;
  }
  return wanted;
}

/** Whether an ignored directory could hold something a rule names further
 *  down — `config/local/` for a rule on `config/local/*.json`. Only a rule
 *  that spells out a path into the directory opens it; a bare name like `.env`
 *  is not reason enough to walk every ignored cache in the project. */
function mayReachInside(rules: Rule[], dir: string): boolean {
  return rules.some((rule) => !rule.negate && rule.anchored && rule.source.startsWith(`${dir}/`));
}

/** Directories never walked into for a file-level match. Their contents are
 *  regenerated, not configured, and walking them is where the time would go.
 *  A rule that names one of them outright still copies it whole. */
const NEVER_WALK = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".nuxt", ".output", ".venv", "venv", "__pycache__", "coverage"]);
const WALK_LIMIT = 2_000;

/** Whether a directory name is one whose contents a tool regenerates. */
export function isRegeneratedDir(name: string): boolean {
  return NEVER_WALK.has(name);
}

async function walk(root: string, rel: string, out: string[], budget: { left: number }): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) return;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!NEVER_WALK.has(entry.name)) await walk(root, child, out, budget);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
}

/** The project's ignored files and directories, git's own view: a wholly
 *  ignored directory comes back as one `dir/` entry rather than every file in
 *  it, which is what keeps this fast beside a `node_modules`. */
export async function ignoredEntries(project: string): Promise<string[]> {
  const out = await git(project, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  return out.split("\0").filter(Boolean);
}

export async function readIncludeRules(project: string): Promise<Rule[]> {
  const rules = DEFAULT_PATTERNS.flatMap((p) => {
    const rule = parseRule(p);
    return rule ? [rule] : [];
  });
  try {
    const text = await readFile(path.join(project, WORKTREE_INCLUDE_FILE), "utf8");
    rules.push(...parseIncludeRules(text));
  } catch {
    // No list of its own: the env files alone.
  }
  return rules;
}

/** The project-relative paths to bring across, files and whole directories. */
export async function privateFilesToCopy(project: string): Promise<string[]> {
  const rules = await readIncludeRules(project);
  // A set, because git can name one place twice — a directory it collapsed
  // and a path under it — and the walk would find the file both times.
  const picked = new Set<string>();
  for (const entry of await ignoredEntries(project)) {
    const isDir = entry.endsWith("/");
    const rel = isDir ? entry.slice(0, -1) : entry;
    if (isIncluded(rules, rel, isDir)) {
      picked.add(rel);
      continue;
    }
    if (!isDir || NEVER_WALK.has(path.posix.basename(rel)) || !mayReachInside(rules, rel)) continue;
    const files: string[] = [];
    await walk(project, rel, files, { left: WALK_LIMIT });
    for (const file of files) if (isIncluded(rules, file, false)) picked.add(file);
  }
  return [...picked];
}

/**
 * Copy the project's private files into a new worktree. Returns what was
 * copied, project-relative, for the setup steps to name. Never throws.
 */
export async function copyPrivateFiles(project: string, worktree: string): Promise<string[]> {
  let wanted: string[];
  try {
    wanted = await privateFilesToCopy(project);
  } catch (err) {
    console.error("[git] could not list private files for the new worktree:", err);
    return [];
  }
  const copied: string[] = [];
  for (const rel of wanted) {
    const from = path.join(project, rel);
    const to = path.join(worktree, rel);
    try {
      // Something the checkout already put there is the project's own copy.
      if (await pathExists(to)) continue;
      const isDir = (await stat(from)).isDirectory();
      await cp(from, to, {
        recursive: isDir,
        force: false,
        errorOnExist: false,
        preserveTimestamps: true,
        // A clone where the disk supports one, a plain copy where it does not.
        mode: constants.COPYFILE_FICLONE,
      });
      copied.push(rel);
    } catch (err) {
      console.error(`[git] could not copy '${rel}' into the new worktree:`, err);
    }
  }
  return copied;
}
