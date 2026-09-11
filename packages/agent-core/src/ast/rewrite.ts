// Fixed rewrite previews over in-memory text.
//
// Nothing here touches the filesystem: callers read, this module splices
// strings, and the driven CLI applies the previewed text with its own edit
// tools. Every offset below is a parser string offset, so plain slicing lands
// exactly on the match (verified past multibyte characters in tests). A file
// is always previewed atomically: overlapping matches abort the file instead
// of yielding a partial preview the caller might half-apply.

import { Lang } from "@ast-grep/napi";
import type { SgRoot } from "@ast-grep/napi";

import { matchCalls, parseOrThrow } from "./engine.js";
import type { AstCallSpan } from "./engine.js";
import { isPlainIdentifier, snippetOf } from "./format.js";

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

// ── line index ───────────────────────────────────────────────────────────
// Line starts scanned once per file: every replacement in a file shares the
// index, so previewing N matches costs one pass instead of N per-row scans.

// Byte offsets where each 1-based line starts; index 0 is always line 1.
function lineStartOffsets(source: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

// 1-based line number holding a string offset, by binary search.
function lineOfOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const start = starts[mid];
    if (start === undefined || start > offset) high = mid - 1;
    else low = mid;
  }
  return low + 1;
}

// One replacement's row: the source line holding the edit, then the same
// line with the edit spliced in. The edit offsets are absolute, so they shift
// down by the line start before splicing the line.
function previewRow(source: string, starts: readonly number[], edit: AstTextSplice): AstReplacementPreview {
  const line = lineOfOffset(starts, Math.min(edit.start, source.length));
  // SAFETY: line always comes from lineOfOffset over the same starts, so the
  // index below names a real line start.
  const lineStart = starts[line - 1] as number;
  let lineEnd = lineStart;
  while (lineEnd < source.length && source[lineEnd] !== "\n") lineEnd += 1;
  const lineText = source.slice(lineStart, lineEnd);
  const before = snippetOf(lineText);
  const relative: AstTextSplice = {
    start: edit.start - lineStart,
    end: edit.end - lineStart,
    newText: edit.newText,
  };
  return { line, before, after: snippetOf(applyEditsToText(lineText, [relative])) };
}

// Parse plus the engine's error-tolerant check, mapped to the skipped-file
// issue the tool counts. The message already reads as failed-to-parse, so it
// passes through untouched.
function collectSpans(lang: Lang, source: string, name: string): AstCallSpan[] {
  let root: SgRoot;
  try {
    root = parseOrThrow(lang, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AstRewriteError("parse", message);
  }
  return matchCalls(root.root(), name).map((hit) => hit.span);
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
  const starts = lineStartOffsets(source);
  return {
    path,
    replacements: spans.map((span) =>
      previewRow(source, starts, {
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
  let seen: string | null;
  try {
    const root = parseOrThrow(lang, probeSource);
    const spans = matchCalls(root.root(), "__probe__");
    const probe = spans.length === 1 ? spans[0] : undefined;
    seen =
      probe === undefined
        ? null
        : probeSource.slice(probe.span.argsStartIndex, probe.span.argsEndIndex);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AstRewriteError(
      "invalid-input",
      `argText is not an expression list: ${JSON.stringify(argText)} does not parse (${detail})`,
    );
  }
  if (seen !== `(${argText})`) {
    throw new AstRewriteError(
      "invalid-input",
      `argText must be only the argument list: ${JSON.stringify(argText)} carries code outside the arguments; pass comma-separated expressions`,
    );
  }
}

// Where an insertion lands: empty lists take the bare text at either paren,
// non-empty ones hang the comma on the outer side of the new argument.
interface ArgPlacementCell {
  anchor: "open" | "close";
  prefix: string;
  suffix: string;
}

interface ArgPlacement {
  empty: ArgPlacementCell;
  nonEmpty: ArgPlacementCell;
}

const ARG_PLACEMENT = {
  first: {
    empty: { anchor: "open", prefix: "", suffix: "" },
    nonEmpty: { anchor: "open", prefix: "", suffix: ", " },
  },
  last: {
    empty: { anchor: "close", prefix: "", suffix: "" },
    nonEmpty: { anchor: "close", prefix: ", ", suffix: "" },
  },
} satisfies Record<AstRewritePosition, ArgPlacement>;

// One match's insertion: the paren-side offset plus the comma affixes.
interface InsertionPoint {
  at: number;
  prefix: string;
  suffix: string;
}

// The insertion point for one match: the table above picks the paren side
// and the comma affixes, so the four cases share the single return below.
// No paren guard: the span comes from the parser's own arguments node, which
// is parenthesised by construction.
function insertionPoint(span: AstCallSpan, position: AstRewritePosition): InsertionPoint {
  const cell = span.argCount === 0 ? ARG_PLACEMENT[position].empty : ARG_PLACEMENT[position].nonEmpty;
  return {
    at: cell.anchor === "open" ? span.argsStartIndex + 1 : span.argsEndIndex - 1,
    prefix: cell.prefix,
    suffix: cell.suffix,
  };
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
  const starts = lineStartOffsets(source);
  return {
    path,
    replacements: spans.map((span) => {
      const point = insertionPoint(span, position);
      return previewRow(source, starts, {
        start: point.at,
        end: point.at,
        newText: `${point.prefix}${options.argText}${point.suffix}`,
      });
    }),
  };
}
