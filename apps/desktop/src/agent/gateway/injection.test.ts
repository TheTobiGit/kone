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
  CODEX_MANAGED_REGION_BEGIN,
  CODEX_MANAGED_REGION_END,
  codexGatewayConfigToml,
  hasShellEnvironmentPolicyTable,
  insertShellEnvPolicyExclude,
  KONE_GATEWAY_TOKEN_ENV,
  KONE_GATEWAY_URL_ENV,
  KONE_MCP_SERVER_NAME,
  removeKoneMcpTables,
  STDIO_PROXY_PATH,
  stripCodexManagedRegion,
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

describe("codexGatewayConfigToml", () => {
  test("names the server, the endpoint URL, and the token env var — never a token value", () => {
    const toml = codexGatewayConfigToml(CONNECTION.url, true);
    expect(toml).toContain("[mcp_servers.kone]");
    expect(toml).toContain(`url = "${CONNECTION.url}"`);
    expect(toml).toContain(`bearer_token_env_var = "${KONE_GATEWAY_TOKEN_ENV}"`);
    expect(toml).not.toContain(CONNECTION.bearerToken);
  });

  test("with no user shell policy: emits kone's own policy excluding the token var", () => {
    const toml = codexGatewayConfigToml(CONNECTION.url, true);
    expect(toml).toContain("[shell_environment_policy]");
    expect(toml).toContain(`exclude = ["${KONE_GATEWAY_TOKEN_ENV}"]`);
  });

  test("with a user shell policy present: emits no second policy table (invalid TOML)", () => {
    const toml = codexGatewayConfigToml(CONNECTION.url, false);
    expect(toml).not.toContain("shell_environment_policy");
  });
});

describe("hasShellEnvironmentPolicyTable", () => {
  test("true only for the exact table header, not subtables or mentions", () => {
    expect(hasShellEnvironmentPolicyTable("[shell_environment_policy]\n")).toBe(true);
    expect(hasShellEnvironmentPolicyTable("# [shell_environment_policy] is a comment")).toBe(false);
    expect(hasShellEnvironmentPolicyTable("[shell_environment_policy.set]\n")).toBe(false);
  });
});

describe("insertShellEnvPolicyExclude", () => {
  test("adds an exclude line when the table has none", () => {
    const out = insertShellEnvPolicyExclude('[model]\nid = "m"\n\n[shell_environment_policy]\ninherit = "all"\n', KONE_GATEWAY_TOKEN_ENV);
    expect(out).toBe(`[model]\nid = "m"\n\n[shell_environment_policy]\nexclude = ["${KONE_GATEWAY_TOKEN_ENV}"]\ninherit = "all"\n`);
  });

  test("appends into an existing single-line exclude array without duplicates", () => {
    const source = '[shell_environment_policy]\nexclude = ["*SECRET*"]\n';
    const once = insertShellEnvPolicyExclude(source, KONE_GATEWAY_TOKEN_ENV);
    expect(once).toBe(`[shell_environment_policy]\nexclude = ["*SECRET*", "${KONE_GATEWAY_TOKEN_ENV}"]\n`);
    expect(insertShellEnvPolicyExclude(once, KONE_GATEWAY_TOKEN_ENV)).toBe(once);
  });

  test("leaves contents alone when there is no exact table or the array is multi-line", () => {
    expect(insertShellEnvPolicyExclude("[other]\nx = 1\n", KONE_GATEWAY_TOKEN_ENV)).toBe("[other]\nx = 1\n");
    const multiline = '[shell_environment_policy]\nexclude = [\n  "a",\n]\n';
    expect(insertShellEnvPolicyExclude(multiline, KONE_GATEWAY_TOKEN_ENV)).toBe(multiline);
  });

  test("stops at the next table header — entries after it are not this table's", () => {
    const source = '[shell_environment_policy]\n[shell_environment_policy.set]\nPATH = "x"\n';
    const out = insertShellEnvPolicyExclude(source, KONE_GATEWAY_TOKEN_ENV);
    expect(out).toBe(`[shell_environment_policy]\nexclude = ["${KONE_GATEWAY_TOKEN_ENV}"]\n[shell_environment_policy.set]\nPATH = "x"\n`);
  });
});

describe("stripCodexManagedRegion + removeKoneMcpTables", () => {
  test("stripping removes exactly the managed region and nothing else", () => {
    const user = '[model]\nid = "m"\n';
    const withRegion = `${user}\n${CODEX_MANAGED_REGION_BEGIN}\n[mcp_servers.kone]\nurl = "http://x"\n${CODEX_MANAGED_REGION_END}\n`;
    // Trailing blank lines between the user's config and the region collapse
    // to one newline.
    expect(stripCodexManagedRegion(withRegion)).toBe('[model]\nid = "m"\n');
    // An unterminated region still strips to the end rather than leaking.
    const unterminated = `${user}${CODEX_MANAGED_REGION_BEGIN}\n[mcp_servers.kone]\n`;
    expect(stripCodexManagedRegion(unterminated)).toBe(user);
    expect(stripCodexManagedRegion(user)).toBe(user);
  });

  test("removes stray kone MCP tables (any nesting) but leaves other servers", () => {
    const source = [
      "[mcp_servers.kone]",
      'url = "http://stale"',
      "",
      "[mcp_servers.other]",
      'url = "http://keep"',
      "",
      "[mcp_servers.kone.experimental]",
      "flag = true",
    ].join("\n");
    const out = removeKoneMcpTables(source);
    expect(out).not.toContain("kone");
    expect(out).toContain("[mcp_servers.other]");
  });
});
