// Ignore-aware file walking for the ast engine.
//
// Minimal .gitignore support with no new deps: blank lines and # comments
// drop out, a trailing slash marks dir-only, a leading ! negates, and a
// pattern without a slash matches the basename at any depth while one with a
// slash anchors to the .gitignore's own directory. node_modules and .git are
// always skipped on top, at every depth.
//
// The walker only lists candidate files; reading and parsing stay with the
// engine. Visitors always run — walkInto takes a plain callback, never a
// nullable one, so directory walks and glob matches share the single path.

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import { Lang } from "@ast-grep/napi";

import { hasGlobMagic } from "../gateway/paths.js";

export interface AstEngineFs {
  readDirEntries(dir: string): Dirent[];
  readTextFile(filePath: string): string | null;
  statPath(filePath: string): { isFile: boolean; isDirectory: boolean } | null;
  readIgnoreFile(dir: string): string | null;
}

export function defaultFs(): AstEngineFs {
  return {
    readDirEntries(dir: string): Dirent[] {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    },
    readTextFile(filePath: string): string | null {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    statPath(filePath: string): { isFile: boolean; isDirectory: boolean } | null {
      try {
        const info = statSync(filePath);
        return { isFile: info.isFile(), isDirectory: info.isDirectory() };
      } catch {
        return null;
      }
    },
    readIgnoreFile(dir: string): string | null {
      try {
        return readFileSync(path.join(dir, ".gitignore"), "utf8");
      } catch {
        return null;
      }
    },
  };
}

// Per-file language from extension. tsx also covers jsx: the tsx grammar is
// a superset that still parses plain js, while the plain js grammar drops
// ERROR nodes on angle-bracket syntax. Anything else is skipped, never an
// error.
export function langForPath(filePath: string): Lang | null {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return Lang.TypeScript;
    case ".tsx":
    case ".jsx":
      return Lang.Tsx;
    case ".js":
    case ".mjs":
    case ".cjs":
      return Lang.JavaScript;
    default:
      return null;
  }
}

interface IgnoreRule {
  regex: RegExp;
  negate: boolean;
}

function globSource(pattern: string): string {
  // ** crosses separators while * and ? stay inside one segment, and a
  // **/ span also matches zero directories (src/**/*.ts finds src/a.ts).
  // Placeholders survive the escaping and single-star passes that follow.
  const ANY_DIRS = "\u0001";
  const ANY_REST = "\u0000";
  const withDirSpan = pattern.replace(/\*\*\//g, `${ANY_DIRS}/`);
  const withPlaceholders = withDirSpan.replace(/\*\*/g, ANY_REST);
  const escaped = withPlaceholders.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const single = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  const rest = single.replace(new RegExp(ANY_REST, "g"), ".*");
  return rest.replace(new RegExp(`/${ANY_DIRS}/`, "g"), "/(?:.*/)?").replace(new RegExp(`^${ANY_DIRS}/`), "(?:.*/)?");
}

function parseIgnoreText(text: string): Array<{ source: string; dirOnly: boolean; negate: boolean }> {
  const rules: Array<{ source: string; dirOnly: boolean; negate: boolean }> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    let negate = false;
    let pattern = line;
    if (pattern.startsWith("!")) {
      negate = true;
      pattern = pattern.slice(1).trim();
      if (pattern.length === 0) continue;
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern.length === 0) continue;
    rules.push({ source: pattern, dirOnly, negate });
  }
  return rules;
}

function compileIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const parsed of parseIgnoreText(text)) {
    const body = globSource(parsed.source);
    // A slashless pattern floats: it matches the basename at any depth.
    // A slashed one anchors to the .gitignore's directory. Dir-only rules
    // also swallow everything underneath the directory.
    const anchored = parsed.source.includes("/");
    const head = anchored ? "^" : "^(?:.*/)?";
    const tail = parsed.dirOnly ? "(?:/.*)?$" : "$";
    rules.push({ regex: new RegExp(`${head}${body}${tail}`), negate: parsed.negate });
  }
  return rules;
}

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

// The static leading segments of a glob (everything before the first magic
// segment), so a scoped pattern walks only its own subtree.
function staticBaseOfGlob(relativeGlob: string): string {
  const segments = relativeGlob.split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (hasGlobMagic(segment) || segment === "..") break;
    kept.push(segment);
  }
  return kept.join("/");
}

interface AstCompiledGlob {
  regex: RegExp;
  basenameOnly: boolean;
}

function compileGlob(relativeGlob: string): AstCompiledGlob {
  if (!relativeGlob.includes("/")) {
    return { regex: new RegExp(`^${globSource(relativeGlob)}$`), basenameOnly: true };
  }
  return { regex: new RegExp(`^${globSource(relativeGlob)}$`), basenameOnly: false };
}

const ALWAYS_SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export class AstWalker {
  private readonly fs: AstEngineFs;

  constructor(fs: AstEngineFs = defaultFs()) {
    this.fs = fs;
  }

  // Candidate source files under an absolute file, directory, or glob. Globs
  // match workspace-relative paths (a slashless one matches basenames at any
  // depth); unknown extensions never make the list. Missing paths yield an
  // empty list — the caller decides whether that is a refusal.
  collectFiles(requestedAbs: string, projectRoot: string): string[] {
    const relative = posixRelative(projectRoot, requestedAbs);
    if (hasGlobMagic(relative)) return this.collectByGlob(relative, projectRoot);
    const stat = this.fs.statPath(requestedAbs);
    if (stat === null) return [];
    if (stat.isFile) return [requestedAbs];
    if (!stat.isDirectory) return [];
    return this.walkDir(requestedAbs, projectRoot, []);
  }

  private collectByGlob(relativeGlob: string, projectRoot: string): string[] {
    const compiled = compileGlob(relativeGlob);
    const baseRel = staticBaseOfGlob(relativeGlob);
    const baseAbs = baseRel.length > 0 ? path.join(projectRoot, baseRel) : projectRoot;
    const rules = this.rulesDownTo(projectRoot, baseAbs);
    const found: string[] = [];
    const pushIfMatch = (fileAbs: string): void => {
      if (langForPath(fileAbs) === null) return;
      const rel = posixRelative(projectRoot, fileAbs);
      const candidate = compiled.basenameOnly ? path.basename(fileAbs) : rel;
      if (compiled.regex.test(candidate)) found.push(fileAbs);
    };
    const stat = this.fs.statPath(baseAbs);
    if (stat === null) return [];
    if (stat.isFile) {
      pushIfMatch(baseAbs);
      return found;
    }
    if (!stat.isDirectory) return [];
    this.walkInto(baseAbs, projectRoot, rules, pushIfMatch);
    return found;
  }

  // The ignore rules stacked from the project root down to (and including)
  // the base directory, so a glob rooted in a subtree still honours the
  // root .gitignore above it.
  private rulesDownTo(projectRoot: string, baseAbs: string): IgnoreRule[] {
    const rules: IgnoreRule[] = [];
    const rel = posixRelative(projectRoot, baseAbs);
    const chain = rel.length > 0 && rel !== ".." && !rel.startsWith("../") ? rel.split("/") : [];
    let dir = projectRoot;
    rules.push(...this.rulesForDir(dir));
    for (const segment of chain) {
      dir = path.join(dir, segment);
      rules.push(...this.rulesForDir(dir));
    }
    return rules;
  }

  private rulesForDir(dir: string): IgnoreRule[] {
    const text = this.fs.readIgnoreFile(dir);
    if (text === null) return [];
    return compileIgnoreRules(text);
  }

  private walkDir(dirAbs: string, projectRoot: string, parentRules: IgnoreRule[]): string[] {
    const found: string[] = [];
    const rules = [...parentRules, ...this.rulesForDir(dirAbs)];
    this.walkInto(dirAbs, projectRoot, rules, (fileAbs: string) => {
      found.push(fileAbs);
    });
    return found;
  }

  private walkInto(
    dirAbs: string,
    projectRoot: string,
    rules: IgnoreRule[],
    onFile: (fileAbs: string) => void,
  ): void {
    const entries = this.fs.readDirEntries(dirAbs);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = entry.name;
      const abs = path.join(dirAbs, name);
      const rel = posixRelative(projectRoot, abs);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRS.has(name)) continue;
        if (this.isIgnored(rel, rules)) continue;
        const childRules = [...rules, ...this.rulesForDir(abs)];
        this.walkInto(abs, projectRoot, childRules, onFile);
        continue;
      }
      if (!entry.isFile()) continue;
      if (this.isIgnored(rel, rules)) continue;
      if (langForPath(abs) === null) continue;
      onFile(abs);
    }
  }

  private isIgnored(relative: string, rules: IgnoreRule[]): boolean {
    let ignored = false;
    for (const rule of rules) {
      // Later rules win, so negations flip the flag back rather than ending
      // the scan; directory paths arrive without a trailing slash, which the
      // compiled expressions already account for.
      if (rule.regex.test(relative)) ignored = !rule.negate;
    }
    return ignored;
  }
}
