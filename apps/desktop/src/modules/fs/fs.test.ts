import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

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

const { FILE_TEXT_CAP, listDir, listProjectDir, readProjectFile, writeProjectFile } = await import("./fs.js");

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
    const result = await listDir("").catch((cause: unknown) => cause);
    if (!(result instanceof Error)) {
      throw new Error('listDir("") resolved instead of rejecting');
    }
    expect(result.message).not.toContain(path.resolve(process.cwd()));
  });

  test("rejects a whitespace-only path", async () => {
    await expect(listDir("   ")).rejects.toThrow(/Missing path/);
  });

  test("rejects non-string inputs", async () => {
    // SAFETY: deliberate test of non-string inputs at runtime boundary
    await expect(listDir(undefined as never)).rejects.toThrow(/Missing path/);
    // SAFETY: deliberate test of non-string inputs at runtime boundary
    await expect(listDir(null as never)).rejects.toThrow(/Missing path/);
    // SAFETY: deliberate test of non-string inputs at runtime boundary
    await expect(listDir(42 as never)).rejects.toThrow();
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
    await expect(listDir(tempDir, signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("project files", () => {
  let project: string;
  let outside: string;

  beforeAll(() => {
    project = mkdtempSync(path.join(os.tmpdir(), "kone-project-test-"));
    outside = mkdtempSync(path.join(os.tmpdir(), "kone-outside-test-"));
    mkdirSync(path.join(project, "src", "lib"), { recursive: true });
    mkdirSync(path.join(project, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(project, ".git"));
    mkdirSync(path.join(project, ".github"));
    writeFileSync(path.join(project, "README.md"), "# hi\n");
    writeFileSync(path.join(project, "b.ts"), "export {};\n");
    writeFileSync(path.join(project, "src", "index.ts"), "console.log(1);\n");
    writeFileSync(path.join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(path.join(project, "big.txt"), "x".repeat(FILE_TEXT_CAP + 10));
    writeFileSync(path.join(outside, "secret.txt"), "nope");
    symlinkSync(path.join(outside, "secret.txt"), path.join(project, "escape.txt"));
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("lists folders first, hides git and packages, keeps other dotfiles", async () => {
    const listing = await listProjectDir(project, "");
    expect(listing.dir).toBe("");
    expect(listing.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      "dir:.github",
      "dir:src",
      "file:b.ts",
      "file:big.txt",
      "file:escape.txt",
      "file:logo.png",
      "file:README.md",
    ]);
    expect(listing.truncated).toBe(false);
  });

  test("returns root-relative paths for nested folders", async () => {
    const listing = await listProjectDir(project, "./src/");
    expect(listing.dir).toBe("src");
    expect(listing.entries).toEqual([
      { name: "lib", path: "src/lib", kind: "dir" },
      { name: "index.ts", path: "src/index.ts", kind: "file" },
    ]);
  });

  test("refuses to list or read outside the project", async () => {
    await expect(listProjectDir(project, "..")).rejects.toThrow(/outside/);
    await expect(listProjectDir(project, outside)).rejects.toThrow(/outside/);
    await expect(readProjectFile(project, "../x")).rejects.toThrow(/outside/);
    // A symlink inside the project that points away is still outside.
    await expect(readProjectFile(project, "escape.txt")).rejects.toThrow(/outside/);
  });

  test("reads text, flags binary, and caps large files", async () => {
    expect(await readProjectFile(project, "src/index.ts")).toEqual({
      text: "console.log(1);\n",
      binary: false,
      truncated: false,
      size: 16,
    });
    const png = await readProjectFile(project, "logo.png");
    expect(png.binary).toBe(true);
    expect(png.text).toBeNull();
    const big = await readProjectFile(project, "big.txt");
    expect(big.truncated).toBe(true);
    expect(big.text?.length).toBe(FILE_TEXT_CAP);
    expect(big.size).toBe(FILE_TEXT_CAP + 10);
  });

  test("refuses to read a directory", async () => {
    await expect(readProjectFile(project, "src")).rejects.toThrow(/not a file/i);
  });

  test("writes project files safely and refuses writing outside", async () => {
    await writeProjectFile(project, "created.md", "# Hello");
    const read = await readProjectFile(project, "created.md");
    expect(read.text).toBe("# Hello");

    await expect(writeProjectFile(project, "../outside.txt", "nope")).rejects.toThrow(/outside/);
  });
});
