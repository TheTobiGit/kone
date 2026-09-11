// Structural call search over js/ts sources, built on the proven ast-grep calls.
// The model passes plain identifiers; kone builds the `${name}($$$ARGS)`
// pattern internally, so lookup never depends on model-written syntax
// patterns. Parsing is error-tolerant upstream (broken code yields ERROR
// nodes instead of throwing), so a file whose tree holds an ERROR node reads
// as failed-to-parse: it is skipped with a counted issue and never aborts
// the run. Only the walk touches the filesystem; findCalls itself is pure.

import { Lang, parse } from "@ast-grep/napi";
import type { SgNode, SgRoot } from "@ast-grep/napi";

import {
  AST_MAX_MATCHES,
  AST_MAX_PARSE_ISSUES_SHOWN,
  isPlainIdentifier,
  snippetOf,
} from "./format.js";
import type { AstEngineFs } from "./walk.js";
import { AstWalker, defaultFs, langForPath } from "./walk.js";
import type { AstFilePreview } from "./rewrite.js";

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

// ── unified matches ──────────────────────────────────────────────────────
// One structural pass per file: the display row and the splice spans come
// from the same findAll loop, so find-calls rows and rewrite offsets can
// never disagree on the match set.

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

/** One structural call hit: the display row plus its splice spans. */
export interface AstCallHit {
  row: {
    line: number;
    column: number;
    snippet: string;
    argCount: number;
  };
  span: AstCallSpan;
}

// One call's row and spans from its matched node. The search pattern only
// ever yields a plain call (member, new, and optional calls never match), so
// the first identifier child is the callee and the arguments child is the
// list; a match missing either is skipped rather than guessed at. Comments
// ride along as named children of the list and are filtered from the arity.
export function matchCalls(root: SgNode, name: string): AstCallHit[] {
  if (!isPlainIdentifier(name)) {
    throw new Error(`ast matchCalls needs a plain identifier, got ${JSON.stringify(name)}`);
  }
  const hits: AstCallHit[] = [];
  for (const node of root.findAll(`${name}($$$ARGS)`)) {
    const range = node.range();
    const callee = node.children().find((child) => child.kind() === "identifier");
    const args = node.children().find((child) => child.kind() === "arguments");
    if (callee === undefined || args === undefined) continue;
    const calleeRange = callee.range();
    const argsRange = args.range();
    const argCount = args.namedChildren().filter((child) => child.kind() !== "comment").length;
    hits.push({
      row: {
        line: range.start.line + 1,
        column: range.start.column + 1,
        snippet: snippetOf(node.text()),
        argCount,
      },
      span: {
        startIndex: range.start.index,
        endIndex: range.end.index,
        calleeStartIndex: calleeRange.start.index,
        calleeEndIndex: calleeRange.end.index,
        argsStartIndex: argsRange.start.index,
        argsEndIndex: argsRange.end.index,
        argCount,
        line: range.start.line + 1,
        column: range.start.column + 1,
      },
    });
  }
  // Encounter order already follows the source for disjoint matches; the sort
  // keeps nested matches (outer first) stable for the overlap check upstream.
  hits.sort((a, b) => a.span.startIndex - b.span.startIndex || a.span.endIndex - b.span.endIndex);
  return hits;
}

// Iterative ERROR hunt: the parser recovers instead of throwing, so an ERROR
// node anywhere in the tree is the only signal the file failed to parse.
// MISSING nodes (an edit cut mid-token) still search — recovery there is
// local, and skipping on every half-typed file would hide real calls.
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

// Parse plus the error-tolerant check in one place. Callers map the plain
// Error into their own accounting: a counted issue for search, an
// AstRewriteError for previews, an invalid-input message for arg validation.
export function parseOrThrow(lang: Lang, text: string): SgRoot {
  let root: SgRoot;
  try {
    root = parse(lang, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not parse file: ${message}`);
  }
  if (treeHasError(root.root())) {
    throw new Error("could not parse file: the source has syntax errors");
  }
  return root;
}

type ScanOutcome =
  | { kind: "ok"; matches: AstCallMatch[] }
  | { kind: "issue"; message: string };

function scanTextForCalls(lang: Lang, filePath: string, text: string, name: string): ScanOutcome {
  let root: SgRoot;
  try {
    root = parseOrThrow(lang, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "issue", message };
  }
  const matches = matchCalls(root.root(), name).map((hit) => ({
    path: filePath,
    line: hit.row.line,
    column: hit.row.column,
    snippet: hit.row.snippet,
    argCount: hit.row.argCount,
  }));
  return { kind: "ok", matches };
}

// One file's preview from its text: the engine walks and reads, the caller
// splices. Anything the callback throws besides a parse skip aborts the run,
// so no partial preview goes out.
export type AstPreviewOne = (text: string, lang: Lang, filePath: string) => AstFilePreview;

export interface AstPreviewRun {
  /** The replacements actually shown, already capped. */
  files: AstFilePreview[];
  /** Exact totals before the cap, for the header and structured counts. */
  totalReplacements: number;
  filesTouched: number;
  filesSearched: number;
  limitReached: boolean;
  parseIssues: AstParseIssue[];
  parseIssuesTotal: number;
}

// The failure shape previews throw: `parse` joins the counted-issue
// accounting, everything else aborts the run.
interface PreviewFailure {
  issue?: unknown;
}

export class AstEngine {
  private readonly fs: AstEngineFs;
  private readonly walker: AstWalker;

  constructor(fs: AstEngineFs = defaultFs()) {
    this.fs = fs;
    this.walker = new AstWalker(fs);
  }

  parseText(lang: Lang, text: string): SgRoot {
    return parse(lang, text);
  }

  parseOrThrow(lang: Lang, text: string): SgRoot {
    return parseOrThrow(lang, text);
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

  // Candidate source files under an absolute file, directory, or glob. Kept
  // here so callers never touch the walker directly.
  collectFiles(requestedAbs: string, projectRoot: string): string[] {
    return this.walker.collectFiles(requestedAbs, projectRoot);
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

  // Walk, read, and preview in one pass: the sorted walk keeps the preview
  // and its cap deterministic, and only reads happen here — the callback
  // only splices strings, never the files.
  previewFiles(
    requestedAbs: string,
    projectRoot: string,
    previewOne: AstPreviewOne,
  ): AstPreviewRun {
    const files = this.collectFiles(requestedAbs, projectRoot).sort();
    const perFile: AstFilePreview[] = [];
    const parseIssues: AstParseIssue[] = [];
    let parseIssuesTotal = 0;
    let filesSearched = 0;
    let totalReplacements = 0;
    for (const filePath of files) {
      const lang = langForPath(filePath);
      if (lang === null) continue;
      const text = this.fs.readTextFile(filePath);
      if (text === null) {
        parseIssuesTotal += 1;
        if (parseIssues.length < AST_MAX_PARSE_ISSUES_SHOWN) {
          parseIssues.push({
            path: filePath,
            message: "could not read file: it is missing or unreadable",
          });
        }
        continue;
      }
      filesSearched += 1;
      let preview: AstFilePreview;
      try {
        preview = previewOne(text, lang, filePath);
      } catch (error) {
        // Unparseable files join the same counted-issue accounting as
        // search; any other rewrite failure (overlap, invalid argument)
        // aborts the run so no partial preview goes out.
        // SAFETY: PreviewFailure only reads one optional property; the
        // instanceof guard pins error to an object before the read.
        const issue = error instanceof Object ? (error as PreviewFailure).issue : null;
        if (issue !== "parse") throw error;
        const message = error instanceof Error ? error.message : String(error);
        parseIssuesTotal += 1;
        if (parseIssues.length < AST_MAX_PARSE_ISSUES_SHOWN) {
          parseIssues.push({ path: filePath, message });
        }
        continue;
      }
      totalReplacements += preview.replacements.length;
      perFile.push(preview);
    }
    const limitReached = totalReplacements > AST_MAX_MATCHES;
    // The first AST_MAX_MATCHES replacements in file order, mirroring the
    // find-calls cap; the totals below stay exact.
    const shown: AstFilePreview[] = [];
    let kept = 0;
    for (const file of perFile) {
      if (kept >= AST_MAX_MATCHES) break;
      const slice = file.replacements.slice(0, AST_MAX_MATCHES - kept);
      kept += slice.length;
      if (slice.length > 0) shown.push({ path: file.path, replacements: slice });
    }
    return {
      files: shown,
      totalReplacements,
      filesTouched: perFile.filter((file) => file.replacements.length > 0).length,
      filesSearched,
      limitReached,
      parseIssues,
      parseIssuesTotal,
    };
  }
}
