import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CODEX_MANAGED_REGION_BEGIN,
  CODEX_MANAGED_REGION_END,
  codexGatewayConfigToml,
  hasShellEnvironmentPolicyTable,
  insertShellEnvPolicyExclude,
  KONE_GATEWAY_TOKEN_ENV,
  removeKoneMcpTables,
  stripCodexManagedRegion,
} from "./gateway/injection.js";
import { resolveCodexHome } from "./codexHome.js";
import { userDataPath } from "./userDataDir.js";

// kone's private CODEX_HOME overlay for Codex sessions that carry the gateway.
//
// The app-server only reads MCP servers from config.toml, and one config.toml
// is shared by every session of a Codex home — including sessions the user
// runs themselves in a terminal. Writing kone's server entry into the real
// ~/.codex/config.toml would leak it there (pointing at a loopback port that
// is dead the moment kone quits). Instead each gateway session spawns against
// an overlay home: every entry of the real home is linked in unchanged except
// config.toml, which is rebuilt as [user's config] + [one kone-managed region].
// The bearer token never touches disk either way — the managed region names
// the env var (`bearer_token_env_var`) and the value rides only the spawned
// app-server process's environment.
//
// The rebuild starts from the SOURCE config every call, so nothing accumulates
// across sessions: a stale URL from a previous run cannot survive. The one
// thing that must be shared for real is auth/login state and session rollouts
// — those arrive through symlinks, so `codex login` outside kone keeps working
// and resumed threads reopen with their original history.

/** The env var carrying the per-session gateway token into the app-server
 *  process. Same name as the ACP stdio proxy's variable on purpose: one
 *  canonical spelling across every provider surface. */
export const CODEX_GATEWAY_TOKEN_ENV = KONE_GATEWAY_TOKEN_ENV;

export type CodexOverlayInput = {
  /** The live gateway MCP endpoint URL the overlay's server entry should point at. */
  endpointUrl: string;
  /** Overrides for tests. Defaults resolve the real Codex home and kone's
   *  per-user data directory. */
  sourceHome?: string;
  overlayHome?: string;
};

function linkEntry(sourcePath: string, targetPath: string, entryType: "file" | "dir"): void {
  // Windows needs elevated rights for real symlinks; junctions cover
  // directories without them. Files that cannot be linked are copied instead —
  // auth.json is the one that matters and it is tiny.
  try {
    symlinkSync(sourcePath, targetPath, process.platform === "win32" && entryType === "dir" ? "junction" : "file");
    return;
  } catch {
    // Fall through for files; directories can be created lazily by codex.
  }
  if (entryType === "file") {
    try {
      copyFileSync(sourcePath, targetPath);
    } catch {
      // A missing optional file (history, logs) costs nothing.
    }
  }
}

/** Build (or rebuild) the overlay home and return its path — the value to put
 *  in the child's CODEX_HOME. Throws only when the overlay root itself cannot
 *  be created; callers treat that as "no gateway this session". */
export function prepareCodexHomeOverlay(input: CodexOverlayInput): string {
  const sourceHome = input.sourceHome ?? resolveCodexHome();
  const overlayHome = input.overlayHome ?? userDataPath("codex-home-overlay");
  mkdirSync(overlayHome, { recursive: true });

  let entries: string[] = [];
  try {
    entries = readdirSync(sourceHome);
  } catch {
    // No real home yet (fresh machine): the overlay stands alone and codex
    // creates whatever it needs inside it.
  }
  for (const entry of entries) {
    if (entry === "config.toml") continue;
    const targetPath = path.join(overlayHome, entry);
    if (existsSync(targetPath)) continue;
    const sourcePath = path.join(sourceHome, entry);
    let type: "file" | "dir";
    try {
      type = statSync(sourcePath).isDirectory() ? "dir" : "file";
    } catch {
      continue;
    }
    linkEntry(sourcePath, targetPath, type);
  }

  let sourceConfig = "";
  try {
    sourceConfig = readFileSync(path.join(sourceHome, "config.toml"), "utf8");
  } catch {
    // Absent/unreadable source config: start from empty rather than failing
    // the session — the user simply has no personal codex settings yet.
  }
  let config = removeKoneMcpTables(stripCodexManagedRegion(sourceConfig));
  const userHasShellPolicy = hasShellEnvironmentPolicyTable(config);
  if (userHasShellPolicy) {
    config = insertShellEnvPolicyExclude(config, CODEX_GATEWAY_TOKEN_ENV);
  }
  const managed = [
    CODEX_MANAGED_REGION_BEGIN,
    codexGatewayConfigToml(input.endpointUrl, !userHasShellPolicy),
    CODEX_MANAGED_REGION_END,
  ].join("\n");
  const trimmed = config.replace(/\n+$/, "");
  writeFileSync(
    path.join(overlayHome, "config.toml"),
    trimmed.length > 0 ? `${trimmed}\n\n${managed}\n` : `${managed}\n`,
    "utf8",
  );
  return overlayHome;
}
