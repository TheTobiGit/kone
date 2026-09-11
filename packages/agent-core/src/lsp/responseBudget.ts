// Response budgeting: shape server results into agent-sized text.
//
// Clients cap tokens, not servers, so the first N references carry full
// context while the rest collapse to path:line:col pointers; every other
// formatter instead caps total characters and marks the cut. All line/col
// numbers here are 1-indexed display values; input characters stay 0-based
// utf-16 offsets as the protocol sends them.

import type { LspDiagnosticSeverity } from "./types.js";

/** How many references keep full context before the rest collapse. */
export const DEFAULT_MAX_REFERENCES_WITH_CONTEXT = 10;

/** Total-character ceiling for the capped formatters. */
export const DEFAULT_BUDGET_CHARS = 6000;

/** Tail marker proving output was cut rather than complete. */
export const TRUNCATION_MARKER = "…truncated";

export interface BudgetReference {
  path: string;
  line: number;
  character: number;
  contextLines: readonly string[];
}

export interface FormatReferencesOptions {
  maxWithContext?: number;
}

export interface FormatBudgetOptions {
  maxChars?: number;
}

export interface BudgetLocation {
  path: string;
  line: number;
  character: number;
}

export interface BudgetDiagnostic {
  path: string;
  line: number;
  character: number;
  severity?: LspDiagnosticSeverity;
  source?: string;
  message: string;
}

/** Non-negative integer override or the default when the caller passes
 *  nothing usable. Zero is valid — every reference collapses to a pointer. */
function resolveMaxWithContext(options: FormatReferencesOptions | undefined): number {
  const raw = options?.maxWithContext;
  if (raw === undefined) return DEFAULT_MAX_REFERENCES_WITH_CONTEXT;
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_MAX_REFERENCES_WITH_CONTEXT;
  return raw;
}

function resolveMaxChars(options: FormatBudgetOptions | undefined): number {
  const raw = options?.maxChars;
  if (raw === undefined) return DEFAULT_BUDGET_CHARS;
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_BUDGET_CHARS;
  return raw;
}

/** Hard cut at the ceiling with the tail marker; text already inside the
 *  budget passes through untouched. */
function capChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n${TRUNCATION_MARKER}`;
}

/** The first maxWithContext references render as path:line headers with
 *  their context lines; the rest collapse to path:line:col pointers under a
 *  divider that states how many lost their context. */
export function formatReferences(
  refs: readonly BudgetReference[],
  options?: FormatReferencesOptions,
): string {
  if (refs.length === 0) return "No references found.";
  const maxWithContext = resolveMaxWithContext(options);
  const detailed = refs.slice(0, maxWithContext);
  const rest = refs.slice(maxWithContext);
  const parts: string[] = [];
  for (const ref of detailed) {
    parts.push(`${ref.path}:${ref.line}`);
    for (const contextLine of ref.contextLines) {
      parts.push(`  ${contextLine}`);
    }
  }
  if (rest.length > 0) {
    parts.push(`... ${rest.length} more shown without context`);
    for (const ref of rest) {
      parts.push(`${ref.path}:${ref.line}:${ref.character + 1}`);
    }
  }
  return parts.join("\n");
}

export function formatLocations(
  locations: readonly BudgetLocation[],
  options?: FormatBudgetOptions,
): string {
  if (locations.length === 0) return "No locations found.";
  const text = locations.map((loc) => `${loc.path}:${loc.line}:${loc.character + 1}`).join("\n");
  return capChars(text, resolveMaxChars(options));
}

export function formatHover(contents: string, options?: FormatBudgetOptions): string {
  if (contents.trim().length === 0) return "No hover information found.";
  return capChars(contents, resolveMaxChars(options));
}

function severityLabel(severity: LspDiagnosticSeverity | undefined): string | null {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return null;
  }
}

function formatOneDiagnostic(diagnostic: BudgetDiagnostic): string {
  let line = `${diagnostic.path}:${diagnostic.line}:${diagnostic.character + 1}`;
  const label = severityLabel(diagnostic.severity);
  if (label !== null) line += ` [${label}]`;
  line += ` ${diagnostic.message}`;
  const source = diagnostic.source?.trim();
  if (source !== undefined && source.length > 0) line += ` (${source})`;
  return line;
}

export function formatDiagnostics(
  diagnostics: readonly BudgetDiagnostic[],
  options?: FormatBudgetOptions,
): string {
  if (diagnostics.length === 0) return "No diagnostics found.";
  const text = diagnostics.map(formatOneDiagnostic).join("\n");
  return capChars(text, resolveMaxChars(options));
}

export interface BudgetSymbol {
  name: string;
  detail?: string;
  path: string;
  line: number;
  character: number;
}

/** One flattened symbol per line as `name - path:line:col`, with the server's
 *  detail in parentheses when it carries one. Document and workspace symbols
 *  share this shape once the tool flattens the hierarchy. */
export function formatSymbols(
  symbols: readonly BudgetSymbol[],
  options?: FormatBudgetOptions,
): string {
  if (symbols.length === 0) return "No symbols found.";
  const text = symbols
    .map((symbol) => {
      const at = `${symbol.path}:${symbol.line}:${symbol.character + 1}`;
      const detail = symbol.detail?.trim();
      const label =
        detail !== undefined && detail.length > 0 ? `${symbol.name} (${detail})` : symbol.name;
      return `${label} - ${at}`;
    })
    .join("\n");
  return capChars(text, resolveMaxChars(options));
}

export interface BudgetTextEdit {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

export interface BudgetEditedFile {
  path: string;
  edits: readonly BudgetTextEdit[];
}

// One replacement's preview: the new text as a quoted literal, so multiline
// edits stay on one line and whitespace stays visible. Capped per edit so a
// single huge insertion cannot eat the whole budget before the cap below.
const EDIT_PREVIEW_CHARS = 120;

function editPreview(newText: string): string {
  const quoted = JSON.stringify(newText);
  if (quoted.length <= EDIT_PREVIEW_CHARS) return quoted;
  return `${quoted.slice(0, EDIT_PREVIEW_CHARS)}…`;
}

/** A rename preview as a file-change list: one header stating the totals and
 *  that nothing was changed, then per-file edit counts with line ranges and
 *  replacement previews. Files sort by path and edits by position, so the
 *  same edit always previews the same way. */
export function formatWorkspaceEdit(
  files: readonly BudgetEditedFile[],
  options?: FormatBudgetOptions,
): string {
  const kept = files.filter((file) => file.edits.length > 0);
  if (kept.length === 0) return "No changes previewed.";
  const ordered = [...kept].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalEdits = ordered.reduce((count, file) => count + file.edits.length, 0);
  const fileWord = ordered.length === 1 ? "file" : "files";
  const editWord = totalEdits === 1 ? "edit" : "edits";
  const lines: string[] = [
    `${totalEdits} ${editWord} across ${ordered.length} ${fileWord} (preview only, nothing was changed):`,
  ];
  for (const file of ordered) {
    const count = file.edits.length;
    lines.push(`${file.path}: ${count} ${count === 1 ? "edit" : "edits"}`);
    const edits = [...file.edits].sort(
      (a, b) => a.line - b.line || a.character - b.character,
    );
    for (const edit of edits) {
      lines.push(
        `  ${edit.line}:${edit.character + 1}-${edit.endLine}:${edit.endCharacter + 1} -> ${editPreview(edit.newText)}`,
      );
    }
  }
  return capChars(lines.join("\n"), resolveMaxChars(options));
}
