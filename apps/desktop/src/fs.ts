import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ipcMain } from "electron";

// ── Data model ──────────────────────────────────────────────────────────────
// Serializable — everything here crosses the IPC boundary to the renderer.
// Mirror any change in apps/web/app/types/desktop.d.ts.

/** A subdirectory of some listed folder. Directories only — this is a folder
 *  browser, so files never appear. */
export type DirEntry = {
  name: string;
  /** Absolute path. */
  path: string;
};

export type DirListing = {
  /** Absolute, normalized path of the listed folder. */
  path: string;
  /** Basename (or the path itself for a filesystem root). */
  name: string;
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  /** Immediate subdirectories, sorted case-insensitively by name. */
  entries: DirEntry[];
};

// ── directory listing ─────────────────────────────────────────────────────────

/** Whether an entry should be hidden from the picker (dotfiles). */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** List the immediate subdirectories of `dir`. Files and dotfiles are omitted.
 *  Symlinks are followed only when they resolve to a directory. */
export async function listDir(dir: string): Promise<DirListing> {
  const abs = path.resolve(dir);
  const dirents = await readdir(abs, { withFileTypes: true });

  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    if (isHidden(dirent.name)) continue;

    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = (await stat(path.join(abs, dirent.name))).isDirectory();
      } catch {
        continue; // dangling / unreadable symlink
      }
    }
    if (!isDir) continue;

    entries.push({ name: dirent.name, path: path.join(abs, dirent.name) });
  }

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const parent = path.dirname(abs);
  return {
    path: abs,
    name: path.basename(abs) || abs,
    parent: parent === abs ? null : parent,
    entries,
  };
}

/** The user's home directory — where the picker opens. */
export function homeDir(): string {
  return os.homedir();
}

// ── IPC ───────────────────────────────────────────────────────────────────────

/** Register the fs:* IPC handlers. Call once, before creating the window. */
export function registerFsIpc(): void {
  ipcMain.handle("fs:home", () => homeDir());
  ipcMain.handle("fs:list-dir", (_event, dir: string) => listDir(dir));
}
