import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain } from "electron";

import { withTimeout } from "./ipcTimeout.js";

// `stat` accepts `{ signal }` at runtime so an in-flight probe is cancelled,
// but the installed @types/node predates that field on StatOptions.
type StatOptions = Parameters<typeof stat>[1];

function statOptions(signal: AbortSignal): StatOptions {
  // SAFETY: the object carries only the runtime-accepted `signal` field that
  // @types/node does not declare yet; every caller passes exactly this shape.
  return { signal } as StatOptions;
}

// ── Data model ──────────────────────────────────────────────────────────────
// Serializable — everything here crosses the IPC boundary to the renderer.
// Mirror any change in apps/web/app/types/desktop.d.ts.

/** A subdirectory of some listed folder. Directories only — this is a folder
 *  browser, so files never appear. */
export type DirEntry = {
  name: string;
  path: string;
  /** True when this directory is a git repository root (holds a `.git`). */
  repo: boolean;
};

export type DirListing = {
  /** Absolute, normalized path of the listed folder. */
  path: string;
  /** Basename (or the path itself for a filesystem root). */
  name: string;
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  /** True when the listed folder is itself a git repository root. */
  repo: boolean;
  /** Immediate subdirectories, sorted case-insensitively by name. */
  entries: DirEntry[];
};

// ── directory listing ─────────────────────────────────────────────────────────

/** Whether an entry should be hidden from the picker (dotfiles). */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** True when `dir` is a git repository root. A repo root holds a `.git` —
 *  usually a directory, but a `.git` file for worktrees and submodules — so we
 *  just probe for its presence rather than shelling out to git. */
async function isRepoRoot(dir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await stat(path.join(dir, ".git"), signal ? statOptions(signal) : undefined);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/** List the immediate subdirectories of `dir`. Files and dotfiles are omitted.
 *  Symlinks are followed only when they resolve to a directory. `dir` must be
 *  an absolute path — the picker only ever browses absolute paths. Empty and
 *  relative payloads are rejected before any fs work: `path.resolve("")` is
 *  this process's cwd, the directory the Electron binary was launched from and
 *  never a folder the user asked to browse, and a relative path would silently
 *  list a directory next to the binary instead of failing loudly. */
export async function listDir(dir: string, signal?: AbortSignal): Promise<DirListing> {
  if (!dir || !dir.trim()) {
    throw new Error("Missing path.");
  }

  let target = dir.trim();
  if (target === "~") {
    target = homeDir();
  } else if (target.startsWith("~/") || target.startsWith("~\\")) {
    target = path.join(homeDir(), target.slice(2));
  }

  if (!path.isAbsolute(target)) {
    throw new Error("Path must be absolute.");
  }
  const abs = path.resolve(target);

  // An already-cancelled caller (the IPC deadline) must surface as the abort,
  // not as a path-shaped error below.
  if (signal) {
    if (signal.throwIfAborted) {
      signal.throwIfAborted();
    } else if (signal.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error("Aborted");
    }
  }

  let stats;
  try {
    stats = await stat(abs, signal ? statOptions(signal) : undefined);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Path not found: ${abs}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }

  const dirents = await readdir(abs, { withFileTypes: true });

  const dirs: { name: string; path: string }[] = [];
  for (const dirent of dirents) {
    if (isHidden(dirent.name)) continue;

    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = (
          await stat(path.join(abs, dirent.name), signal ? statOptions(signal) : undefined)
        ).isDirectory();
      } catch (error) {
        if (signal?.aborted) throw error;
        continue; // dangling / unreadable symlink
      }
    }
    if (!isDir) continue;

    dirs.push({ name: dirent.name, path: path.join(abs, dirent.name) });
  }

  // Flag repo roots in parallel — one cheap `.git` probe per subdirectory,
  // plus one for the listed folder itself.
  const [repo, entries] = await Promise.all([
    isRepoRoot(abs, signal),
    Promise.all(
      dirs.map(async (d) => ({ ...d, repo: await isRepoRoot(d.path, signal) })),
    ),
  ]);

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const parent = path.dirname(abs);
  return {
    path: abs,
    name: path.basename(abs) || abs,
    parent: parent === abs ? null : parent,
    repo,
    entries,
  };
}

export function homeDir(): string {
  return os.homedir();
}

// ── IPC ───────────────────────────────────────────────────────────────────────

// The folder listing is bounded by one deadline: a wedged readdir on a network
// share used to hang the picker's `invoke` forever with no way out, and the
// signal also cancels the underlying fs read rather than just abandoning it.
export const FS_LIST_TIMEOUT_MS = 20_000;

/** Register the fs:* IPC handlers. Call once, before creating the window. */
export function registerFsIpc(): void {
  ipcMain.handle("fs:home", () => homeDir());
  ipcMain.handle("fs:list-dir", (_event, dir: string) =>
    withTimeout((signal) => listDir(dir, signal), {
      channel: "fs:list-dir",
      timeoutMs: FS_LIST_TIMEOUT_MS,
    }),
  );
}
