import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CODEX_MANAGED_REGION_BEGIN, CODEX_MANAGED_REGION_END } from "./gateway/injection.js";
import { CODEX_GATEWAY_TOKEN_ENV, prepareCodexHomeOverlay } from "./codexOverlay.js";

// The overlay must give a codex child kone's MCP entry while keeping the
// user's real config.toml untouched — these tests stand up fake homes and read
// back exactly what the overlay would hand to the app-server.

const tempHomes: string[] = [];
afterAll(() => {
  for (const home of tempHomes) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "kone-codex-home-"));
  tempHomes.push(home);
  return home;
}

function overlayFor(sourceHome: string, url: string): string {
  return prepareCodexHomeOverlay({
    endpointUrl: url,
    sourceHome,
    overlayHome: makeHome() + "/overlay",
  });
}

/** Everything outside the managed markers — what the user's config contributed. */
function userPart(config: string): string {
  return config.slice(0, config.indexOf(CODEX_MANAGED_REGION_BEGIN)).replace(/\n+$/, "");
}

describe("prepareCodexHomeOverlay", () => {
  test("keeps every non-config entry reachable and rebuilds config with the managed region", () => {
    const source = makeHome();
    writeFileSync(path.join(source, "auth.json"), '{"tokens":{}}');
    writeFileSync(path.join(source, "config.toml"), '[model]\nid = "m"\n');
    mkdirSync(path.join(source, "sessions"));

    const overlay = overlayFor(source, "http://127.0.0.1:41000/mcp");

    expect(readFileSync(path.join(overlay, "auth.json"), "utf8")).toBe('{"tokens":{}}');
    expect(lstatSync(path.join(overlay, "sessions")).isSymbolicLink()).toBe(true);
    const config = readFileSync(path.join(overlay, "config.toml"), "utf8");
    expect(config).toContain('[model]\nid = "m"');
    expect(config).toContain(CODEX_MANAGED_REGION_BEGIN);
    expect(config).toContain('url = "http://127.0.0.1:41000/mcp"');
    expect(config).toContain(`bearer_token_env_var = "${CODEX_GATEWAY_TOKEN_ENV}"`);
  });

  test("the user's real config.toml is never modified", () => {
    const source = makeHome();
    writeFileSync(path.join(source, "config.toml"), "[model]\n");
    overlayFor(source, "http://127.0.0.1:41001/mcp");
    expect(readFileSync(path.join(source, "config.toml"), "utf8")).toBe("[model]\n");
  });

  test("a second build with a new URL replaces the old region instead of stacking", () => {
    const source = makeHome();
    writeFileSync(path.join(source, "config.toml"), "");
    // Same overlay home twice — the realistic across-restarts sequence.
    const overlay = prepareCodexHomeOverlay({
      endpointUrl: "http://127.0.0.1:41002/mcp",
      sourceHome: source,
      overlayHome: makeHome() + "/overlay",
    });
    const rebuilt = prepareCodexHomeOverlay({
      endpointUrl: "http://127.0.0.1:41999/mcp",
      sourceHome: source,
      overlayHome: overlay,
    });
    expect(rebuilt).toBe(overlay);
    const config = readFileSync(path.join(overlay, "config.toml"), "utf8");
    expect((config.match(/mcp_servers\.kone/g) ?? []).length).toBe(1);
    expect(config).toContain("41999");
    expect(config).not.toContain("41002");
  });

  test("a stale unmarked kone server entry is dropped so the table stays unique", () => {
    const source = makeHome();
    writeFileSync(
      path.join(source, "config.toml"),
      '[mcp_servers.kone]\nurl = "http://handwritten"\n\n[other]\nx = 1\n',
    );
    const config = readFileSync(
      path.join(overlayFor(source, "http://127.0.0.1:41003/mcp"), "config.toml"),
      "utf8",
    );
    expect((config.match(/mcp_servers\.kone/g) ?? []).length).toBe(1);
    expect(config).toContain("41003");
    expect(config).not.toContain("handwritten");
    expect(config).toContain("[other]");
  });

  test("merges the token exclusion into an existing user shell policy instead of duplicating the table", () => {
    const source = makeHome();
    writeFileSync(
      path.join(source, "config.toml"),
      '[shell_environment_policy]\nexclude = ["*SECRET*"]\n',
    );
    const config = readFileSync(
      path.join(overlayFor(source, "http://127.0.0.1:41004/mcp"), "config.toml"),
      "utf8",
    );
    expect((config.match(/\[shell_environment_policy\]/g) ?? []).length).toBe(1);
    expect(config).toContain(`"${CODEX_GATEWAY_TOKEN_ENV}"`);
    // The user's own table survives intact inside the user part; kone adds no
    // second one.
    expect(userPart(config)).toBe('[shell_environment_policy]\nexclude = ["*SECRET*", "' + CODEX_GATEWAY_TOKEN_ENV + '"]');
  });

  test("works when the source home does not exist at all", () => {
    const missing = path.join(makeHome(), "does-not-exist");
    const overlay = overlayFor(missing, "http://127.0.0.1:41005/mcp");
    expect(existsSync(path.join(overlay, "config.toml"))).toBe(true);
    expect(readFileSync(path.join(overlay, "config.toml"), "utf8")).toContain(CODEX_MANAGED_REGION_END);
  });

  test("linked auth resolves back to the very file codex would read at the real home", () => {
    const source = makeHome();
    writeFileSync(path.join(source, "auth.json"), "AUTH");
    const overlay = overlayFor(source, "http://127.0.0.1:41006/mcp");
    // A symlink resolves to the original; a copy (symlink refused) still holds
    // identical bytes.
    try {
      expect(realpathSync(path.join(overlay, "auth.json"))).toBe(realpathSync(path.join(source, "auth.json")));
    } catch {
      expect(readFileSync(path.join(overlay, "auth.json"), "utf8")).toBe("AUTH");
    }
  });
});
