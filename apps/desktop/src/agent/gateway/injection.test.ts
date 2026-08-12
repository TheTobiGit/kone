// Per-adapter gateway injection builders (docs/mcp-gateway-design.md §4).
//
// The ACP builder is the Phase B surface: cursor/droid sessions get a direct
// loopback HTTP entry when their agent advertises mcpCapabilities.http, else
// the stdio proxy fallback — ACP headers and env are arrays of { name,
// value }, never records.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  acpAgentSupportsHttp,
  acpMcpServers,
  KONE_GATEWAY_TOKEN_ENV,
  KONE_GATEWAY_URL_ENV,
  KONE_MCP_SERVER_NAME,
  STDIO_PROXY_PATH,
} from "./injection.js";

const CONNECTION = { url: "http://127.0.0.1:41231/mcp", bearerToken: "kone_gw_token-1" };

describe("acpAgentSupportsHttp", () => {
  test("true only when agentCapabilities.mcpCapabilities.http is exactly true", () => {
    expect(acpAgentSupportsHttp({ agentCapabilities: { mcpCapabilities: { http: true } } })).toBe(true);
    expect(acpAgentSupportsHttp({ agentCapabilities: { mcpCapabilities: { http: false } } })).toBe(false);
    expect(acpAgentSupportsHttp({ agentCapabilities: { mcpCapabilities: {} } })).toBe(false);
    expect(acpAgentSupportsHttp({ agentCapabilities: {} })).toBe(false);
    expect(acpAgentSupportsHttp({})).toBe(false);
    expect(acpAgentSupportsHttp(undefined)).toBe(false);
    expect(acpAgentSupportsHttp(null)).toBe(false);
    // http: 1 is not true — the ACP field is a boolean, be strict about it.
    expect(acpAgentSupportsHttp({ agentCapabilities: { mcpCapabilities: { http: 1 } } })).toBe(false);
  });
});

describe("acpMcpServers", () => {
  test("http-capable agent: direct loopback entry with an Authorization header array", () => {
    expect(acpMcpServers(CONNECTION, { httpCapable: true })).toEqual([
      {
        type: "http",
        name: KONE_MCP_SERVER_NAME,
        url: CONNECTION.url,
        headers: [{ name: "Authorization", value: `Bearer ${CONNECTION.bearerToken}` }],
      },
    ]);
  });

  test("no http capability: stdio proxy entry spawning this runtime with URL+token env", () => {
    const [entry] = acpMcpServers(CONNECTION, { httpCapable: false });
    expect(entry).toEqual({
      name: KONE_MCP_SERVER_NAME,
      command: process.execPath,
      args: [STDIO_PROXY_PATH],
      env: [
        { name: KONE_GATEWAY_URL_ENV, value: CONNECTION.url },
        { name: KONE_GATEWAY_TOKEN_ENV, value: CONNECTION.bearerToken },
      ],
    });
  });

  test("the stdio proxy script actually exists at the resolved path", () => {
    expect(existsSync(STDIO_PROXY_PATH)).toBe(true);
  });
});
