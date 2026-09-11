// Contracts for the read-only language-server integration.
//
// Slice 1 is pure types only: json-rpc framing, the protocol params/results
// the six actions use, and the manager-side config/handle contracts. The
// client and manager that fulfill LspClientHandle arrive in a later slice,
// which is why every executable decision (spawning, caching, file reading)
// lives outside this file.

/** Plain json data, mirroring the gateway's value contract so payloads cross
 *  into tool results without conversion. Arrays stay readonly; records stay
 *  writable so builders can assemble params field by field. */
export type LspJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly LspJsonValue[]
  | LspJsonObject;

export interface LspJsonObject {
  [key: string]: LspJsonValue;
}

// ── json-rpc framing ─────────────────────────────────────────────────────────
// Messages travel with a Content-Length header on the wire; these are the
// decoded bodies after the framing layer strips it.

export type LspJsonRpcId = string | number | null;

export interface LspRequestMessage {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: LspJsonValue;
}

export interface LspResponseMessage {
  jsonrpc: "2.0";
  id: LspJsonRpcId;
  result?: LspJsonValue;
  error?: LspResponseError;
}

export interface LspNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: LspJsonValue;
}

export interface LspResponseError {
  code: number;
  message: string;
  data?: LspJsonValue;
}

// ── protocol params/results ──────────────────────────────────────────────────
// The subset the six actions need: definition, references, hover, document
// symbols, diagnostics, and rename preview.

/** Zero-based line and utf-16 character offset, per the protocol. Character
 *  counts utf-16 code units, so astral characters occupy two columns. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspMarkupContent {
  kind: "markdown" | "plaintext";
  value: string;
}

export type LspHoverContents =
  | string
  | LspMarkupContent
  | readonly (string | LspMarkupContent)[];

export interface LspHover {
  contents: LspHoverContents;
  range?: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  /** The server's integer symbol-kind code, passed through uninterpreted. */
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  children?: readonly LspDocumentSymbol[];
}

/** 1 = error, 2 = warning, 3 = information, 4 = hint. */
export type LspDiagnosticSeverity = 1 | 2 | 3 | 4;

export interface LspDiagnostic {
  range: LspRange;
  severity?: LspDiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** A rename preview: the edit the server WOULD apply, returned as data and
 *  never applied by the integration. Applying stays a gateway write tool's
 *  job, with its own permission and turn gating. */
export interface LspWorkspaceEdit {
  changes?: { [uri: string]: readonly LspTextEdit[] };
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: readonly LspDiagnostic[];
}

// ── manager contracts ────────────────────────────────────────────────────────

/** One language server the manager may start. `name` keys config-file
 *  overrides and the per-command client cache; the remaining fields describe
 *  how to launch the server and which files it owns. */
export interface ServerConfig {
  name: string;
  command: string;
  args: readonly string[];
  /** Extensions without dots, matched case-insensitively ("ts", "tsx"). */
  fileTypes: readonly string[];
  /** didOpen language tags by extension (lowercase, no dots): the tag the
   *  server expects for each owned file type. Entries the map omits fall
   *  back to the extension itself. */
  languageIds?: { readonly [extension: string]: string };
  /** Filenames that mark a project root when walking up from a file. */
  rootMarkers: readonly string[];
  initOptions?: LspJsonObject;
  settings?: LspJsonObject;
  disabled?: boolean;
  warmupTimeoutMs?: number;
}

/** The six read-only actions the gateway tool exposes. Agents address a
 *  position by file plus 1-indexed line plus symbol substring — never by
 *  column — and rename only previews. The action names below match the
 *  gateway tool's input schema exactly; they are the same strings the tool
 *  switches on. */
export const LSP_ACTIONS = [
  "definition",
  "references",
  "hover",
  "symbols",
  "diagnostics",
  "rename",
] as const;

export type LspAction = (typeof LSP_ACTIONS)[number];

/** Per-request overrides: how long to wait plus which signal cancels the
 *  call. A bare number where this is accepted means a timeout on its own. */
export interface LspRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The resolved-client handle slice 2 fulfills: one running server process
 *  rooted at a project directory. Pass null params when the method takes
 *  none. */
export interface LspClientHandle {
  readonly serverName: string;
  readonly rootPath: string;
  request(method: string, params: LspJsonValue, timeoutMs: number): Promise<LspJsonValue>;
  request(method: string, params: LspJsonValue, options?: LspRequestOptions): Promise<LspJsonValue>;
  notify(method: string, params: LspJsonValue): void;
  isRunning(): boolean;
}
