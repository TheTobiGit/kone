import { open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain } from "electron";

import { withTimeout } from "../../lib/ipcTimeout.js";

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

// ── project files (the Files tab) ─────────────────────────────────────────────
// A read-only look inside one project: its tree one directory at a time, and a
// file's text. Unlike the folder picker above, these are scoped to a project
// root — every path is root-relative and a path that resolves outside the root
// (`..`, an absolute path, a symlink pointing away) is refused.

/** One row of a project directory: a file or a folder. */
export type ProjectEntry = {
  name: string;
  /** Root-relative, `/`-separated. */
  path: string;
  kind: "dir" | "file";
};

export type ProjectDirListing = {
  /** Root-relative directory that was listed ("" for the root). */
  dir: string;
  /** Folders first, then files, each sorted case-insensitively. */
  entries: ProjectEntry[];
  /** True when the directory held more than MAX_DIR_ENTRIES rows. */
  truncated: boolean;
};

export type ProjectFileText = {
  /** The file's text, or null when it is binary or unreadable. */
  text: string | null;
  binary: boolean;
  /** True when only the first FILE_TEXT_CAP bytes were read. */
  truncated: boolean;
  /** Size on disk, in bytes. */
  size: number;
};

/** Names never shown in the tree: git's own store, installed packages, and the
 *  caches frameworks regenerate. Other dotfiles (.github, .env, .gitignore)
 *  stay — they are part of the project. */
const TREE_HIDDEN = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".nuxt",
  ".next",
  ".output",
  ".turbo",
  ".cache",
  ".svelte-kit",
  ".parcel-cache",
]);

export const MAX_DIR_ENTRIES = 2_000;
export const FILE_TEXT_CAP = 512 * 1024;
/** How much of the head is probed for a NUL byte to call a file binary. */
const BINARY_PROBE = 8 * 1024;

/** Resolve a root-relative path to an absolute one inside `root`, following
 *  symlinks, or null when it lands outside. The root itself is canonicalised
 *  too, so a project opened through a symlinked path still contains its own
 *  files. */
async function resolveInside(root: string, rel: string): Promise<string | null> {
  if (!root || !path.isAbsolute(root)) return null;
  if (path.isAbsolute(rel)) return null;
  let realRoot: string;
  let target: string;
  try {
    realRoot = await realpath(root);
    target = await realpath(path.resolve(realRoot, rel));
  } catch {
    return null;
  }
  const inside = target === realRoot || target.startsWith(realRoot + path.sep);
  return inside ? target : null;
}

/** A root-relative directory in the renderer's form: `/`-separated, no leading
 *  `./` or slashes, "" for the root. */
function normalizeRel(rel: string): string {
  const out = rel.replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
  return out === "." ? "" : out;
}

/** List one directory of a project: its folders and files, minus TREE_HIDDEN. */
export async function listProjectDir(root: string, rel: string): Promise<ProjectDirListing> {
  const dir = normalizeRel(rel);
  const abs = await resolveInside(root, dir || ".");
  if (!abs) throw new Error("Path is outside the project.");
  const dirents = await readdir(abs, { withFileTypes: true });

  const entries: ProjectEntry[] = [];
  for (const dirent of dirents) {
    if (TREE_HIDDEN.has(dirent.name)) continue;
    let kind: ProjectEntry["kind"] | null = dirent.isDirectory()
      ? "dir"
      : dirent.isFile()
        ? "file"
        : null;
    if (!kind && dirent.isSymbolicLink()) {
      try {
        const s = await stat(path.join(abs, dirent.name));
        kind = s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
      } catch {
        continue; // dangling link
      }
    }
    if (!kind) continue;
    entries.push({ name: dirent.name, path: dir ? `${dir}/${dirent.name}` : dirent.name, kind });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });
  const truncated = entries.length > MAX_DIR_ENTRIES;
  return {
    dir,
    entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries,
    truncated,
  };
}

/** Read one project file's text, capped at FILE_TEXT_CAP. Only the capped head
 *  is ever read, so opening a multi-gigabyte log costs the same as a small one. */
export async function readProjectFile(root: string, rel: string): Promise<ProjectFileText> {
  const abs = await resolveInside(root, rel);
  if (!abs) throw new Error("Path is outside the project.");
  const s = await stat(abs);
  if (!s.isFile()) throw new Error(`Not a file: ${rel}`);

  const handle = await open(abs, "r");
  try {
    const length = Math.min(s.size, FILE_TEXT_CAP);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    const head = buf.subarray(0, bytesRead);
    const binary = head.subarray(0, BINARY_PROBE).includes(0);
    return {
      text: binary ? null : head.toString("utf8"),
      binary,
      truncated: !binary && s.size > FILE_TEXT_CAP,
      size: s.size,
    };
  } finally {
    await handle.close();
  }
}

/** Write a project file's text. Rejects a path outside the project. */
export async function writeProjectFile(root: string, rel: string, content: string): Promise<void> {
  const dir = normalizeRel(path.dirname(rel));
  const absDir = await resolveInside(root, dir || ".");
  if (!absDir) throw new Error("Path is outside the project.");
  const filename = path.basename(rel);
  const target = path.join(absDir, filename);
  await writeFile(target, content, "utf8");
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
  ipcMain.handle("fs:project-list", (_event, root: string, rel: string) =>
    withTimeout(() => listProjectDir(root, rel), {
      channel: "fs:project-list",
      timeoutMs: FS_LIST_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("fs:project-read", (_event, root: string, rel: string) =>
    withTimeout(() => readProjectFile(root, rel), {
      channel: "fs:project-read",
      timeoutMs: FS_LIST_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("fs:project-write", (_event, root: string, rel: string, content: string) =>
    withTimeout(() => writeProjectFile(root, rel, content), {
      channel: "fs:project-write",
      timeoutMs: FS_LIST_TIMEOUT_MS,
    }),
  );
}
