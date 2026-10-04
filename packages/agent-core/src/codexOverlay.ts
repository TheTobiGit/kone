import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import type { DatabaseSync } from "./sqlite.js";
import { openDatabaseReadOnly } from "./sqliteReadOnly.js";
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
  /** Stands in for the symlink call, so a test can refuse links the way
   *  Windows does without elevated rights. */
  symlink?: (sourcePath: string, targetPath: string, type: "file" | "junction") => void;
};

/** The files SQLite keeps beside a database, named after it. */
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** The database a SQLite sidecar belongs to, or null for any other entry. */
function sidecarDatabase(entry: string): string | null {
  for (const suffix of SQLITE_SIDECARS) {
    if (entry.endsWith(suffix) && entry.length > suffix.length) return entry.slice(0, -suffix.length);
  }
  return null;
}

/** A real file of the overlay's own, not a link into the real home. */
function isLocalFile(entryPath: string): boolean {
  try {
    return lstatSync(entryPath).isFile();
  } catch {
    return false;
  }
}

/** A database and its write-ahead log and shared memory are one thing to
 *  SQLite: the log only makes sense against the file it was written for. A
 *  database codex created in the overlay — one the real home did not have
 *  when the overlay was built — stays the overlay's own, and so must its
 *  sidecars: linked to the real home's, they pair it with another database's
 *  log, and codex cannot open it. Drop any such link (the overlay's own; the
 *  file it points at is untouched) and never make one. A linked database needs
 *  nothing here: SQLite follows the link and keeps its sidecars beside the
 *  file it points at. */
function unlinkForeignSidecars(overlayHome: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(overlayHome);
  } catch {
    return;
  }
  for (const entry of entries) {
    const database = sidecarDatabase(entry);
    if (database === null || !isLocalFile(path.join(overlayHome, database))) continue;
    const sidecarPath = path.join(overlayHome, entry);
    try {
      if (lstatSync(sidecarPath).isSymbolicLink()) unlinkSync(sidecarPath);
    } catch (err) {
      console.warn(`[agent] could not drop the codex overlay's link ${sidecarPath}:`, err);
    }
  }
}

/** The first bytes of every SQLite database file. */
const SQLITE_HEADER = "SQLite format 3\0";

function isSqliteDatabase(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(fd, header, 0, header.length, 0) === header.length && header.toString("latin1") === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A consistent copy of a live database: SQLite reads it together with its
 *  write-ahead log and writes one self-contained file, so changes codex has
 *  committed to the log but not yet folded into the file are kept. Copying
 *  the file's bytes alone would drop them. The source is opened read-only. */
function snapshotDatabase(sourcePath: string, targetPath: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = openDatabaseReadOnly(sourcePath);
    db.prepare("VACUUM INTO ?").run(targetPath);
  } catch (err) {
    // No copy beats a partial one: codex starts that database afresh here.
    console.warn(`[agent] could not copy the codex database ${sourcePath} into the overlay:`, err);
  } finally {
    db?.close();
  }
}

function linkEntry(
  sourcePath: string,
  targetPath: string,
  entryType: "file" | "dir",
  symlink: NonNullable<CodexOverlayInput["symlink"]>,
): void {
  // Windows needs elevated rights for real symlinks; junctions cover
  // directories without them. Files that cannot be linked are copied instead —
  // auth.json is the one that matters and it is tiny.
  try {
    symlink(sourcePath, targetPath, process.platform === "win32" && entryType === "dir" ? "junction" : "file");
    return;
  } catch {
    // Fall through for files; directories can be created lazily by codex.
  }
  if (entryType !== "file") return;
  // A sidecar is only ever linked: its database's copy below already holds
  // everything in it, and a copied log beside that copy would be replayed
  // onto a file it was never written for.
  if (sidecarDatabase(path.basename(sourcePath)) !== null) return;
  if (isSqliteDatabase(sourcePath)) {
    snapshotDatabase(sourcePath, targetPath);
    return;
  }
  try {
    copyFileSync(sourcePath, targetPath);
  } catch {
    // A missing optional file (history, logs) costs nothing.
  }
}

/** Build (or rebuild) the overlay home and return its path — the value to put
 *  in the child's CODEX_HOME. Throws only when the overlay root itself cannot
 *  be created; callers treat that as "no gateway this session". */
export function prepareCodexHomeOverlay(input: CodexOverlayInput): string {
  const sourceHome = input.sourceHome ?? resolveCodexHome();
  const overlayHome = input.overlayHome ?? userDataPath("codex-home-overlay");
  mkdirSync(overlayHome, { recursive: true });
  unlinkForeignSidecars(overlayHome);

  let entries: string[] = [];
  try {
    entries = readdirSync(sourceHome);
  } catch {
    // No real home yet (fresh machine): the overlay stands alone and codex
    // creates whatever it needs inside it.
  }
  // Databases before their sidecars, so a database copied rather than linked
  // is already the overlay's own when its sidecars come up.
  const ordered = [
    ...entries.filter((entry) => sidecarDatabase(entry) === null),
    ...entries.filter((entry) => sidecarDatabase(entry) !== null),
  ];
  const symlink = input.symlink ?? symlinkSync;
  for (const entry of ordered) {
    if (entry === "config.toml") continue;
    const targetPath = path.join(overlayHome, entry);
    if (existsSync(targetPath)) continue;
    const database = sidecarDatabase(entry);
    if (database !== null && isLocalFile(path.join(overlayHome, database))) continue;
    const sourcePath = path.join(sourceHome, entry);
    let type: "file" | "dir";
    try {
      type = statSync(sourcePath).isDirectory() ? "dir" : "file";
    } catch {
      continue;
    }
    linkEntry(sourcePath, targetPath, type, symlink);
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
