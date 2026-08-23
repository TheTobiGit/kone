// FILE: mcp.ts
// Purpose: read-only detection of every MCP-server config file kone knows how
// to find (docs/skills-mcp-research.md §2's discovery-root table), normalized
// into one flat McpServerEntry shape regardless of the source's own field
// names. Detection only — kone never writes any of these files (it hosts its
// own MCP gateway instead, see gateway/), and it never surfaces a secret
// VALUE (env values, header values, oauth blocks) — only the KEY NAMES an
// entry declares.
// Exports: discoverMcpServers

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { InventoryError, McpServerEntry, McpTransport } from "./types.js";

const MAX_FILE_BYTES = 256 * 1024;

// One decoded value from a parsed MCP config document; every helper below
// branches on these domain values instead of interrogating representations.
type McpConfigValue = string | number | boolean | null | McpConfigValue[] | { [key: string]: McpConfigValue };

type McpConfigRecord = { [key: string]: McpConfigValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isConfigNumber(value: McpConfigValue | undefined): value is number {
  return Number.isFinite(value);
}

/** Text is the one config variant left after every other variant is excluded
 *  by value — booleans by identity, numbers by finiteness, composites by
 *  their constructors. */
function configText(value: McpConfigValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isConfigNumber(value)) return null;
  return value;
}

function isConfigRecord(value: McpConfigValue | undefined): value is McpConfigRecord {
  return value instanceof Object && !Array.isArray(value);
}

// ── JSON reading ─────────────────────────────────────────────────────────────

type JsonReadResult = { kind: "ok"; data: McpConfigValue } | { kind: "missing" } | { kind: "error"; message: string };

async function readOptionalJsonFile(filePath: string): Promise<JsonReadResult> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (!info.isFile()) return { kind: "missing" };
  if (info.size > MAX_FILE_BYTES) {
    return { kind: "error", message: `file exceeds the ${MAX_FILE_BYTES}-byte read cap` };
  }
  try {
    const raw = await readFile(filePath, "utf8");
    return { kind: "ok", data: JSON.parse(raw) };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function recordAt(data: McpConfigValue | undefined, key: string): McpConfigRecord {
  const value = isConfigRecord(data) ? data[key] : undefined;
  return isConfigRecord(value) ? value : {};
}

function stringArray(value: McpConfigValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => configText(item) !== null) : [];
}

// ── Shape normalization ──────────────────────────────────────────────────────
// Every config source names its transport/command/env fields slightly
// differently; these fold them all onto McpServerEntry's shape.

function normalizeTransport(raw: McpConfigRecord): McpTransport {
  const type = configText(raw.type)?.toLowerCase();
  if (type === "stdio" || type === "local") return "stdio";
  if (type === "http" || type === "streamable-http" || type === "remote") return "http";
  if (type === "sse" || type === "se") return "sse";
  if (type === "ws" || type === "websocket") return "ws";
  // No explicit tag: shape-discriminated per the ACP schema (research doc
  // §2) — a `command` means stdio, a `url` means http.
  if (raw.command !== undefined) return "stdio";
  if (configText(raw.url) !== null) return "http";
  return "unknown";
}

// opencode's `command` is an argv array (`["bun", "x", "pkg"]`); every other
// source splits `command` (a string) + `args` (an array). Handle both.
function normalizeCommand(command: McpConfigValue | undefined, extraArgs: string[]): Pick<McpServerEntry, "command" | "args"> {
  if (Array.isArray(command)) {
    const parts = command.filter((item): item is string => configText(item) !== null);
    const [first, ...rest] = parts;
    return { command: first ?? null, args: [...rest, ...extraArgs] };
  }
  const text = configText(command);
  if (text?.trim()) {
    return { command: text, args: extraArgs };
  }
  return { command: null, args: extraArgs };
}

// Key NAMES only — never the values, which may hold API keys/tokens.
function envKeyNames(env: McpConfigValue | undefined): string[] {
  return isConfigRecord(env) ? Object.keys(env) : [];
}

function genericEnabledFlag(raw: McpConfigValue | undefined): boolean | null {
  const record = isConfigRecord(raw) ? raw : null;
  if (!record) return null;
  if (record.enabled === true || record.enabled === false) return record.enabled;
  if (record.disabled === true || record.disabled === false) return !record.disabled;
  return null;
}

function buildEntry(input: {
  name: string;
  raw: McpConfigValue | undefined;
  sourcePath: string;
  sourceLabel: string;
  scope: "user" | "project";
  enabled: boolean | null;
}): McpServerEntry {
  const record = isConfigRecord(input.raw) ? input.raw : {};
  const { command, args } = normalizeCommand(record.command, stringArray(record.args));
  return {
    name: input.name,
    transport: normalizeTransport(record),
    command,
    args,
    url: configText(record.url),
    envKeys: envKeyNames(record.env ?? record.environment),
    sourcePath: input.sourcePath,
    sourceLabel: input.sourceLabel,
    scope: input.scope,
    enabled: input.enabled,
  };
}

// ── Per-source scans ──────────────────────────────────────────────────────────

async function scanServersFile(input: {
  filePath: string;
  key: string;
  sourceLabel: string;
  scope: "user" | "project";
  errors: InventoryError[];
}): Promise<McpServerEntry[]> {
  const result = await readOptionalJsonFile(input.filePath);
  if (result.kind === "missing") return [];
  if (result.kind === "error") {
    input.errors.push({ source: `mcp:${input.sourceLabel}`, message: result.message });
    return [];
  }
  const servers = recordAt(result.data, input.key);
  return Object.entries(servers).map(([name, raw]) =>
    buildEntry({ name, raw, sourcePath: input.filePath, sourceLabel: input.sourceLabel, scope: input.scope, enabled: genericEnabledFlag(raw) }),
  );
}

function claudeDesktopConfigPath(home: string): string {
  // macOS only — on any other platform this path simply doesn't exist, which
  // reads as "missing" rather than an error.
  return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

type ClaudeApproval = { enabled: string[]; disabled: string[] };

// `~/.claude.json` carries BOTH a user-scope `mcpServers` map and, per
// project, its own `mcpServers` plus `enabledMcpjsonServers` /
// `disabledMcpjsonServers` — the approval lists that gate whether a
// project-committed `.mcp.json` server is actually allowed to run (research
// doc §2's trust-model note: project `.mcp.json` servers are "pending
// approval" until listed there). This reads both scopes and hands the
// approval lists back so the caller can gate the `.mcp.json` entries it
// already collected, instead of special-casing that file's own read.
async function scanClaudeDotJson(
  home: string,
  projectPath: string | null,
  errors: InventoryError[],
): Promise<{ entries: McpServerEntry[]; approval: ClaudeApproval | null }> {
  const filePath = path.join(home, ".claude.json");
  const result = await readOptionalJsonFile(filePath);
  if (result.kind === "missing") return { entries: [], approval: null };
  if (result.kind === "error") {
    errors.push({ source: "mcp:Claude Code · ~/.claude.json", message: result.message });
    return { entries: [], approval: null };
  }

  const entries: McpServerEntry[] = [];
  const userServers = recordAt(result.data, "mcpServers");
  for (const [name, raw] of Object.entries(userServers)) {
    entries.push(
      buildEntry({ name, raw, sourcePath: filePath, sourceLabel: "Claude Code · user", scope: "user", enabled: genericEnabledFlag(raw) }),
    );
  }

  let approval: ClaudeApproval | null = null;
  if (projectPath) {
    const projects = recordAt(result.data, "projects");
    const projectEntry = projects[path.resolve(projectPath)] ?? projects[projectPath] ?? null;
    const projectRecord = isConfigRecord(projectEntry) ? projectEntry : null;
    if (projectRecord) {
      approval = { enabled: stringArray(projectRecord.enabledMcpjsonServers), disabled: stringArray(projectRecord.disabledMcpjsonServers) };
      const projectServers = recordAt(projectRecord, "mcpServers");
      for (const [name, raw] of Object.entries(projectServers)) {
        const enabled = approval.disabled.includes(name) ? false : approval.enabled.includes(name) ? true : genericEnabledFlag(raw);
        entries.push(
          buildEntry({ name, raw, sourcePath: filePath, sourceLabel: "Claude Code · project", scope: "project", enabled }),
        );
      }
    }
  }

  return { entries, approval };
}

// Retroactively stamps the project `.mcp.json` entries this scan already
// produced with `~/.claude.json`'s approval verdict, once that verdict is
// known — the two files are read independently but describe the same servers.
function applyClaudeApproval(entries: McpServerEntry[], mcpJsonPath: string, approval: ClaudeApproval | null): McpServerEntry[] {
  if (!approval) return entries;
  return entries.map((entry) => {
    if (entry.sourcePath !== mcpJsonPath) return entry;
    if (approval.disabled.includes(entry.name)) return { ...entry, enabled: false };
    if (approval.enabled.includes(entry.name)) return { ...entry, enabled: true };
    return entry;
  });
}

/** Reads every MCP config source kone knows how to detect — project
 *  `.mcp.json`, Cursor's project + user `mcp.json`, `.vscode/mcp.json`,
 *  Claude Desktop's config, `~/.claude.json` (user + per-project, honouring
 *  its approval lists), and opencode's project + user `opencode.json` — and
 *  normalizes them all into one flat list.
 *
 *  Every individual source's failure (missing file, EACCES, malformed JSON)
 *  is caught into `errors`; this function never rejects. */
export async function discoverMcpServers(projectPath: string | null): Promise<{
  servers: McpServerEntry[];
  errors: InventoryError[];
}> {
  const home = homedir();
  const errors: InventoryError[] = [];

  const projectMcpJsonPath = projectPath ? path.join(projectPath, ".mcp.json") : null;

  const [claudeJson, ...fileResults] = await Promise.all([
    scanClaudeDotJson(home, projectPath, errors),
    projectMcpJsonPath
      ? scanServersFile({ filePath: projectMcpJsonPath, key: "mcpServers", sourceLabel: "Project · .mcp.json", scope: "project", errors })
      : Promise.resolve([]),
    projectPath
      ? scanServersFile({ filePath: path.join(projectPath, ".cursor", "mcp.json"), key: "mcpServers", sourceLabel: "Cursor · project", scope: "project", errors })
      : Promise.resolve([]),
    projectPath
      ? scanServersFile({ filePath: path.join(projectPath, ".vscode", "mcp.json"), key: "servers", sourceLabel: "VS Code · project", scope: "project", errors })
      : Promise.resolve([]),
    projectPath
      ? scanServersFile({ filePath: path.join(projectPath, "opencode.json"), key: "mcp", sourceLabel: "opencode · project", scope: "project", errors })
      : Promise.resolve([]),
    scanServersFile({ filePath: path.join(home, ".cursor", "mcp.json"), key: "mcpServers", sourceLabel: "Cursor · user", scope: "user", errors }),
    scanServersFile({ filePath: claudeDesktopConfigPath(home), key: "mcpServers", sourceLabel: "Claude Desktop", scope: "user", errors }),
    scanServersFile({ filePath: path.join(home, ".config", "opencode", "opencode.json"), key: "mcp", sourceLabel: "opencode · user", scope: "user", errors }),
  ]);

  const gatedFileResults = projectMcpJsonPath
    ? fileResults.map((list) => applyClaudeApproval(list, projectMcpJsonPath, claudeJson.approval))
    : fileResults;

  const servers = [...claudeJson.entries, ...gatedFileResults.flat()];
  return { servers, errors };
}
