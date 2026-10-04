import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
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

  // A database codex created in the overlay is the overlay's own; its log and
  // shared memory must be too. Linked to the real home's, they belong to
  // another database, and codex cannot open this one.
  test("a database of the overlay's own keeps its sidecars local, while a linked one's are linked", () => {
    const source = makeHome();
    for (const name of ["thread_history_1.sqlite", "state_5.sqlite"]) {
      for (const suffix of ["", "-wal", "-shm"]) writeFileSync(path.join(source, name + suffix), "real home");
    }
    const overlay = makeHome() + "/overlay";
    mkdirSync(overlay);
    writeFileSync(path.join(overlay, "thread_history_1.sqlite"), "overlay's own");
    // What an earlier build left: links beside the overlay's own database.
    symlinkSync(path.join(source, "thread_history_1.sqlite-wal"), path.join(overlay, "thread_history_1.sqlite-wal"));

    prepareCodexHomeOverlay({ endpointUrl: "http://127.0.0.1:41002/mcp", sourceHome: source, overlayHome: overlay });

    expect(readFileSync(path.join(overlay, "thread_history_1.sqlite"), "utf8")).toBe("overlay's own");
    expect(existsSync(path.join(overlay, "thread_history_1.sqlite-wal"))).toBe(false);
    expect(existsSync(path.join(overlay, "thread_history_1.sqlite-shm"))).toBe(false);
    // The real home's files are untouched.
    expect(readFileSync(path.join(source, "thread_history_1.sqlite-wal"), "utf8")).toBe("real home");
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(lstatSync(path.join(overlay, "state_5.sqlite" + suffix)).isSymbolicLink()).toBe(true);
    }
  });

  // Without the right to make symlinks (Windows, unelevated) a database is
  // copied. Codex keeps it open in WAL mode, so its newest committed changes
  // may sit only in the log: the copy must carry them, and the log itself is
  // never copied beside it.
  test("a database that cannot be linked is copied whole, with the changes still in its log", () => {
    const source = makeHome();
    const live = new Database(path.join(source, "thread_history_1.sqlite"));
    try {
      live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      live.exec("CREATE TABLE threads (id TEXT)");
      live.exec("INSERT INTO threads VALUES ('thread-1')");
      expect(statSync(path.join(source, "thread_history_1.sqlite-wal")).size).toBeGreaterThan(0);
      writeFileSync(path.join(source, "auth.json"), "{}");
      const overlay = makeHome() + "/overlay";

      prepareCodexHomeOverlay({
        endpointUrl: "http://127.0.0.1:41003/mcp",
        sourceHome: source,
        overlayHome: overlay,
        symlink: () => {
          throw new Error("EPERM: operation not permitted, symlink");
        },
      });

      expect(lstatSync(path.join(overlay, "thread_history_1.sqlite")).isFile()).toBe(true);
      expect(existsSync(path.join(overlay, "thread_history_1.sqlite-wal"))).toBe(false);
      expect(existsSync(path.join(overlay, "thread_history_1.sqlite-shm"))).toBe(false);
      const copy = new Database(path.join(overlay, "thread_history_1.sqlite"), { readonly: true });
      try {
        expect(copy.query("SELECT id FROM threads").all()).toEqual([{ id: "thread-1" }]);
      } finally {
        copy.close();
      }
      // Anything that is not a database is still copied as it is.
      expect(readFileSync(path.join(overlay, "auth.json"), "utf8")).toBe("{}");
    } finally {
      live.close();
    }
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
