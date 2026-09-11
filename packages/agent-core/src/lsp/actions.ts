// Per-action language-server work behind the gateway tool.
//
// The gateway tool validates input, resolves the file, and owns the client;
// every function here takes that resolved state and performs one server round
// trip. Each returns its display text plus the structured payload together,
// so every pointer is built once and read twice. Reference context lines come
// from one read per file, not one per reference.

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LspClient } from "./client.js";
import {
  decodeDocumentSymbols,
  decodeHover,
  decodeLocationList,
  decodeWorkspaceEdit,
  decodeWorkspaceSymbols,
  flattenDocumentSymbols,
} from "./decode.js";
import type { LspManager } from "./manager.js";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatReferences,
  formatSymbols,
  formatWorkspaceEdit,
} from "./responseBudget.js";
import type {
  BudgetDiagnostic,
  BudgetEditedFile,
  BudgetLocation,
  BudgetReference,
  BudgetSymbol,
} from "./responseBudget.js";
import type {
  LspClientHandle,
  LspJsonObject,
  LspLocation,
  LspPosition,
} from "./types.js";

// Everything one action needs beyond its own arguments: the pool, the
// project the paths render against, file reads for reference context, and
// the caller's cancellation signal, passed straight to each request.
export interface LspActionDeps {
  manager: LspManager;
  projectRoot: string;
  readTextFile: (filePath: string) => string | null;
  signal?: AbortSignal;
}

// One action's answer: the agent-facing text plus the structured payload,
// built from the same objects.
export interface LspActionResult {
  text: string;
  structured: LspJsonObject;
}

// Server uris render as workspace-relative paths when they live under the
// project, absolute filesystem paths when they do not, and raw uris when
// they are not files at all.
function displayPath(uri: string, projectRoot: string): string {
  if (!uri.startsWith("file://")) return uri;
  let fsPath: string;
  try {
    fsPath = fileURLToPath(uri);
  } catch {
    return uri;
  }
  const relative = path.relative(projectRoot, fsPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) return fsPath;
  return relative;
}

// One pointer built once: the text formatters and the structured payload
// below both read these same objects.
function pointerFor(projectRoot: string, location: LspLocation): BudgetLocation {
  return {
    path: displayPath(location.uri, projectRoot),
    line: location.range.start.line + 1,
    character: location.range.start.character,
  };
}

// Every referenced file read and split a single time, keyed by uri.
// Unresolvable or unreadable files stay absent, and their references keep
// their pointers without context.
function contextLinesByUri(
  readTextFile: (filePath: string) => string | null,
  locations: readonly LspLocation[],
): Map<string, readonly string[]> {
  const byUri = new Map<string, readonly string[]>();
  for (const location of locations) {
    if (byUri.has(location.uri) || !location.uri.startsWith("file://")) continue;
    let fsPath: string;
    try {
      fsPath = fileURLToPath(location.uri);
    } catch {
      continue;
    }
    const fileText = readTextFile(fsPath);
    if (fileText === null) continue;
    byUri.set(location.uri, fileText.split("\n"));
  }
  return byUri;
}

// One line of context each side of the match, or nothing when the file was
// unreadable.
function contextWindow(lines: readonly string[] | undefined, at: number): readonly string[] {
  if (lines === undefined) return [];
  return lines.slice(Math.max(0, at - 1), at + 2);
}

function positionParams(uri: string, position: LspPosition): LspJsonObject {
  return {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
  };
}

export async function definitionAction(
  deps: LspActionDeps,
  client: LspClientHandle,
  uri: string,
  position: LspPosition,
): Promise<LspActionResult> {
  const result = await client.request("textDocument/definition", positionParams(uri, position), {
    signal: deps.signal,
  });
  const locations = decodeLocationList(result).map((location) => pointerFor(deps.projectRoot, location));
  // The spread re-wraps each pointer in a fresh object literal, which the
  // json payload type accepts; the pointer itself was built once above.
  return {
    text: formatLocations(locations),
    structured: { locations: locations.map((location) => ({ ...location })) },
  };
}

export async function referencesAction(
  deps: LspActionDeps,
  client: LspClientHandle,
  uri: string,
  position: LspPosition,
): Promise<LspActionResult> {
  await deps.manager.ensureProjectLoaded(client, { signal: deps.signal });
  const params: LspJsonObject = {
    ...positionParams(uri, position),
    context: { includeDeclaration: true },
  };
  const result = await deps.manager.referencesWithRetry(
    client,
    params,
    { uri, line: position.line, character: position.character },
    { signal: deps.signal },
  );
  const decoded = decodeLocationList(result);
  const files = contextLinesByUri(deps.readTextFile, decoded);
  const references: BudgetReference[] = decoded.map((location) => ({
    ...pointerFor(deps.projectRoot, location),
    contextLines: contextWindow(files.get(location.uri), location.range.start.line),
  }));
  return {
    text: formatReferences(references),
    structured: { references: references.map((reference) => ({ ...reference })) },
  };
}

export async function hoverAction(
  deps: LspActionDeps,
  client: LspClientHandle,
  uri: string,
  position: LspPosition,
): Promise<LspActionResult> {
  const result = await client.request("textDocument/hover", positionParams(uri, position), {
    signal: deps.signal,
  });
  const output = formatHover(decodeHover(result));
  return { text: output, structured: { hover: output } };
}

export async function documentSymbolsAction(
  deps: LspActionDeps,
  client: LspClientHandle,
  uri: string,
  relPath: string,
): Promise<LspActionResult> {
  const result = await client.request(
    "textDocument/documentSymbol",
    { textDocument: { uri } },
    { signal: deps.signal },
  );
  const symbols: BudgetSymbol[] = [];
  for (const symbol of flattenDocumentSymbols(decodeDocumentSymbols(result))) {
    const entry: BudgetSymbol = {
      name: symbol.name,
      path: relPath,
      line: symbol.line + 1,
      character: symbol.character,
    };
    if (symbol.detail !== null) entry.detail = symbol.detail;
    symbols.push(entry);
  }
  return {
    text: formatSymbols(symbols),
    structured: {
      symbols: symbols.map((symbol) => ({ ...symbol, detail: symbol.detail ?? null })),
    },
  };
}

export async function workspaceSymbolsAction(
  deps: LspActionDeps,
  query: string,
): Promise<LspActionResult> {
  const client = await deps.manager.getWorkspaceClient(deps.projectRoot);
  const result = await client.request("workspace/symbol", { query }, { signal: deps.signal });
  const symbols: BudgetSymbol[] = [];
  for (const hit of decodeWorkspaceSymbols(result)) {
    const entry: BudgetSymbol = {
      name: hit.name,
      path: displayPath(hit.uri, deps.projectRoot),
      line: hit.line + 1,
      character: hit.character,
    };
    if (hit.detail !== null) entry.detail = hit.detail;
    symbols.push(entry);
  }
  return {
    text: formatSymbols(symbols),
    structured: {
      symbols: symbols.map((symbol) => ({ ...symbol, detail: symbol.detail ?? null })),
    },
  };
}

export function diagnosticsAction(
  client: LspClient,
  uri: string,
  relPath: string,
): LspActionResult {
  // The cache fills from the server's publishDiagnostics pushes, which the
  // didOpen above triggers; a cold cache reads as clean, never as failure.
  const diagnostics: BudgetDiagnostic[] = client.getDiagnostics(uri).map((diagnostic) => {
    const entry: BudgetDiagnostic = {
      path: relPath,
      line: diagnostic.range.start.line + 1,
      character: diagnostic.range.start.character,
      message: diagnostic.message,
    };
    if (diagnostic.severity !== undefined) entry.severity = diagnostic.severity;
    if (diagnostic.source !== undefined) entry.source = diagnostic.source;
    return entry;
  });
  return {
    text: formatDiagnostics(diagnostics),
    structured: {
      diagnostics: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        severity: diagnostic.severity ?? null,
        source: diagnostic.source ?? null,
      })),
    },
  };
}

export async function renamePreviewAction(
  deps: LspActionDeps,
  client: LspClientHandle,
  uri: string,
  position: LspPosition,
  newName: string,
): Promise<LspActionResult> {
  // Preview only: the edit is formatted into a file-change list and returned
  // as data. It is never applied and never written — applying stays a write
  // tool's job, with its own permission and turn gating.
  const params: LspJsonObject = { ...positionParams(uri, position), newName };
  const result = await client.request("textDocument/rename", params, { signal: deps.signal });
  const files: BudgetEditedFile[] = Object.entries(decodeWorkspaceEdit(result).changes ?? {}).map(
    ([editUri, edits]) => ({
      path: displayPath(editUri, deps.projectRoot),
      edits: edits.map((edit) => ({
        line: edit.range.start.line + 1,
        character: edit.range.start.character,
        endLine: edit.range.end.line + 1,
        endCharacter: edit.range.end.character,
        newText: edit.newText,
      })),
    }),
  );
  const editCount = files.reduce((count, file) => count + file.edits.length, 0);
  return {
    text: formatWorkspaceEdit(files),
    structured: {
      previewOnly: true,
      fileCount: files.length,
      editCount,
      files: files.map((file) => ({ ...file, edits: file.edits.map((edit) => ({ ...edit })) })),
    },
  };
}
