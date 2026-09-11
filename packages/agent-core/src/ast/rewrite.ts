// Fixed rewrite previews over in-memory text.
//
// Nothing here touches the filesystem: callers read, this module splices
// strings, and the driven CLI applies the previewed text with its own edit
// tools. Every offset below is a parser string offset, so plain slicing lands
// exactly on the match (verified past multibyte characters in tests). A file
// is always previewed atomically: overlapping matches abort the file instead
// of yielding a partial preview the caller might half-apply.

import { Lang, parse } from "@ast-grep/napi";

import {
  AST_MAX_MATCHES,
  AST_OUTPUT_BUDGET_CHARS,
  AST_TRUNCATION_MARKER,
  findCallSpans,
  isPlainIdentifier,
  snippetOf,
  treeHasError,
} from "./engine.js";
import type { AstCallSpan, AstParseIssue } from "./engine.js";

/** The two fixed rewrites the preview tool offers. */
export type AstPreviewOp = "rename-call" | "add-argument";

/** Where an added argument lands inside the argument list. */
export type AstRewritePosition = "first" | "last";

export interface AstRenameOptions {
  from: string;
  to: string;
  lang?: Lang;
  path?: string;
}

export interface AstAddArgumentOptions {
  name: string;
  argText: string;
  position?: AstRewritePosition;
  lang?: Lang;
  path?: string;
}

/** One replacement's one-line before/after, cut like the find-calls snippets. */
export interface AstReplacementPreview {
  line: number;
  before: string;
  after: string;
}

/** A file's preview: its path plus one row per replacement. */
export interface AstFilePreview {
  path: string;
  replacements: AstReplacementPreview[];
}

/** A string-offset splice into the source text. */
export interface AstTextSplice {
  start: number;
  end: number;
  newText: string;
}

export type AstRewriteIssue = "parse" | "overlap" | "invalid-input";

/** A rewrite that cannot be previewed: unparseable source, overlapping
 *  matches, or an argument that fails validation. The tool counts `parse`
 *  as a skipped-file issue and returns the other two as error results. */
export class AstRewriteError extends Error {
  readonly issue: AstRewriteIssue;

  constructor(issue: AstRewriteIssue, message: string) {
    super(message);
    this.name = "AstRewriteError";
    this.issue = issue;
  }
}

// Apply string-offset splices, aborting on the first overlap before changing
// anything: sorting keeps later offsets valid, and a splice reaching back
// over its predecessor means two edits claim the same characters.
export function applyEditsToText(source: string, edits: readonly AstTextSplice[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const edit of ordered) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end > source.length ||
      edit.start > edit.end
    ) {
      throw new AstRewriteError(
        "invalid-input",
        `rewrite edit [${edit.start}, ${edit.end}) falls outside the source (${source.length} characters)`,
      );
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const prev = ordered[index - 1];
    const next = ordered[index];
    if (prev === undefined || next === undefined) continue;
    if (next.start < prev.end) {
      throw new AstRewriteError(
        "overlap",
        `overlapping edits at offsets ${prev.start} and ${next.start}: one file is rewritten atomically, never partially`,
      );
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    parts.push(source.slice(cursor, edit.start));
    parts.push(edit.newText);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

// 1-based line number holding a string offset.
function lineOf(source: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, source.length);
  for (let index = 0; index < stop; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

/** String range of one source line, without its newline. */
interface AstLineRange {
  start: number;
  end: number;
}

// String range of a 1-based line, without its newline.
function lineStringRange(source: string, line: number): AstLineRange {
  let start = 0;
  let current = 1;
  while (current < line && start < source.length) {
    if (source[start] === "\n") current += 1;
    start += 1;
  }
  let end = start;
  while (end < source.length && source[end] !== "\n") end += 1;
  return { start, end };
}

// One replacement's row: the source line holding the edit, then the same
// line with the edit spliced in. The edit offsets are absolute, so they shift
// down by the line start before splicing the line.
function previewRow(source: string, edit: AstTextSplice): AstReplacementPreview {
  const line = lineOf(source, edit.start);
  const range = lineStringRange(source, line);
  const lineText = source.slice(range.start, range.end);
  const before = snippetOf(lineText);
  const relative: AstTextSplice = {
    start: edit.start - range.start,
    end: edit.end - range.start,
    newText: edit.newText,
  };
  return { line, before, after: snippetOf(applyEditsToText(lineText, [relative])) };
}

// Parse plus the engine's error-tolerant check: a tree holding an ERROR node
// reads as failed-to-parse, with the same message the engine counts, and the
// tool turns the throw into a skipped-file issue.
function collectSpans(lang: Lang, source: string, name: string): AstCallSpan[] {
  let root: ReturnType<typeof parse>;
  try {
    root = parse(lang, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AstRewriteError("parse", `could not parse file: ${message}`);
  }
  if (treeHasError(root.root())) {
    throw new AstRewriteError("parse", "could not parse file: the source has syntax errors");
  }
  return findCallSpans(root.root(), name);
}

// Overlapping match ranges abort the file: two previews claiming the same
// characters cannot both be applied, so the file yields an error instead of a
// partial set. Nested same-name calls (outer first from the span sort) are
// the shape that trips this.
function rejectOverlappingMatches(spans: readonly AstCallSpan[], name: string, path: string): void {
  for (let index = 1; index < spans.length; index += 1) {
    const prev = spans[index - 1];
    const next = spans[index];
    if (prev === undefined || next === undefined) continue;
    if (next.startIndex < prev.endIndex) {
      const where = path.length > 0 ? ` in ${path}` : "";
      throw new AstRewriteError(
        "overlap",
        `overlapping matches for "${name}"${where} (lines ${prev.line} and ${next.line}): one file is previewed atomically — narrow the path or apply the nested call by hand`,
      );
    }
  }
}

// Preview renaming every `from(…)` call to `to(…)` by splicing the callee
// range of each match. The argument list is never reprinted, so multi-line
// formatting survives untouched.
export function previewRenameCall(source: string, options: AstRenameOptions): AstFilePreview {
  const lang = options.lang ?? Lang.TypeScript;
  const path = options.path ?? "";
  if (!isPlainIdentifier(options.from)) {
    throw new AstRewriteError(
      "invalid-input",
      `rename needs a plain identifier to find, got ${JSON.stringify(options.from)}`,
    );
  }
  if (!isPlainIdentifier(options.to)) {
    throw new AstRewriteError(
      "invalid-input",
      `rename needs a plain identifier to write, got ${JSON.stringify(options.to)}`,
    );
  }
  const spans = collectSpans(lang, source, options.from);
  rejectOverlappingMatches(spans, options.from, path);
  return {
    path,
    replacements: spans.map((span) =>
      previewRow(source, {
        start: span.calleeStartIndex,
        end: span.calleeEndIndex,
        newText: options.to,
      }),
    ),
  };
}

// An argument list is valid when __probe__(<argText>) parses cleanly and the
// probe call's own list round-trips to exactly (<argText>). The round-trip is
// the real guard: smuggled statements (`1); evil(`) still parse, but the
// probe keeps only `(1)`, so the comparison names the extra code.
function validateArgText(lang: Lang, argText: string): void {
  if (argText.trim().length === 0) {
    throw new AstRewriteError(
      "invalid-input",
      "argText must be a non-empty comma-separated expression list",
    );
  }
  const probeSource = `__probe__(${argText})`;
  let root: ReturnType<typeof parse>;
  try {
    root = parse(lang, probeSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AstRewriteError(
      "invalid-input",
      `argText is not an expression list: ${JSON.stringify(argText)} does not parse (${message})`,
    );
  }
  const node = root.root();
  if (treeHasError(node)) {
    throw new AstRewriteError(
      "invalid-input",
      `argText is not an expression list: ${JSON.stringify(argText)} does not parse; pass comma-separated expressions`,
    );
  }
  const spans = findCallSpans(node, "__probe__");
  const probe = spans[0];
  const seen =
    probe === undefined || spans.length !== 1
      ? null
      : probeSource.slice(probe.argsStartIndex, probe.argsEndIndex);
  if (seen !== `(${argText})`) {
    throw new AstRewriteError(
      "invalid-input",
      `argText must be only the argument list: ${JSON.stringify(argText)} carries code outside the arguments; pass comma-separated expressions`,
    );
  }
}

// Preview inserting argText into every `name(…)` call as a point edit before
// the closing paren (last) or after the opening paren (first). The call is
// never reprinted, so multi-line formatting survives untouched.
export function previewAddArgument(source: string, options: AstAddArgumentOptions): AstFilePreview {
  const lang = options.lang ?? Lang.TypeScript;
  const path = options.path ?? "";
  const position = options.position ?? "last";
  if (!isPlainIdentifier(options.name)) {
    throw new AstRewriteError(
      "invalid-input",
      `add-argument needs a plain identifier to find, got ${JSON.stringify(options.name)}`,
    );
  }
  validateArgText(lang, options.argText);
  const spans = collectSpans(lang, source, options.name);
  rejectOverlappingMatches(spans, options.name, path);
  return {
    path,
    replacements: spans.map((span) => {
      const list = source.slice(span.argsStartIndex, span.argsEndIndex);
      if (!list.startsWith("(") || !list.endsWith(")")) {
        throw new AstRewriteError(
          "invalid-input",
          `cannot place an argument: the argument list at line ${span.line} is not parenthesised`,
        );
      }
      if (span.argCount === 0) {
        const at = position === "first" ? span.argsStartIndex + 1 : span.argsEndIndex - 1;
        return previewRow(source, { start: at, end: at, newText: options.argText });
      }
      if (position === "first") {
        const at = span.argsStartIndex + 1;
        return previewRow(source, { start: at, end: at, newText: `${options.argText}, ` });
      }
      const at = span.argsEndIndex - 1;
      return previewRow(source, { start: at, end: at, newText: `, ${options.argText}` });
    }),
  };
}

// ── budgeted text ──────────────────────────────────────────────────────────
// Grouped by file with path:line anchors plus the before → after first lines
// per replacement. Kept beside the rewrites (not in the lsp budget module):
// these grouped before/after rows fit none of that module's formatters, only
// its ceiling-and-marker idea, mirroring the find-calls output beside it.

/** What changed, in the header's words. */
export type AstPreviewChange =
  | { kind: "rename"; from: string; to: string }
  | { kind: "add"; name: string; argText: string };

export interface AstRewriteFormatInput {
  change: AstPreviewChange;
  /** The replacements actually shown, already capped. */
  files: readonly AstFilePreview[];
  /** Exact totals before the cap, for the header and structured counts. */
  totalReplacements: number;
  filesTouched: number;
  filesSearched: number;
  limitReached: boolean;
  parseIssues: readonly AstParseIssue[];
  parseIssuesTotal: number;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function capChars(text: string): string {
  if (text.length <= AST_OUTPUT_BUDGET_CHARS) return text;
  return `${text.slice(0, AST_OUTPUT_BUDGET_CHARS)}\n${AST_TRUNCATION_MARKER}`;
}

function changeTarget(change: AstPreviewChange): string {
  return change.kind === "rename" ? change.from : change.name;
}

function headerLine(input: AstRewriteFormatInput): string {
  const searched =
    `${input.filesSearched} ${pluralize(input.filesSearched, "file", "files")} searched, ` +
    "preview only — nothing was changed";
  if (input.change.kind === "rename") {
    const { from, to } = input.change;
    return (
      `${input.totalReplacements} ${pluralize(input.totalReplacements, "call", "calls")} to "${from}" ` +
      `renamed to "${to}" across ${input.filesTouched} ${pluralize(input.filesTouched, "file", "files")} (${searched}):`
    );
  }
  const { name, argText } = input.change;
  return (
    `${input.totalReplacements} ${pluralize(input.totalReplacements, "call", "calls")} to "${name}" ` +
    `with ${JSON.stringify(argText)} added across ${input.filesTouched} ${pluralize(input.filesTouched, "file", "files")} (${searched}):`
  );
}

export function formatRewritePreview(input: AstRewriteFormatInput): string {
  const lines: string[] = [];
  if (input.totalReplacements === 0) {
    lines.push(`No calls to "${changeTarget(input.change)}" found — nothing to preview.`);
  } else {
    lines.push(headerLine(input));
    for (const file of input.files) {
      if (file.replacements.length === 0) continue;
      lines.push(`${file.path}:`);
      for (const replacement of file.replacements) {
        lines.push(`  ${file.path}:${replacement.line} - ${replacement.before} → ${replacement.after}`);
      }
    }
  }
  if (input.limitReached) {
    lines.push(`… limit reached: showing the first ${AST_MAX_MATCHES} replacements.`);
  }
  if (input.parseIssuesTotal > 0) {
    const shown = input.parseIssues.length;
    lines.push(
      `${input.parseIssuesTotal} ${pluralize(input.parseIssuesTotal, "file", "files")} could not be parsed and ${pluralize(input.parseIssuesTotal, "was", "were")} skipped${shown < input.parseIssuesTotal ? ` (showing ${shown})` : ""}:`,
    );
    for (const issue of input.parseIssues) {
      lines.push(`  ${issue.path}: ${issue.message}`);
    }
  }
  if (input.totalReplacements > 0) {
    lines.push("Re-verify each match before applying: the preview goes stale if the file changes.");
  }
  return capChars(lines.join("\n"));
}
