// Which language servers exist and where their binaries come from.
//
// Pure functions only: every filesystem or PATH read arrives through the
// injected ServerBinaryDeps, so tests pass fakes and no suite touches the
// real machine. Spawning, caching, and file reading belong to a later slice.

import path from "node:path";

import { asInt, isJsonList, isRecord, jsonText } from "./json.js";
import type { LspJsonObject, LspJsonValue, ServerConfig } from "./types.js";

// ── default set ──────────────────────────────────────────────────────────────

/** the bundled typescript server over stdio. The didOpen tags split by
 *  extension because the server expects each side of the language under its
 *  own name. */
export const TS_DEFAULT_SERVERS: readonly ServerConfig[] = [
  {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    languageIds: {
      ts: "typescript",
      tsx: "typescript",
      mts: "typescript",
      cts: "typescript",
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    warmupTimeoutMs: 15000,
  },
];

/** the bundled go server: stdio is the default transport, so no flags. */
export const GO_DEFAULT_SERVERS: readonly ServerConfig[] = [
  {
    name: "go",
    command: "gopls",
    args: [],
    fileTypes: ["go"],
    languageIds: { go: "go" },
    rootMarkers: ["go.mod", "go.work"],
    warmupTimeoutMs: 15000,
  },
];

/** the only bundled python server: further python servers arrive as user
 *  overrides, never as bundled alternates. */
export const PYTHON_DEFAULT_SERVERS: readonly ServerConfig[] = [
  {
    name: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: ["py"],
    languageIds: { py: "python" },
    rootMarkers: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "pyrightconfig.json",
    ],
    warmupTimeoutMs: 15000,
  },
];

/** the bundled rust server: stdio is the default transport, so no flags. */
export const RUST_DEFAULT_SERVERS: readonly ServerConfig[] = [
  {
    name: "rust",
    command: "rust-analyzer",
    args: [],
    fileTypes: ["rs"],
    languageIds: { rs: "rust" },
    rootMarkers: ["Cargo.toml"],
    warmupTimeoutMs: 15000,
  },
];

/** every bundled server in match order: typescript, go, python, rust.
 *  serversForFile returns matches in this order, so the first entry wins
 *  when two servers claim one extension. no bundled extensions overlap
 *  today; the order keeps the tie-break deterministic if that changes. */
export const ALL_DEFAULT_SERVERS: readonly ServerConfig[] = [
  ...TS_DEFAULT_SERVERS,
  ...GO_DEFAULT_SERVERS,
  ...PYTHON_DEFAULT_SERVERS,
  ...RUST_DEFAULT_SERVERS,
];

// ── binary resolution ────────────────────────────────────────────────────────

/** The machine access binary resolution may use. Tests fake both members;
 *  the real implementation wires existsSync from node:fs and lookupOnPath
 *  from a PATH search. */
export interface ServerBinaryDeps {
  existsSync(candidatePath: string): boolean;
  lookupOnPath(command: string): string | null;
}

/** Candidate shim names for one directory's node_modules/.bin. Windows lays
 *  down .cmd shims next to the extensionless entry, so both spellings count
 *  there; everywhere else the bare name is the whole story. */
function binNames(command: string, platform: string): readonly string[] {
  if (platform === "win32") return [command, `${command}.cmd`];
  return [command];
}

/** Every node_modules/.bin slot from cwd up to the filesystem root, nearest
 *  first. Exported so tests can pin the windows spelling without a windows
 *  machine; resolveServerBinary below always passes the live platform. */
export function localBinCandidates(
  cwd: string,
  command: string,
  platform: string,
): readonly string[] {
  const names = binNames(command, platform);
  const candidates: string[] = [];
  let current: string | null = path.resolve(cwd);
  while (current !== null) {
    for (const name of names) {
      candidates.push(path.join(current, "node_modules", ".bin", name));
    }
    const parent = path.dirname(current);
    current = parent === current ? null : parent;
  }
  return candidates;
}

/** A command naming a file rather than a binary: absolute, or carrying a
 *  separator so it resolves against the project directory. */
function isPathCommand(command: string): boolean {
  return command.includes("/") || command.includes(path.sep);
}

/** Resolve a server's command to an executable path: project-local bins
 *  first (walking up from cwd, so a monorepo root's install wins over PATH),
 *  then PATH. Path-shaped commands resolve against cwd and never consult
 *  PATH. Null when nothing on the machine provides the server. */
export function resolveServerBinary(
  server: ServerConfig,
  cwd: string,
  deps: ServerBinaryDeps,
): string | null {
  if (isPathCommand(server.command)) {
    const candidate = path.isAbsolute(server.command)
      ? server.command
      : path.join(path.resolve(cwd), server.command);
    return deps.existsSync(candidate) ? candidate : null;
  }
  for (const candidate of localBinCandidates(cwd, server.command, process.platform)) {
    if (deps.existsSync(candidate)) return candidate;
  }
  return deps.lookupOnPath(server.command);
}

// ── config files ─────────────────────────────────────────────────────────────

/** Global overrides live at this filename under the injected user-data
 *  directory; slice 2 reads them via userDataPath(LSP_GLOBAL_CONFIG_FILENAME). */
export const LSP_GLOBAL_CONFIG_FILENAME = "lsp.json";

/** Project overrides live at <cwd>/.kone/lsp.json. No other per-project kone
 *  directory exists yet — user-level state hangs off the injected data
 *  directory and project discovery hangs off tool-owned dot-dirs — so this
 *  file establishes the .kone spelling for project-local kone settings. */
export const LSP_PROJECT_CONFIG_DIRNAME = ".kone";
export const LSP_PROJECT_CONFIG_FILENAME = "lsp.json";

/** The well-known project override path for a checkout. Pure string join;
 *  reading the file is slice 2's job. */
export function projectLspConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), LSP_PROJECT_CONFIG_DIRNAME, LSP_PROJECT_CONFIG_FILENAME);
}

/** One server's worth of overrides from a config file: every field optional,
 *  every present field replaces the default wholesale. */
export interface LspServerOverride {
  command?: string;
  args?: readonly string[];
  fileTypes?: readonly string[];
  /** didOpen language tags by extension, same shape as the server's own. */
  languageIds?: { readonly [extension: string]: string };
  rootMarkers?: readonly string[];
  initOptions?: LspJsonObject;
  settings?: LspJsonObject;
  disabled?: boolean;
  warmupTimeoutMs?: number;
}

export interface LspConfigFile {
  servers: { [name: string]: LspServerOverride };
}

function jsonFlag(value: LspJsonValue | undefined): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/** Lenient string list: non-string items drop out, a non-array drops the
 *  whole override. Blank command strings likewise keep the default — an
 *  empty command could never resolve to a binary. */
function jsonStringArray(value: LspJsonValue | undefined): readonly string[] | null {
  if (!isJsonList(value)) return null;
  const kept: string[] = [];
  for (const item of value) {
    const text = jsonText(item);
    if (text !== null) kept.push(text);
  }
  return kept;
}

function jsonTimeoutMs(value: LspJsonValue | undefined): number | null {
  const parsed = asInt(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

// Lenient extension-to-tag map: non-string values drop out, a non-record
// drops the whole override. Keys normalize like fileTypes (dots, case), so
// ".TS" and "ts" name the same tag.
function jsonLanguageIds(value: LspJsonValue | undefined): { [extension: string]: string } | null {
  if (!isRecord(value)) return null;
  const kept: { [extension: string]: string } = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const extension = normalizeExtension(rawKey);
    const tag = jsonText(rawValue);
    if (extension !== null && tag !== null && tag.trim().length > 0) kept[extension] = tag;
  }
  return kept;
}

function jsonOptionsObject(value: LspJsonValue | undefined): LspJsonObject | null {
  return isRecord(value) ? value : null;
}

function decodeServerOverride(raw: LspJsonValue | undefined): LspServerOverride | null {
  if (!isRecord(raw)) return null;
  const override: LspServerOverride = {};
  const command = jsonText(raw.command);
  if (command !== null && command.trim().length > 0) override.command = command;
  const args = jsonStringArray(raw.args);
  if (args !== null) override.args = args;
  const fileTypes = jsonStringArray(raw.fileTypes);
  if (fileTypes !== null) override.fileTypes = fileTypes;
  const languageIds = jsonLanguageIds(raw.languageIds);
  if (languageIds !== null) override.languageIds = languageIds;
  const rootMarkers = jsonStringArray(raw.rootMarkers);
  if (rootMarkers !== null) override.rootMarkers = rootMarkers;
  const initOptions = jsonOptionsObject(raw.initOptions);
  if (initOptions !== null) override.initOptions = initOptions;
  const settings = jsonOptionsObject(raw.settings);
  if (settings !== null) override.settings = settings;
  const disabled = jsonFlag(raw.disabled);
  if (disabled !== null) override.disabled = disabled;
  const warmupTimeoutMs = jsonTimeoutMs(raw.warmupTimeoutMs);
  if (warmupTimeoutMs !== null) override.warmupTimeoutMs = warmupTimeoutMs;
  return override;
}

/** Decode a parsed lsp.json document. Null for a missing file or a document
 *  with no usable shape; entries naming no known server are dropped here, so
 *  a typo in a config file can never summon an arbitrary binary. */
export function decodeLspConfigFile(raw: LspJsonValue): LspConfigFile | null {
  if (!isRecord(raw)) return null;
  const serversRaw = raw.servers;
  if (serversRaw === undefined || serversRaw === null) return { servers: {} };
  if (!isRecord(serversRaw)) return null;
  const servers: { [name: string]: LspServerOverride } = {};
  for (const name of Object.keys(serversRaw)) {
    const decoded = decodeServerOverride(serversRaw[name]);
    if (decoded !== null) servers[name] = decoded;
  }
  return { servers };
}

/** A disable at any layer sticks: once any file says disabled true, no other
 *  layer's false or absent flag re-enables the server. */
function mergeDisabled(
  base: boolean | undefined,
  override: boolean | undefined,
): boolean | undefined {
  if (base === true || override === true) return true;
  return override ?? base;
}

// A fresh copy of an extension-to-tag map, or undefined when there is none:
// merged configs never share the map with the layer they came from.
function copyLanguageIds(
  source: { readonly [extension: string]: string } | undefined,
): { readonly [extension: string]: string } | undefined {
  if (source === undefined) return undefined;
  return { ...source };
}

/** One override layer over one server. Inputs are treated as immutable —
 *  array fields come out as fresh copies — and object fields (settings,
 *  initOptions) replace wholesale rather than merging key by key. */
function applyServerOverride(
  base: ServerConfig,
  override: LspServerOverride | undefined,
): ServerConfig {
  if (override === undefined) {
    return {
      ...base,
      args: [...base.args],
      fileTypes: [...base.fileTypes],
      languageIds: copyLanguageIds(base.languageIds),
      rootMarkers: [...base.rootMarkers],
    };
  }
  return {
    name: base.name,
    command: override.command ?? base.command,
    args: override.args ?? [...base.args],
    fileTypes: override.fileTypes ?? [...base.fileTypes],
    languageIds: copyLanguageIds(override.languageIds ?? base.languageIds),
    rootMarkers: override.rootMarkers ?? [...base.rootMarkers],
    initOptions: override.initOptions ?? base.initOptions,
    settings: override.settings ?? base.settings,
    disabled: mergeDisabled(base.disabled, override.disabled),
    warmupTimeoutMs: override.warmupTimeoutMs ?? base.warmupTimeoutMs,
  };
}

/** Resolve the effective server list: defaults, then the global file, then
 *  the project file. Either raw document may be null for a missing file.
 *  The default list is never mutated. */
export function mergeServerConfig(
  defaults: readonly ServerConfig[],
  globalRaw: LspJsonValue,
  projectRaw: LspJsonValue,
): readonly ServerConfig[] {
  const globalFile = decodeLspConfigFile(globalRaw);
  const projectFile = decodeLspConfigFile(projectRaw);
  return defaults.map((base) => {
    const afterGlobal = applyServerOverride(base, globalFile?.servers[base.name]);
    return applyServerOverride(afterGlobal, projectFile?.servers[base.name]);
  });
}

// ── file ownership ───────────────────────────────────────────────────────────

/** Lowercase extension without dots; null when there is nothing to match. */
function normalizeExtension(value: string): string | null {
  const bare = value.trim().toLowerCase().replace(/^\.+/, "");
  return bare.length > 0 ? bare : null;
}

/** The servers owning a file, matched by extension only and in registry
 *  order. Disabled filtering happens at startup in a later slice, not here,
 *  so this stays a pure ownership question. */
export function serversForFile(
  servers: readonly ServerConfig[],
  filePath: string,
): readonly ServerConfig[] {
  const wanted = normalizeExtension(path.extname(filePath));
  if (wanted === null) return [];
  return servers.filter((server) =>
    server.fileTypes.some((fileType) => normalizeExtension(fileType) === wanted),
  );
}

// The didOpen language tag for a file: the owning server's tag for the
// extension, the extension itself when the owner names none, and plaintext
// when nothing owns the file. The owner prefers enabled servers, mirroring
// startup resolution — a disabled server still answers when it is the only
// owner, since its files would have opened under that tag.
export function languageIdForFile(
  servers: readonly ServerConfig[],
  filePath: string,
): string {
  const extension = normalizeExtension(path.extname(filePath));
  if (extension === null) return "plaintext";
  const owned = serversForFile(servers, filePath);
  const owner = owned.find((server) => server.disabled !== true) ?? owned[0];
  const tag = owner?.languageIds?.[extension];
  if (tag !== undefined && tag.trim().length > 0) return tag;
  return extension;
}
