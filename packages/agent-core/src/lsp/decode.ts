// Protocol decoding for language-server results.
//
// The wire gives untyped values; every function here narrows them with the
// shared json guards and returns protocol shapes, so callers map typed data
// to display text instead of re-narrowing raw json at each call site.
// Anything without a usable shape drops out — as null, an empty list, or
// empty text — rather than failing the whole answer.

import { asInt, isJsonList, isJsonNumber, isRecord, jsonText } from "./json.js";
import type {
  LspDiagnostic,
  LspDocumentSymbol,
  LspJsonValue,
  LspLocation,
  LspPosition,
  LspRange,
  LspTextEdit,
  LspWorkspaceEdit,
} from "./types.js";

export function decodePosition(value: LspJsonValue | undefined): LspPosition | null {
  if (!isRecord(value)) return null;
  const line = value.line;
  const character = value.character;
  if (!isJsonNumber(line) || !isJsonNumber(character)) return null;
  return { line, character };
}

export function decodeRange(value: LspJsonValue | undefined): LspRange | null {
  if (!isRecord(value)) return null;
  const start = decodePosition(value.start);
  const end = decodePosition(value.end);
  if (start === null || end === null) return null;
  return { start, end };
}

export function decodeLocation(value: LspJsonValue | undefined): LspLocation | null {
  if (!isRecord(value)) return null;
  const uri = jsonText(value.uri);
  const range = decodeRange(value.range);
  if (uri === null || range === null) return null;
  return { uri, range };
}

// A single location, a list of them, or null all collapse to a list; items
// with no usable shape drop out rather than failing the whole answer.
export function decodeLocationList(value: LspJsonValue): LspLocation[] {
  const items = isJsonList(value) ? value : [value];
  const kept: LspLocation[] = [];
  for (const item of items) {
    const location = decodeLocation(item);
    if (location !== null) kept.push(location);
  }
  return kept;
}

export function decodeDiagnostic(value: LspJsonValue): LspDiagnostic | null {
  if (!isRecord(value)) return null;
  const range = decodeRange(value.range);
  const message = jsonText(value.message);
  if (range === null || message === null) return null;
  const diagnostic: LspDiagnostic = { range, message };
  const severity = asInt(value.severity);
  if (severity === 1 || severity === 2 || severity === 3 || severity === 4) {
    diagnostic.severity = severity;
  }
  const code = value.code;
  if (isJsonNumber(code)) {
    diagnostic.code = code;
  } else {
    const codeText = jsonText(code);
    if (codeText !== null) diagnostic.code = codeText;
  }
  const source = jsonText(value.source);
  if (source !== null) diagnostic.source = source;
  return diagnostic;
}

// Hover contents arrive as a string, one marked-up block, or a list of those;
// the decoded value is their concatenation. Anything else reads as empty,
// which the formatter reports as no hover information.
export function decodeHover(value: LspJsonValue): string {
  if (!isRecord(value)) return "";
  return hoverContentsText(value.contents);
}

function hoverContentsText(value: LspJsonValue | undefined): string {
  const direct = jsonText(value);
  if (direct !== null) return direct;
  if (isRecord(value)) return jsonText(value.value) ?? "";
  if (isJsonList(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = hoverContentsText(item);
      if (part.length > 0) parts.push(part);
    }
    return parts.join("\n");
  }
  return "";
}

export function decodeDocumentSymbols(value: LspJsonValue): LspDocumentSymbol[] {
  if (!isJsonList(value)) return [];
  const kept: LspDocumentSymbol[] = [];
  for (const item of value) {
    const symbol = decodeDocumentSymbol(item);
    if (symbol !== null) kept.push(symbol);
  }
  return kept;
}

function decodeDocumentSymbol(value: LspJsonValue): LspDocumentSymbol | null {
  if (!isRecord(value)) return null;
  const name = jsonText(value.name);
  const range = decodeRange(value.range);
  if (name === null || range === null) return null;
  const symbol: LspDocumentSymbol = {
    name,
    // The kind code passes through uninterpreted and no reader branches on
    // it, so an unusable kind degrades to 0 rather than dropping the symbol.
    kind: asInt(value.kind) ?? 0,
    range,
    // The name's own range positions the pointer; servers that omit it still
    // get a pointer at the node's full range.
    selectionRange: decodeRange(value.selectionRange) ?? range,
  };
  const detail = jsonText(value.detail);
  if (detail !== null) symbol.detail = detail;
  if (isJsonList(value.children)) {
    symbol.children = decodeDocumentSymbols(value.children);
  }
  return symbol;
}

// One flattened document symbol: its slash-qualified name with the position
// the pointer should land on. Zero-based offsets, as decoded.
export interface FlatDocumentSymbol {
  name: string;
  detail: string | null;
  line: number;
  character: number;
}

// Document symbols nest; flatten them with slash-joined container names so
// one line still names the symbol's home.
export function flattenDocumentSymbols(symbols: readonly LspDocumentSymbol[]): FlatDocumentSymbol[] {
  const out: FlatDocumentSymbol[] = [];
  flattenInto(symbols, "", out);
  return out;
}

function flattenInto(
  symbols: readonly LspDocumentSymbol[],
  prefix: string,
  out: FlatDocumentSymbol[],
): void {
  for (const symbol of symbols) {
    const qualified = prefix.length > 0 ? `${prefix}/${symbol.name}` : symbol.name;
    out.push({
      name: qualified,
      detail: symbol.detail ?? null,
      line: symbol.selectionRange.start.line,
      character: symbol.selectionRange.start.character,
    });
    if (symbol.children !== undefined) flattenInto(symbol.children, qualified, out);
  }
}

// A workspace hit: the decoded symbol plus the uri it was found at, since
// workspace hits (unlike document symbols) do not inherit the queried file.
export interface WorkspaceSymbolHit {
  uri: string;
  name: string;
  detail: string | null;
  line: number;
  character: number;
}

export function decodeWorkspaceSymbols(value: LspJsonValue): WorkspaceSymbolHit[] {
  if (!isJsonList(value)) return [];
  const out: WorkspaceSymbolHit[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = jsonText(item.name);
    const location = decodeLocation(item.location);
    if (name === null || location === null) continue;
    const container = jsonText(item.containerName);
    out.push({
      uri: location.uri,
      name: container === null ? name : `${container}/${name}`,
      detail: jsonText(item.detail),
      line: location.range.start.line,
      character: location.range.start.character,
    });
  }
  return out;
}

// Only the `changes` shape is decoded: rename answers use it, and the
// `documentChanges` variant exists for versioned application — which a
// preview-only tool never performs.
export function decodeWorkspaceEdit(value: LspJsonValue): LspWorkspaceEdit {
  if (!isRecord(value) || !isRecord(value.changes)) return { changes: {} };
  const changes: { [uri: string]: LspTextEdit[] } = {};
  for (const [uri, rawEdits] of Object.entries(value.changes)) {
    if (!isJsonList(rawEdits)) continue;
    const edits: LspTextEdit[] = [];
    for (const raw of rawEdits) {
      if (!isRecord(raw)) continue;
      const range = decodeRange(raw.range);
      const newText = jsonText(raw.newText);
      if (range === null || newText === null) continue;
      edits.push({ range, newText });
    }
    changes[uri] = edits;
  }
  return { changes };
}
