// Read-only language-server gateway tool (slices 1+2 fronted as MCP).
//
// One tool, `kone_lsp`, fronts the pooled language servers: go-to-definition,
// references, hover, document and workspace symbols, diagnostics, and rename
// previews. Like the scratchpad read it is permission "allow" with no active
// turn required — every action only reads, and rename only previews the edit
// list the server WOULD apply. Nothing here writes to user files, ever: the
// client itself refuses the server's applyEdit requests, and this module never
// calls one.
//
// Addressing follows the resolver contract: agents name a workspace-relative
// path plus a 1-indexed line plus the symbol substring on that line, never a
// column. The one pathless action is a project-wide symbols search, which runs
// workspace/symbol directly — the only server call that needs no file text —
// against a client resolved through a real filename from the project root,
// since the pool keys clients by owning server.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LspAbortError, LspClientError } from "../../lsp/client.js";
import type { LspClient } from "../../lsp/client.js";
import type { LspRequestOptions } from "../../lsp/client.js";
import { LspManager, LspManagerError, LspNoServerError } from "../../lsp/manager.js";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatReferences,
  formatSymbols,
  formatWorkspaceEdit,
} from "../../lsp/responseBudget.js";
import type {
  BudgetDiagnostic,
  BudgetEditedFile,
  BudgetLocation,
  BudgetReference,
  BudgetSymbol,
  BudgetTextEdit,
} from "../../lsp/responseBudget.js";
import { resolvePosition } from "../../lsp/symbolResolver.js";
import type { LspJsonObject, LspJsonValue } from "../../lsp/types.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  ToolEntry,
} from "../schemas.js";
import type { LspToolInput } from "../schemas.js";
import { GatewayToolError, LspToolInputSchema, LSP_JSON_SCHEMA } from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

const LSP_DESCRIPTION = [
  "Read-only language-server insight for the project codebase: go-to-definition, references, hover, document and workspace symbols, diagnostics, and rename previews.",
  "",
  "Address a position with a workspace-relative path plus a 1-indexed line plus the symbol text on that line (there are no column addresses; occurrence picks among repeats of the symbol on the line).",
  "",
  "Every action only reads. Rename returns the edit list the server WOULD apply as a preview and never writes files. Paths must stay inside the project.",
].join("\n");

const LSP_PROMPT_SNIPPET =
  "Ask the language server about project code: definitions, references, hover, symbols, diagnostics, and preview-only renames.";

export interface LspToolOptions {
  manager?: LspManager;
  readTextFile?: (filePath: string) => string | null;
  readDir?: (dirPath: string) => readonly string[];
}

function defaultReadTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function defaultReadDir(dirPath: string): readonly string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

// The registry rethrows AbortError-named failures to the transport instead of
// reporting them, so a cancelled call vanishes with the caller rather than
// reading as a crash. The client's own abort class carries the wrong name,
// hence the rewrap.
function abortError(message: string): Error {
  const abort = new Error(message);
  abort.name = "AbortError";
  return abort;
}

// ── protocol decoding ────────────────────────────────────────────────────────
// The wire gives untyped values, narrowed the way the client does: records by
// constructor, lists by Array.isArray behind a typed guard, numbers by
// finiteness, text by excluding every other variant — never by inspecting
// representations.

function isRecord(value: LspJsonValue | undefined): value is LspJsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonList(value: LspJsonValue | undefined): value is readonly LspJsonValue[] {
  return Array.isArray(value);
}

function isCounted(value: LspJsonValue | undefined): value is number {
  return Number.isFinite(value);
}

function jsonText(value: LspJsonValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isCounted(value)) return null;
  return value;
}

interface DecodedPoint {
  line: number;
  character: number;
}

interface DecodedRange {
  start: DecodedPoint;
  end: DecodedPoint;
}

interface DecodedLocation {
  uri: string;
  range: DecodedRange;
}

function decodePoint(value: LspJsonValue | undefined): DecodedPoint | null {
  if (!isRecord(value)) return null;
  const line = value.line;
  const character = value.character;
  if (!isCounted(line) || !isCounted(character)) return null;
  return { line, character };
}

function decodeRange(value: LspJsonValue | undefined): DecodedRange | null {
  if (!isRecord(value)) return null;
  const start = decodePoint(value.start);
  const end = decodePoint(value.end);
  if (start === null || end === null) return null;
  return { start, end };
}

function decodeLocation(value: LspJsonValue | undefined): DecodedLocation | null {
  if (!isRecord(value)) return null;
  const uri = jsonText(value.uri);
  const range = decodeRange(value.range);
  if (uri === null || range === null) return null;
  return { uri, range };
}

// A single location, a list of them, or null all collapse to a list; items
// with no usable shape drop out rather than failing the whole answer.
function decodeLocationList(value: LspJsonValue): DecodedLocation[] {
  const items = isJsonList(value) ? value : [value];
  const kept: DecodedLocation[] = [];
  for (const item of items) {
    const location = decodeLocation(item);
    if (location !== null) kept.push(location);
  }
  return kept;
}

// Hover contents arrive as a string, one marked-up block, or a list of those.
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

interface DecodedSymbol {
  name: string;
  detail: string | null;
  line: number;
  character: number;
}

// A workspace hit additionally carries the uri it was found at; document
// symbols instead inherit the queried file's path.
interface DecodedWorkspaceSymbol extends DecodedSymbol {
  uri: string;
}

// Document symbols nest; flatten them with slash-joined container names so one
// line still names the symbol's home. The name's own range (selectionRange)
// positions the pointer, falling back to the node's full range.
function flattenDocumentSymbols(
  value: LspJsonValue | undefined,
  prefix: string,
  out: DecodedSymbol[],
): void {
  if (!isJsonList(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = jsonText(item.name);
    const range = decodeRange(item.range);
    if (name === null || range === null) continue;
    const selection = decodeRange(item.selectionRange);
    const at = selection?.start ?? range.start;
    const qualified = prefix.length > 0 ? `${prefix}/${name}` : name;
    out.push({ name: qualified, detail: jsonText(item.detail), line: at.line, character: at.character });
    if (item.children !== undefined) flattenDocumentSymbols(item.children, qualified, out);
  }
}

function decodeWorkspaceSymbols(value: LspJsonValue): DecodedWorkspaceSymbol[] {
  const out: DecodedWorkspaceSymbol[] = [];
  if (!isJsonList(value)) return out;
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

interface DecodedFileEdit {
  uri: string;
  edits: BudgetTextEdit[];
}

// Only the `changes` shape is decoded: rename answers use it, and the
// `documentChanges` variant exists for versioned application — which a
// preview-only tool never performs.
function decodeWorkspaceEdit(value: LspJsonValue): DecodedFileEdit[] {
  if (!isRecord(value)) return [];
  const changes = value.changes;
  if (!isRecord(changes)) return [];
  const files: DecodedFileEdit[] = [];
  for (const [uri, rawEdits] of Object.entries(changes)) {
    if (!isJsonList(rawEdits)) continue;
    const edits: BudgetTextEdit[] = [];
    for (const raw of rawEdits) {
      if (!isRecord(raw)) continue;
      const range = decodeRange(raw.range);
      const newText = jsonText(raw.newText);
      if (range === null || newText === null) continue;
      edits.push({
        line: range.start.line,
        character: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character,
        newText,
      });
    }
    files.push({ uri, edits });
  }
  return files;
}

// ── workspace mapping ────────────────────────────────────────────────────────

// A workspace-relative path resolved against the project root, or null when it
// escapes. Absolute paths inside the project resolve fine; anything climbing
// out with `..` is refused rather than normalized into place.
function resolveInWorkspace(projectRoot: string, relPath: string): string | null {
  const absolute = path.resolve(projectRoot, relPath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return absolute;
}

// Server uris render as workspace-relative paths when they live under the
// project, absolute filesystem paths when they do not, and raw uris when they
// are not files at all.
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

// The didOpen language tag, matching the registry's extension ownership: the
// bundled servers' file types map to their language ids, and anything else
// goes out under its own extension.
function languageIdForPath(filePath: string): string {
  const extension = path.extname(filePath).replace(/^\.+/, "").toLowerCase();
  switch (extension) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    default:
      return extension.length > 0 ? extension : "plaintext";
  }
}

interface LspRunScope {
  manager: LspManager;
  readTextFile: (filePath: string) => string | null;
  readDir: (dirPath: string) => readonly string[];
  ctx: GatewayToolContext;
  projectRoot: string;
  args: LspToolInput;
}

function requestOptions(scope: LspRunScope): LspRequestOptions {
  return { signal: scope.ctx.signal };
}

// Position-needing actions share one rule: a 1-indexed line plus the symbol
// on it, resolved project-aware so a bare line is refused rather than guessed
// at. The resolver's message already names the problem; the wrapper tells the
// agent how to fix it.
function resolveActionPosition(
  action: string,
  text: string,
  line: number | undefined,
  symbol: string | undefined,
  occurrence: number | undefined,
): DecodedPoint {
  if (line === undefined) {
    throw new GatewayToolError(
      "invalid_input",
      `Action "${action}" needs "line" (1-indexed) plus the "symbol" on it; positions are never addressed by column.`,
    );
  }
  const resolved = resolvePosition({
    documentLines: text.split("\n"),
    line1Indexed: line,
    symbol,
    occurrence,
    projectAware: true,
  });
  if (resolved.kind === "error") {
    throw new GatewayToolError(
      "invalid_input",
      `Cannot locate a position: ${resolved.message}. Pass the symbol text on the line, with "occurrence" when it repeats.`,
    );
  }
  return { line: resolved.line, character: resolved.character };
}

function toBudgetLocation(projectRoot: string, location: DecodedLocation): BudgetLocation {
  return {
    path: displayPath(location.uri, projectRoot),
    line: location.range.start.line + 1,
    character: location.range.start.character,
  };
}

// References may point at files other than the queried one; each is read from
// disk for one line of context each side of the match. An unresolvable or
// unreadable file keeps its pointer without context.
function contextLinesFor(scope: LspRunScope, location: DecodedLocation): readonly string[] {
  if (!location.uri.startsWith("file://")) return [];
  let fsPath: string;
  try {
    fsPath = fileURLToPath(location.uri);
  } catch {
    return [];
  }
  const fileText = scope.readTextFile(fsPath);
  if (fileText === null) return [];
  const lines = fileText.split("\n");
  const at = location.range.start.line;
  return lines.slice(Math.max(0, at - 1), at + 2);
}

// workspace/symbol names no file, yet the pool resolves clients per owning
// server — so resolve one through a real filename from the project root. The
// first owned file wins and the query runs on the project's own server;
// nothing owned means the agent must name a file with path.
async function resolveWorkspaceClient(scope: LspRunScope): Promise<LspClient> {
  let entries: readonly string[];
  try {
    entries = scope.readDir(scope.projectRoot);
  } catch {
    entries = [];
  }
  const candidates = entries
    .filter((name) => path.extname(name).length > 0)
    .sort()
    .slice(0, 200);
  for (const name of candidates) {
    try {
      return await scope.manager.getClient({
        cwd: scope.projectRoot,
        filePath: path.join(scope.projectRoot, name),
      });
    } catch (error) {
      if (error instanceof LspNoServerError) continue;
      throw error;
    }
  }
  throw new GatewayToolError(
    "invalid_input",
    "No language server owns any file in this project; pass \"path\" to a file in the language to search so the right server can be found.",
  );
}

async function runDefinition(
  scope: LspRunScope,
  client: LspClient,
  uri: string,
  text: string,
): Promise<GatewayToolResult> {
  const position = resolveActionPosition(
    "definition",
    text,
    scope.args.line,
    scope.args.symbol,
    scope.args.occurrence,
  );
  const params: LspJsonObject = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
  };
  const result = await client.request("textDocument/definition", params, requestOptions(scope));
  const locations = decodeLocationList(result).map((location) =>
    toBudgetLocation(scope.projectRoot, location),
  );
  return {
    content: [{ type: "text", text: formatLocations(locations) }],
    structuredContent: {
      locations: locations.map((location) => ({
        path: location.path,
        line: location.line,
        character: location.character,
      })),
    },
  };
}

async function runReferences(
  scope: LspRunScope,
  client: LspClient,
  uri: string,
  text: string,
): Promise<GatewayToolResult> {
  const position = resolveActionPosition(
    "references",
    text,
    scope.args.line,
    scope.args.symbol,
    scope.args.occurrence,
  );
  await scope.manager.ensureProjectLoaded(client, requestOptions(scope));
  const params: LspJsonObject = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
    context: { includeDeclaration: true },
  };
  const result = await scope.manager.referencesWithRetry(
    client,
    params,
    { uri, line: position.line, character: position.character },
    requestOptions(scope),
  );
  const refs: BudgetReference[] = decodeLocationList(result).map((location) => ({
    path: displayPath(location.uri, scope.projectRoot),
    line: location.range.start.line + 1,
    character: location.range.start.character,
    contextLines: contextLinesFor(scope, location),
  }));
  return {
    content: [{ type: "text", text: formatReferences(refs) }],
    structuredContent: {
      references: refs.map((ref) => ({
        path: ref.path,
        line: ref.line,
        character: ref.character,
        contextLines: [...ref.contextLines],
      })),
    },
  };
}

async function runHover(
  scope: LspRunScope,
  client: LspClient,
  uri: string,
  text: string,
): Promise<GatewayToolResult> {
  const position = resolveActionPosition(
    "hover",
    text,
    scope.args.line,
    scope.args.symbol,
    scope.args.occurrence,
  );
  const params: LspJsonObject = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
  };
  const result = await client.request("textDocument/hover", params, requestOptions(scope));
  const output = formatHover(isRecord(result) ? hoverContentsText(result.contents) : "");
  return {
    content: [{ type: "text", text: output }],
    structuredContent: { hover: output },
  };
}

async function runDocumentSymbols(
  scope: LspRunScope,
  client: LspClient,
  uri: string,
  relPath: string,
): Promise<GatewayToolResult> {
  const params: LspJsonObject = { textDocument: { uri } };
  const result = await client.request(
    "textDocument/documentSymbol",
    params,
    requestOptions(scope),
  );
  const flat: DecodedSymbol[] = [];
  flattenDocumentSymbols(result, "", flat);
  const symbols: BudgetSymbol[] = flat.map((symbol) => {
    const entry: BudgetSymbol = {
      name: symbol.name,
      path: relPath,
      line: symbol.line + 1,
      character: symbol.character,
    };
    if (symbol.detail !== null) entry.detail = symbol.detail;
    return entry;
  });
  return {
    content: [{ type: "text", text: formatSymbols(symbols) }],
    structuredContent: {
      symbols: symbols.map((symbol) => ({
        name: symbol.name,
        detail: symbol.detail ?? null,
        path: symbol.path,
        line: symbol.line,
        character: symbol.character,
      })),
    },
  };
}

async function runWorkspaceSymbols(
  scope: LspRunScope,
  query: string,
): Promise<GatewayToolResult> {
  const client = await resolveWorkspaceClient(scope);
  const params: LspJsonObject = { query };
  const result = await client.request("workspace/symbol", params, requestOptions(scope));
  const symbols: BudgetSymbol[] = decodeWorkspaceSymbols(result).map((symbol) => {
    const entry: BudgetSymbol = {
      name: symbol.name,
      path: displayPath(symbol.uri, scope.projectRoot),
      line: symbol.line + 1,
      character: symbol.character,
    };
    if (symbol.detail !== null) entry.detail = symbol.detail;
    return entry;
  });
  return {
    content: [{ type: "text", text: formatSymbols(symbols) }],
    structuredContent: {
      symbols: symbols.map((symbol) => ({
        name: symbol.name,
        detail: symbol.detail ?? null,
        path: symbol.path,
        line: symbol.line,
        character: symbol.character,
      })),
    },
  };
}

async function runDiagnostics(
  client: LspClient,
  uri: string,
  relPath: string,
): Promise<GatewayToolResult> {
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
    content: [{ type: "text", text: formatDiagnostics(diagnostics) }],
    structuredContent: {
      diagnostics: diagnostics.map((diagnostic) => ({
        path: diagnostic.path,
        line: diagnostic.line,
        character: diagnostic.character,
        severity: diagnostic.severity ?? null,
        source: diagnostic.source ?? null,
        message: diagnostic.message,
      })),
    },
  };
}

async function runRename(
  scope: LspRunScope,
  client: LspClient,
  uri: string,
  text: string,
): Promise<GatewayToolResult> {
  const newName = scope.args.newName;
  if (newName === undefined) {
    throw new GatewayToolError(
      "invalid_input",
      "Rename needs \"newName\": the name the symbol should become.",
    );
  }
  const position = resolveActionPosition(
    "rename",
    text,
    scope.args.line,
    scope.args.symbol,
    scope.args.occurrence,
  );
  const params: LspJsonObject = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
    newName,
  };
  // Preview only: the edit is formatted into a file-change list and returned
  // as data. It is never applied and never written — applying stays a write
  // tool's job, with its own permission and turn gating.
  const result = await client.request("textDocument/rename", params, requestOptions(scope));
  const files: BudgetEditedFile[] = decodeWorkspaceEdit(result).map((file) => ({
    path: displayPath(file.uri, scope.projectRoot),
    edits: file.edits.map((edit) => ({
      line: edit.line + 1,
      character: edit.character,
      endLine: edit.endLine + 1,
      endCharacter: edit.endCharacter,
      newText: edit.newText,
    })),
  }));
  const editCount = files.reduce((count, file) => count + file.edits.length, 0);
  return {
    content: [{ type: "text", text: formatWorkspaceEdit(files) }],
    structuredContent: {
      previewOnly: true,
      fileCount: files.length,
      editCount,
      files: files.map((file) => ({
        path: file.path,
        edits: file.edits.map((edit) => ({
          line: edit.line,
          character: edit.character,
          endLine: edit.endLine,
          endCharacter: edit.endCharacter,
          newText: edit.newText,
        })),
      })),
    },
  };
}

/**
 * Creates the read-only language-server gateway tool, `kone_lsp`.
 */
export function createLspTools(options: LspToolOptions = {}): ToolEntry[] {
  const manager = options.manager ?? new LspManager();
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const readDir = options.readDir ?? defaultReadDir;

  const handler = async (
    ctx: GatewayToolContext,
    input: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = LspToolInputSchema.safeParse(input);
    if (!parsed.success) {
      return gatewayToolErrorResult(
        new GatewayToolError("invalid_input", parsed.error.message),
      );
    }
    const scope: LspRunScope = {
      manager,
      readTextFile,
      readDir,
      ctx,
      projectRoot: path.resolve(ctx.cwd),
      args: parsed.data,
    };
    try {
      const action = scope.args.action;
      if (action === "symbols" && scope.args.path === undefined) {
        return await runWorkspaceSymbols(scope, scope.args.query ?? "");
      }
      const relPath = scope.args.path;
      if (relPath === undefined) {
        throw new GatewayToolError(
          "invalid_input",
          `Action "${action}" needs "path": name a workspace-relative file inside the project.`,
        );
      }
      const absPath = resolveInWorkspace(scope.projectRoot, relPath);
      if (absPath === null) {
        throw new GatewayToolError(
          "invalid_input",
          `Path "${relPath}" escapes the project root; pass a workspace-relative path inside the project.`,
        );
      }
      const text = scope.readTextFile(absPath);
      if (text === null) {
        throw new GatewayToolError(
          "invalid_input",
          `Cannot read file "${relPath}": it is missing or unreadable.`,
        );
      }
      const client = await scope.manager.getClient({
        cwd: scope.projectRoot,
        filePath: absPath,
      });
      const uri = pathToFileURL(absPath).toString();
      client.openDocument(uri, languageIdForPath(absPath), text);
      switch (action) {
        case "definition":
          return await runDefinition(scope, client, uri, text);
        case "references":
          return await runReferences(scope, client, uri, text);
        case "hover":
          return await runHover(scope, client, uri, text);
        case "symbols":
          return await runDocumentSymbols(scope, client, uri, relPath);
        case "diagnostics":
          return await runDiagnostics(client, uri, relPath);
        case "rename":
          return await runRename(scope, client, uri, text);
      }
    } catch (error) {
      if (error instanceof GatewayToolError) throw error;
      // Cancellation is not a tool failure: rewrap so the registry hands it
      // to the transport instead of reporting an internal error.
      if (error instanceof LspAbortError) throw abortError(error.message);
      // No server owns the file (or a configured one is disabled): the agent
      // can fix its args, so this is invalid input, not an outage.
      if (error instanceof LspNoServerError) {
        throw new GatewayToolError("invalid_input", error.message);
      }
      if (error instanceof LspManagerError || error instanceof LspClientError) {
        throw new GatewayToolError("internal", error.message);
      }
      throw error;
    }
  };

  return [
    {
      name: "kone_lsp",
      description: LSP_DESCRIPTION,
      inputSchema: LspToolInputSchema,
      jsonSchema: LSP_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: LSP_PROMPT_SNIPPET,
      handler,
    },
  ];
}
