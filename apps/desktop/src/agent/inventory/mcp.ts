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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

// ── JSON reading ─────────────────────────────────────────────────────────────

type JsonReadResult = { kind: "ok"; data: unknown } | { kind: "missing" } | { kind: "error"; message: string };

async function readOptionalJsonFile(filePath: string): Promise<JsonReadResult> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    return isEnoent(error) ? { kind: "missing" } : { kind: "error", message: errorMessage(error) };
  }
  if (!info.isFile()) return { kind: "missing" };
  if (info.size > MAX_FILE_BYTES) {
    return { kind: "error", message: `file exceeds the ${MAX_FILE_BYTES}-byte read cap` };
  }
  try {
    const raw = await readFile(filePath, "utf8");
    return { kind: "ok", data: JSON.parse(raw) };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

function recordAt(data: unknown, key: string): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const value = (data as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// ── Shape normalization ──────────────────────────────────────────────────────
// Every config source names its transport/command/env fields slightly
// differently; these fold them all onto McpServerEntry's shape.

function normalizeTransport(raw: Record<string, unknown>): McpTransport {
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
  if (type === "stdio" || type === "local") return "stdio";
  if (type === "http" || type === "streamable-http" || type === "remote") return "http";
  if (type === "sse" || type === "se") return "sse";
  if (type === "ws" || type === "websocket") return "ws";
  // No explicit tag: shape-discriminated per the ACP schema (research doc
  // §2) — a `command` means stdio, a `url` means http.
  if (typeof raw.command !== "undefined") return "stdio";
  if (typeof raw.url === "string") return "http";
  return "unknown";
}

// opencode's `command` is an argv array (`["bun", "x", "pkg"]`); every other
// source splits `command` (a string) + `args` (an array). Handle both.
function normalizeCommand(command: unknown, extraArgs: string[]): { command: string | null; args: string[] } {
  if (Array.isArray(command)) {
    const parts = command.filter((item): item is string => typeof item === "string");
    const [first, ...rest] = parts;
    return { command: first ?? null, args: [...rest, ...extraArgs] };
  }
  if (typeof command === "string" && command.trim()) {
    return { command, args: extraArgs };
  }
  return { command: null, args: extraArgs };
}

// Key NAMES only — never the values, which may hold API keys/tokens.
function envKeyNames(env: unknown): string[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  return Object.keys(env as Record<string, unknown>);
}

function genericEnabledFlag(raw: unknown): boolean | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.enabled === "boolean") return record.enabled;
  if (typeof record.disabled === "boolean") return !record.disabled;
  return null;
}

function buildEntry(input: {
  name: string;
  raw: unknown;
  sourcePath: string;
  sourceLabel: string;
  scope: "user" | "project";
  enabled: boolean | null;
}): McpServerEntry {
  const record = input.raw && typeof input.raw === "object" ? (input.raw as Record<string, unknown>) : {};
  const { command, args } = normalizeCommand(record.command, stringArray(record.args));
  return {
    name: input.name,
    transport: normalizeTransport(record),
    command,
    args,
    url: typeof record.url === "string" ? record.url : null,
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
    if (projectEntry && typeof projectEntry === "object") {
      const record = projectEntry as Record<string, unknown>;
      approval = { enabled: stringArray(record.enabledMcpjsonServers), disabled: stringArray(record.disabledMcpjsonServers) };
      const projectServers = recordAt(record, "mcpServers");
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
