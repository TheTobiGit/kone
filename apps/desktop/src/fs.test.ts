import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { DirListing } from "./fs.js";

// fs.ts imports electron bindings at module top, and Bun cannot load the
// electron package outside Electron — so stub the package before importing the
// module under test. `app`, `screen`, `ipcMain`, `nativeTheme`, and `shell`
// are all required even though this file never touches most of them: an
// electron mock that omits a key leaks into later files and breaks the suite.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp" },
  screen: { getAllDisplays: () => [] },
  ipcMain: { handle: () => {} },
  nativeTheme: { themeSource: "system" },
  shell: {
    openPath: async () => "",
    showItemInFolder: () => {},
  },
}));

const { listDir } = await import("./fs.js");

let tempDir: string;
let repoDir: string;
let filePath: string;
let linkDir: string;
let brokenLink: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "kone-fs-test-"));
  mkdirSync(path.join(tempDir, "Visible"));
  mkdirSync(path.join(tempDir, ".hidden"));
  writeFileSync(path.join(tempDir, "notes.txt"), "contents");

  repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir);
  writeFileSync(path.join(repoDir, ".git"), "gitdir: ./.git/worktrees/x\n");

  linkDir = path.join(tempDir, "LinkDir");
  symlinkSync(path.join(tempDir, "Visible"), linkDir, "dir");

  brokenLink = path.join(tempDir, "BrokenLink");
  symlinkSync(path.join(tempDir, "does-not-exist"), brokenLink);

  filePath = path.join(tempDir, "notes.txt");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("listDir", () => {
  test("lists visible subdirectories with absolute paths, repo flags, and case-insensitive sort", async () => {
    const listing = await listDir(tempDir);

    expect(listing.path).toBe(path.resolve(tempDir));
    expect(listing.name).toBe(path.basename(path.resolve(tempDir)));
    expect(listing.parent).toBe(path.dirname(path.resolve(tempDir)));
    expect(listing.repo).toBe(false);

    // Dotfiles, files, and dangling symlinks never appear; a symlink to a
    // directory is followed and included. Names sort case-insensitively.
    expect(listing.entries.map((e) => e.name)).toEqual([
      "LinkDir",
      "repo",
      "Visible",
    ]);

    const repoEntry = listing.entries.find((e) => e.name === "repo");
    expect(repoEntry).toBeDefined();
    expect(repoEntry!.repo).toBe(true);
    expect(repoEntry!.path).toBe(path.join(path.resolve(tempDir), "repo"));
  });

  test("rejects an empty string instead of listing the process cwd", async () => {
    // `path.resolve("")` is the process cwd. An empty IPC payload is never a
    // folder the user asked to browse — it must throw, not list that directory.
    await expect(listDir("")).rejects.toThrow(/Missing path/);
  });

  test("never reports the process cwd as the listing path", async () => {
    // Guard the exact regression: resolving "" must not silently expose the
    // Electron process working directory to the renderer.
    const result = await listDir("").catch((err: unknown) => err);
    if (!(result instanceof Error)) {
      expect((result as DirListing).path).not.toBe(path.resolve(process.cwd()));
    }
    expect(result).toBeInstanceOf(Error);
  });

  test("rejects a whitespace-only path", async () => {
    await expect(listDir("   ")).rejects.toThrow(/Missing path/);
  });

  test("rejects non-string inputs", async () => {
    await expect(listDir(undefined as never)).rejects.toThrow(/Missing path/);
    await expect(listDir(null as never)).rejects.toThrow(/Missing path/);
    await expect(listDir(42 as never)).rejects.toThrow(/Missing path/);
  });

  test("rejects a relative path instead of resolving it against the cwd", async () => {
    await expect(listDir("src")).rejects.toThrow(/absolute/);
  });

  test("rejects a path that does not exist", async () => {
    const missing = path.join(tempDir, "does-not-exist");
    await expect(listDir(missing)).rejects.toThrow(/not found/i);
  });

  test("rejects a file instead of listing it as a directory", async () => {
    await expect(listDir(filePath)).rejects.toThrow(/not a directory/i);
  });

  test("expands `~` to the home directory", async () => {
    const listing = await listDir("~");
    expect(path.resolve(listing.path)).toBe(path.resolve(os.homedir()));
  });

  test("rejects when the caller's AbortSignal is already aborted", async () => {
    const signal = AbortSignal.abort();
    await expect(listDir(tempDir, signal as never)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
