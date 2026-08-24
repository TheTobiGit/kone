// Per-provider MCP config builders (docs/mcp-gateway-design.md §4).
//
// Each adapter turns the gateway connection (loopback URL + per-session bearer
// token) into whatever config its CLI's MCP surface wants. Claude ships the
// SDK-native `mcpServers` builder; OpenCode ships the runtime `mcp.add` config;
// Cursor/Droid ship the ACP `acpMcpServers` builder here — HTTP when the agent
// advertises `agentCapabilities.mcpCapabilities.http`, else the stdio proxy
// fallback. Codex reads MCP servers only from its config.toml, which is shared
// by every session of one Codex home — so its builder (`codexGatewayConfigToml`)
// emits a managed TOML block that references the bearer token BY NAME
// (`bearer_token_env_var`) and is written into kone's private CODEX_HOME
// overlay (see codexOverlay.ts), never into the user's own config file.

import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import type { GatewayConnection } from "../types.js";

/** The ACP MCP server name both entry shapes ship under. */
export const KONE_MCP_SERVER_NAME = "kone";

/** Env vars the stdio proxy reads (stdioProxy.mjs). The token is set ONLY in
 *  the proxy's own spawn env (the ACP `env` array) — never in the provider
 *  CLI's env (buildCursorEnv/buildDroidEnv), so exec-tool descendants cannot
 *  inherit it. */
export const KONE_GATEWAY_URL_ENV = "KONE_GATEWAY_URL";
export const KONE_GATEWAY_TOKEN_ENV = "KONE_GATEWAY_TOKEN";

/** The stdio proxy script the ACP fallback spawns. Resolved relative to this
 *  module so the same relative path works from source (dev: src/agent/gateway/
 *  stdioProxy.mjs) and from the bundled main (build: dist/stdioProxy.mjs, where
 *  scripts/build.ts copies it next to the bundle). */
export const STDIO_PROXY_PATH = fileURLToPath(new URL("./stdioProxy.mjs", import.meta.url));

/** ACP `McpServer` entry shapes (the SDK's `McpServerHttp` / `McpServerStdio`).
 *  Note the ACP spellings: headers AND env are arrays of `{ name, value }`,
 *  never records. */
export type AcpHttpMcpServer = {
  type: "http";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
};
export type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};
export type AcpMcpServer = AcpHttpMcpServer | AcpStdioMcpServer;

import { z } from "zod";
import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";

const AcpCapabilitiesWire = z.object({
  agentCapabilities: z.object({
    mcpCapabilities: z.object({
      http: z.boolean().optional(),
    }).optional(),
  }).optional(),
}).passthrough();

/** Whether an ACP initialize result advertises HTTP MCP servers — the decision
 *  that picks the direct HTTP entry over the stdio proxy fallback. Same field
 *  `initializeResult.agentCapabilities.mcpCapabilities.http === true`. */
export function acpAgentSupportsHttp(initializeResult: JsonValue | null | undefined): boolean {
  const parsed = AcpCapabilitiesWire.safeParse(initializeResult);
  return parsed.success && parsed.data.agentCapabilities?.mcpCapabilities?.http === true;
}

/** The Cursor/Droid (ACP) MCP server config for one gateway connection
 *  `mcpCapabilities.http` gets the direct loopback HTTP entry; otherwise the
 *  session spawns the stdio proxy (stdioProxy.mjs) which forwards JSON-RPC to
 *  the same HTTP endpoint. The bearer token rides the HTTP Authorization
 *  header or the proxy's spawn env — it never enters the provider CLI's own
 *  process env. */
export function acpMcpServers(
  connection: GatewayConnection,
  options: { httpCapable: boolean },
): AcpMcpServer[] {
  if (options.httpCapable) {
    return [
      {
        type: "http",
        name: KONE_MCP_SERVER_NAME,
        url: connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${connection.bearerToken}` }],
      },
    ];
  }
  return [
    {
      name: KONE_MCP_SERVER_NAME,
      command: process.execPath,
      args: [STDIO_PROXY_PATH],
      env: [
        { name: KONE_GATEWAY_URL_ENV, value: connection.url },
        { name: KONE_GATEWAY_TOKEN_ENV, value: connection.bearerToken },
      ],
    },
  ];
}

/** The Claude SDK's HTTP MCP server config, injected into
 *  startFreshSession's options. */
export function claudeMcpServers(connection: GatewayConnection): Record<string, McpServerConfig> {
  return {
    kone: {
      type: "http",
      url: connection.url,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
      // MCP tools are deferred behind tool search and servers connect
      // non-blocking by default; alwaysLoad forces the tools into the prompt
      // and blocks startup until the gateway answers (5s cap), so a session
      // either has the tools or fails loudly — never silently without them.
      alwaysLoad: true,
    },
  };
}

/** One entry of opencode's remote-MCP config: where the server is, how to
 *  authorize against it, and whether it is live. */
export type OpenCodeMcpServer = {
  type: string;
  url: string;
  enabled: boolean;
  headers: Record<string, string>;
  oauth: boolean;
};

/** The gateway as an opencode remote server, registered at runtime against a
 *  live `opencode serve`. */
export function buildOpenCodeMcpServer(connection: GatewayConnection): OpenCodeMcpServer {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: `Bearer ${connection.bearerToken}` },
    oauth: false,
  };
}

// ── Codex managed config block ───────────────────────────────────────────────
// The app-server is handed a private CODEX_HOME overlay whose config.toml is
// the user's config plus this one managed region. The bearer token exists only
// in the app-server process's env; the config names the env var, never the
// value, so nothing secret ever lands on disk.

/** Comment fences bracketing kone's region inside the overlay config.toml.
 *  Comments are inert to TOML, so fencing real tables this way is safe — and
  *  lets a later rebuild strip exactly what kone wrote last time. */
export const CODEX_MANAGED_REGION_BEGIN = "# --- kone managed config (begin) ---";
export const CODEX_MANAGED_REGION_END = "# --- kone managed config (end) ---";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The managed region for one gateway endpoint: the kone MCP server entry plus
 *  — when the user's own config has no `[shell_environment_policy]` table of
 *  its own (`includeShellPolicy`) — one that keeps the bearer-token var out of
 *  exec'd commands. When the user DOES have a policy table, their policy
 *  governs and the caller must merge the exclusion into it instead (see
 *  insertShellEnvPolicyExclude); emitting two tables with one header would be
 *  invalid TOML. */
export function codexGatewayConfigToml(endpointUrl: string, includeShellPolicy: boolean): string {
  const lines = [
    `[mcp_servers.${KONE_MCP_SERVER_NAME}]`,
    `url = ${tomlString(endpointUrl)}`,
    `bearer_token_env_var = ${tomlString(KONE_GATEWAY_TOKEN_ENV)}`,
  ];
  if (includeShellPolicy) {
    lines.push("", "[shell_environment_policy]", `exclude = [${tomlString(KONE_GATEWAY_TOKEN_ENV)}]`);
  }
  return lines.join("\n");
}

/** True when the user's config already defines the exact
 *  `[shell_environment_policy]` table (not a subtable like
 *  `[shell_environment_policy.set]`). */
export function hasShellEnvironmentPolicyTable(contents: string): boolean {
  return /^[\t ]*\[shell_environment_policy\][\t ]*$/m.test(contents);
}

/** Add `envVar` to the existing `[shell_environment_policy]` table's exclude
 *  list. Handles a single-line array; returns contents unchanged when there is
 *  no table or the exclude key is absent/multi-line — callers then fall back to
 *  emitting kone's own policy row in the managed region. */
export function insertShellEnvPolicyExclude(contents: string, envVar: string): string {
  if (!hasShellEnvironmentPolicyTable(contents)) return contents;
  const lines = contents.split("\n");
  // Bounds of the exact-header table: from its header line to the next table
  // header. Subtable headers also end the scan — entries after them belong to
  // the subtable, not this one.
  const start = lines.findIndex((line) => /^[\t ]*\[shell_environment_policy\][\t ]*$/.test(line));
  if (start === -1) return contents;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[\t ]*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const excludeLine = lines.findIndex(
    (line) => /^[\t ]*exclude[\t ]*=/.test(line),
  );
  if (excludeLine < start || excludeLine >= end) {
    lines.splice(start + 1, 0, `exclude = [${tomlString(envVar)}]`);
    return lines.join("\n");
  }
  const match = /^([\t ]*exclude[\t ]*=\s*)\[((?:[^\][]|\[[^\]]*\])*)\](.*)$/.exec(lines[excludeLine]!);
  if (!match?.[1] || match[2] === undefined) return contents; // multi-line or exotic array — leave the user's file alone
  const prefix = match[1];
  const body = match[2];
  const suffix = match[3] ?? "";
  const items = body.trim().length > 0 ? body.split(",").map((item) => item.trim()) : [];
  const quoted = tomlString(envVar);
  if (items.includes(quoted)) return contents;
  items.push(quoted);
  lines[excludeLine] = `${prefix}[${items.join(", ")}]${suffix}`;
  return lines.join("\n");
}

/** Drop everything between the managed-region markers (inclusive), wherever a
 *  previous overlay build left them. */
export function stripCodexManagedRegion(contents: string): string {
  const begin = contents.indexOf(CODEX_MANAGED_REGION_BEGIN);
  if (begin === -1) return contents;
  const endMarkerIndex = contents.indexOf(CODEX_MANAGED_REGION_END, begin);
  const end = endMarkerIndex === -1 ? contents.length : endMarkerIndex + CODEX_MANAGED_REGION_END.length;
  return (contents.slice(0, begin) + contents.slice(end)).replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

/** Remove any `[mcp_servers.kone…]` table the overlay doesn't own — a leftover
 *  from an interrupted write, or a hand-added duplicate that would collide with
 *  kone's entry (two tables under one header is invalid TOML). */
export function removeKoneMcpTables(contents: string): string {
  const lines = contents.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[\t ]*\[+\s*mcp_servers\.kone(?:[.\].]|])/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^[\t ]*\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}
