// Shared budgeted text for the ast tools.
//
// Both tools cap detail rows but report exact totals, so the ceilings, the
// snippet shaping, the parse-issue footer, and the two grouped formatters live
// here once. The engine and the rewrite slices keep only their row building;
// everything about cutting output to budget is this module's job.

import type { AstFindCallsResult } from "./engine.js";
import type { AstParseIssue } from "./engine.js";
import type { AstFilePreview } from "./rewrite.js";

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

// The match's first line, trimmed and cut past the snippet width. Leading
// whitespace cannot occur (a match starts at the callee), so the trim only
// ever drops trailing blank space from the source line.
export function snippetOf(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  const line = first.trim();
  if (line.length <= AST_SNIPPET_CHARS) return line;
  return `${line.slice(0, AST_SNIPPET_CHARS)}…`;
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function capChars(text: string): string {
  if (text.length <= AST_OUTPUT_BUDGET_CHARS) return text;
  return `${text.slice(0, AST_OUTPUT_BUDGET_CHARS)}\n${AST_TRUNCATION_MARKER}`;
}

// The shared skipped-file footer: exact total in the header, detail rows only
// for the first few, nothing at all when every file parsed.
export function parseIssuesFooter(
  parseIssues: readonly AstParseIssue[],
  parseIssuesTotal: number,
): string[] {
  if (parseIssuesTotal === 0) return [];
  const shown = parseIssues.length;
  const lines = [
    `${parseIssuesTotal} ${pluralize(parseIssuesTotal, "file", "files")} could not be parsed and ${pluralize(parseIssuesTotal, "was", "were")} skipped${shown < parseIssuesTotal ? ` (showing ${shown})` : ""}:`,
  ];
  for (const issue of parseIssues) {
    lines.push(`  ${issue.path}: ${issue.message}`);
  }
  return lines;
}

function argLabel(argCount: number): string {
  return `${argCount} ${pluralize(argCount, "arg", "args")}`;
}

// Grouped by file with path:line anchors plus snippet and arity per match.
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
  lines.push(...parseIssuesFooter(result.parseIssues, result.parseIssuesTotal));
  return capChars(lines.join("\n"));
}

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

// Grouped by file with path:line anchors plus the before → after first lines
// per replacement.
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
  lines.push(...parseIssuesFooter(input.parseIssues, input.parseIssuesTotal));
  if (input.totalReplacements > 0) {
    lines.push("Re-verify each match before applying: the preview goes stale if the file changes.");
  }
  return capChars(lines.join("\n"));
}
