// Per-provider MCP config builders (docs/mcp-gateway-design.md §4).
//
// Each adapter turns the gateway connection (loopback URL + per-session bearer
// token) into whatever config its CLI's MCP surface wants. Claude ships the
// SDK-native `mcpServers` builder; OpenCode ships the runtime `mcp.add` config
// `acpMcpServers` builder here — HTTP when the agent advertises
// `agentCapabilities.mcpCapabilities.http`, else the stdio proxy fallback
// `bearer_token_env_var`) is the remaining sibling.

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

/** Whether an ACP initialize result advertises HTTP MCP servers — the decision
 *  that picks the direct HTTP entry over the stdio proxy fallback. Same field
 *  `initializeResult.agentCapabilities.mcpCapabilities.http === true`. */
export function acpAgentSupportsHttp(initializeResult: unknown): boolean {
  const agentCapabilities = record(initializeResult)?.agentCapabilities;
  const mcpCapabilities = record(agentCapabilities)?.mcpCapabilities;
  return record(mcpCapabilities)?.http === true;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
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

/** The opencode remote-server config, registered at runtime via the server's
 *  a live `opencode serve` — the route returns a per-server status map). */
export function buildOpenCodeMcpServer(connection: GatewayConnection): {
  type: string;
  url: string;
  enabled: boolean;
  headers: Record<string, string>;
  oauth: boolean;
} {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: `Bearer ${connection.bearerToken}` },
    oauth: false,
  };
}
