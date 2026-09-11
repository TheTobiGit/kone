// Structural call search over js/ts sources, built on the proven ast-grep calls.
// The model passes plain identifiers; kone builds the `${name}($$$ARGS)`
// pattern internally, so lookup never depends on model-written syntax
// patterns. Parsing is error-tolerant upstream (broken code yields ERROR
// nodes instead of throwing), so a file whose tree holds an ERROR node reads
// as failed-to-parse: it is skipped with a counted issue and never aborts
// the run. Only the walk touches the filesystem; findCalls itself is pure.

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import { Lang, parse } from "@ast-grep/napi";
import type { SgNode, SgRoot } from "@ast-grep/napi";

/** Hard ceiling on matches kept per run; the rest set limitReached. */
export const AST_MAX_MATCHES = 50;

/** Snippet width: the match's first line, cut with an ellipsis past this. */
export const AST_SNIPPET_CHARS = 120;

/** How many parse issues the result carries detail for; the total is exact. */
export const AST_MAX_PARSE_ISSUES_SHOWN = 20;

/** Total-character ceiling for the formatted text, mirroring the lsp budget. */
export const AST_OUTPUT_BUDGET_CHARS = 6000;

/** Tail marker proving formatted output was cut rather than complete. */
export const AST_TRUNCATION_MARKER = "…truncated";

/** Plain identifiers only — the model never sends patterns or wildcards. */
export const AST_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isPlainIdentifier(name: string): boolean {
  return AST_IDENTIFIER_PATTERN.test(name);
}

export interface AstFileInput {
  path: string;
  text: string;
}

export interface AstCallMatch {
  path: string;
  line: number;
  column: number;
  snippet: string;
  argCount: number;
}

export interface AstParseIssue {
  path: string;
  message: string;
}

export interface AstFindCallsResult {
  matches: AstCallMatch[];
  filesSearched: number;
  parseIssues: AstParseIssue[];
  parseIssuesTotal: number;
  limitReached: boolean;
}

export interface AstFindCallsOptions {
  name: string;
}

// ── rewrite spans ──────────────────────────────────────────────────────────
// String-index spans for one structural call match, so the rewrite slice can
// splice text from parser positions instead of re-deriving them from rendered
// output. Additive: findCalls keeps building its own rows untouched below.

/** Where one call and its rewritable parts sit, as parser string offsets. */
export interface AstCallSpan {
  /** The whole call, from the callee start through the closing paren. */
  startIndex: number;
  endIndex: number;
  /** The callee identifier a rename splices. */
  calleeStartIndex: number;
  calleeEndIndex: number;
  /** The parenthesised argument list, parens included, an add splices. */
  argsStartIndex: number;
  argsEndIndex: number;
  /** Arity with comments filtered, the same count findCalls reports. */
  argCount: number;
  /** 1-based match-start position for preview anchors. */
  line: number;
  column: number;
}

// One call's spans from its matched node. The search pattern only ever yields
// a plain call (member, new, and optional calls never match), so the first
// identifier child is the callee and the arguments child is the list; a match
// missing either is skipped rather than guessed at.
export function findCallSpans(root: SgNode, name: string): AstCallSpan[] {
  if (!isPlainIdentifier(name)) {
    throw new Error(`ast spans need a plain identifier, got ${JSON.stringify(name)}`);
  }
  const spans: AstCallSpan[] = [];
  for (const node of root.findAll(`${name}($$$ARGS)`)) {
    const range = node.range();
    const callee = node.children().find((child) => child.kind() === "identifier");
    const args = node.children().find((child) => child.kind() === "arguments");
    if (callee === undefined || args === undefined) continue;
    const calleeRange = callee.range();
    const argsRange = args.range();
    spans.push({
      startIndex: range.start.index,
      endIndex: range.end.index,
      calleeStartIndex: calleeRange.start.index,
      calleeEndIndex: calleeRange.end.index,
      argsStartIndex: argsRange.start.index,
      argsEndIndex: argsRange.end.index,
      argCount: args.namedChildren().filter((child) => child.kind() !== "comment").length,
      line: range.start.line + 1,
      column: range.start.column + 1,
    });
  }
  // Encounter order already follows the source for disjoint matches; the sort
  // keeps nested matches (outer first) stable for the overlap check upstream.
  spans.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  return spans;
}

export interface AstEngineFs {
  readDirEntries(dir: string): Dirent[];
  readTextFile(filePath: string): string | null;
  statPath(filePath: string): { isFile: boolean; isDirectory: boolean } | null;
  readIgnoreFile(dir: string): string | null;
}

function defaultFs(): AstEngineFs {
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

// The match's first line, trimmed and cut past the snippet width. Leading
// whitespace cannot occur (a match starts at the callee), so the trim only
// ever drops trailing blank space from the source line.
export function snippetOf(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  const line = first.trim();
  if (line.length <= AST_SNIPPET_CHARS) return line;
  return `${line.slice(0, AST_SNIPPET_CHARS)}…`;
}

// Exact arity from the call's own argument list. Metavar bindings cannot do
// this: a multi-metavar also binds the commas between arguments, so its
// count overshoots. Comments ride along as named children and are filtered.
function argCountOf(node: SgNode): number {
  const args = node.children().find((child) => child.kind() === "arguments");
  if (args === undefined) return 0;
  return args.namedChildren().filter((child) => child.kind() !== "comment").length;
}

// Iterative ERROR hunt: the parser recovers instead of throwing, so an ERROR
// node anywhere in the tree is the only signal the file failed to parse.
// MISSING nodes (an edit cut mid-token) still search — recovery there is
// local, and skipping on every half-typed file would hide real calls.
// Exported for the rewrite slice, which applies the same skip rule.
export function treeHasError(root: SgNode): boolean {
  const stack: SgNode[] = [root];
  let next = stack.pop();
  while (next !== undefined) {
    if (next.kind() === "ERROR") return true;
    for (const child of next.children()) stack.push(child);
    next = stack.pop();
  }
  return false;
}

type ScanOutcome =
  | { kind: "ok"; matches: AstCallMatch[] }
  | { kind: "issue"; message: string };

function scanTextForCalls(lang: Lang, filePath: string, text: string, name: string): ScanOutcome {
  let root: SgRoot;
  try {
    root = parse(lang, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "issue", message: `could not parse file: ${message}` };
  }
  if (treeHasError(root.root())) {
    return { kind: "issue", message: "could not parse file: the source has syntax errors" };
  }
  const matches: AstCallMatch[] = [];
  const nodes = root.root().findAll(`${name}($$$ARGS)`);
  for (const node of nodes) {
    const range = node.range();
    matches.push({
      path: filePath,
      line: range.start.line + 1,
      column: range.start.column + 1,
      snippet: snippetOf(node.text()),
      argCount: argCountOf(node),
    });
  }
  return { kind: "ok", matches };
}

// ── ignore-aware walking ───────────────────────────────────────────────────
// Minimal .gitignore support with no new deps: blank lines and # comments
// drop out, a trailing slash marks dir-only, a leading ! negates, and a
// pattern without a slash matches the basename at any depth while one with a
// slash anchors to the .gitignore's own directory. node_modules and .git are
// always skipped on top, at every depth.

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

function hasGlobMagic(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
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

export class AstEngine {
  private readonly fs: AstEngineFs;

  constructor(fs: AstEngineFs = defaultFs()) {
    this.fs = fs;
  }

  parseText(lang: Lang, text: string): SgRoot {
    return parse(lang, text);
  }

  findCalls(files: readonly AstFileInput[], options: AstFindCallsOptions): AstFindCallsResult {
    const name = options.name;
    if (!isPlainIdentifier(name)) {
      throw new Error(`ast findCalls needs a plain identifier, got ${JSON.stringify(name)}`);
    }
    const matches: AstCallMatch[] = [];
    const parseIssues: AstParseIssue[] = [];
    let parseIssuesTotal = 0;
    let filesSearched = 0;
    let totalFound = 0;
    for (const file of files) {
      const lang = langForPath(file.path);
      if (lang === null) continue;
      filesSearched += 1;
      const outcome = scanTextForCalls(lang, file.path, file.text, name);
      if (outcome.kind === "issue") {
        parseIssuesTotal += 1;
        if (parseIssues.length < AST_MAX_PARSE_ISSUES_SHOWN) {
          parseIssues.push({ path: file.path, message: outcome.message });
        }
        continue;
      }
      for (const match of outcome.matches) {
        totalFound += 1;
        if (matches.length < AST_MAX_MATCHES) matches.push(match);
      }
    }
    // Encounter order is already path order when the files came from the
    // walk (sorted entries); the sort keeps ad-hoc caller order stable too.
    matches.sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });
    return {
      matches,
      filesSearched,
      parseIssues,
      parseIssuesTotal,
      limitReached: totalFound > AST_MAX_MATCHES,
    };
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

  // Walk, read, and search in one pass so read failures join the same
  // counted-issue accounting as parse failures.
  search(requestedAbs: string, projectRoot: string, name: string): AstFindCallsResult {
    if (!isPlainIdentifier(name)) {
      throw new Error(`ast search needs a plain identifier, got ${JSON.stringify(name)}`);
    }
    const inputs: AstFileInput[] = [];
    const readIssues: AstParseIssue[] = [];
    for (const filePath of this.collectFiles(requestedAbs, projectRoot)) {
      if (langForPath(filePath) === null) continue;
      const text = this.fs.readTextFile(filePath);
      if (text === null) {
        readIssues.push({ path: filePath, message: "could not read file: it is missing or unreadable" });
        continue;
      }
      inputs.push({ path: filePath, text });
    }
    const result = this.findCalls(inputs, { name });
    const parseIssues = [...readIssues.slice(0, AST_MAX_PARSE_ISSUES_SHOWN - result.parseIssues.length), ...result.parseIssues];
    return {
      ...result,
      parseIssues,
      parseIssuesTotal: readIssues.length + result.parseIssuesTotal,
    };
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
    this.walkInto(baseAbs, projectRoot, rules, pushIfMatch, found);
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
    this.walkInto(dirAbs, projectRoot, rules, null, found);
    return found;
  }

  private walkInto(
    dirAbs: string,
    projectRoot: string,
    rules: IgnoreRule[],
    onFile: ((fileAbs: string) => void) | null,
    found: string[],
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
        this.walkInto(abs, projectRoot, childRules, onFile, found);
        continue;
      }
      if (!entry.isFile()) continue;
      if (this.isIgnored(rel, rules)) continue;
      if (langForPath(abs) === null) continue;
      if (onFile !== null) onFile(abs);
      else found.push(abs);
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

// ── budgeted text ──────────────────────────────────────────────────────────
// Grouped by file with path:line anchors plus snippet and arity per match.
// Kept beside the engine (not in the lsp budget module): the grouped
// snippet-plus-arity rows fit none of that module's formatters, only its
// ceiling-and-marker idea.

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function argLabel(argCount: number): string {
  return `${argCount} ${pluralize(argCount, "arg", "args")}`;
}

function capChars(text: string): string {
  if (text.length <= AST_OUTPUT_BUDGET_CHARS) return text;
  return `${text.slice(0, AST_OUTPUT_BUDGET_CHARS)}\n${AST_TRUNCATION_MARKER}`;
}

export function formatFindCalls(name: string, result: AstFindCallsResult): string {
  const lines: string[] = [];
  if (result.matches.length === 0) {
    lines.push(`No calls to "${name}" found.`);
  } else {
    const fileCount = new Set(result.matches.map((match) => match.path)).size;
    lines.push(
      `${result.matches.length} ${pluralize(result.matches.length, "call", "calls")} to "${name}" across ${fileCount} ${pluralize(fileCount, "file", "files")} (${result.filesSearched} ${pluralize(result.filesSearched, "file", "files")} searched):`,
    );
    let currentFile: string | null = null;
    for (const match of result.matches) {
      if (match.path !== currentFile) {
        currentFile = match.path;
        lines.push(`${match.path}:`);
      }
      lines.push(`  ${match.path}:${match.line} [${argLabel(match.argCount)}] ${match.snippet}`);
    }
    if (result.limitReached) {
      lines.push(`… limit reached: showing the first ${AST_MAX_MATCHES} matches.`);
    }
  }
  if (result.parseIssuesTotal > 0) {
    const shown = result.parseIssues.length;
    lines.push(
      `${result.parseIssuesTotal} ${pluralize(result.parseIssuesTotal, "file", "files")} could not be parsed and ${pluralize(result.parseIssuesTotal, "was", "were")} skipped${shown < result.parseIssuesTotal ? ` (showing ${shown})` : ""}:`,
    );
    for (const issue of result.parseIssues) {
      lines.push(`  ${issue.path}: ${issue.message}`);
    }
  }
  return capChars(lines.join("\n"));
}
