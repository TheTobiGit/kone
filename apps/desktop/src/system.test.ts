import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// system.ts imports electron bindings at module top (only used inside
// functions), and Bun cannot load the electron package outside Electron — so
// stub the package before importing the module under test. `ipcMain`,
// `nativeTheme`, `screen`, and `app` are required even though this file never
// touches them: an electron mock that omits a key leaks into later files that do.
const openPathCalls: string[] = [];
const showItemInFolderCalls: string[] = [];
let openPathResult = "";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp" },
  screen: { getAllDisplays: () => [] },
  ipcMain: { handle: () => {} },
  nativeTheme: { themeSource: "system" },
  shell: {
    openPath: async (p: string) => {
      openPathCalls.push(p);
      return openPathResult;
    },
    showItemInFolder: (p: string) => {
      showItemInFolderCalls.push(p);
    },
  },
}));

const electron = await import("electron");
const { reveal } = await import("./system.js");

// Electron mocks leak across files: whichever test file stubs the package
// first wins for the rest of the suite. Re-bind the spies onto the live
// `shell` object so these assertions hold whether this file or another
// installed the mock.
electron.shell.openPath = async (p: string) => {
  openPathCalls.push(p);
  return openPathResult;
};
electron.shell.showItemInFolder = (p: string) => {
  showItemInFolderCalls.push(p);
};

let tempRoot: string;
let subdir: string;
let filePath: string;

beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "kone-system-test-"));
  subdir = path.join(tempRoot, "subdir");
  mkdirSync(subdir, { recursive: true });
  filePath = path.join(subdir, "notes.txt");
  writeFileSync(filePath, "contents");
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  openPathCalls.length = 0;
  showItemInFolderCalls.length = 0;
  openPathResult = "";
});

describe("reveal", () => {
  test("reveals a directory via openPath with the resolved absolute path", async () => {
    await reveal(subdir);

    expect(openPathCalls).toEqual([path.resolve(subdir)]);
    expect(showItemInFolderCalls).toEqual([]);
  });

  test("reveals a file via showItemInFolder and does not launch it", async () => {
    await reveal(filePath);

    expect(showItemInFolderCalls).toEqual([path.resolve(filePath)]);
    expect(openPathCalls).toEqual([]);
  });

  test("rejects a path that does not exist without calling the shell", async () => {
    const missing = path.join(tempRoot, "does-not-exist");

    await expect(reveal(missing)).rejects.toThrow();

    expect(openPathCalls).toEqual([]);
    expect(showItemInFolderCalls).toEqual([]);
  });

  test("rejects an empty string without calling the shell", async () => {
    await expect(reveal("")).rejects.toThrow();

    expect(openPathCalls).toEqual([]);
    expect(showItemInFolderCalls).toEqual([]);
  });

  test("rejects a whitespace-only target without calling the shell", async () => {
    await expect(reveal("   ")).rejects.toThrow();

    expect(openPathCalls).toEqual([]);
    expect(showItemInFolderCalls).toEqual([]);
  });

  test("rejects a non-string without calling the shell", async () => {
    // SAFETY: deliberate wrong-type input; reveal() must validate and reject it.
    await expect(reveal(42 as never)).rejects.toThrow();
    // SAFETY: deliberate wrong-type input; reveal() must validate and reject it.
    await expect(reveal(null as never)).rejects.toThrow();

    expect(openPathCalls).toEqual([]);
    expect(showItemInFolderCalls).toEqual([]);
  });

  test("rejects when openPath returns an error string", async () => {
    openPathResult = "Failed to open";

    await expect(reveal(subdir)).rejects.toThrow("Failed to open");

    expect(openPathCalls).toEqual([path.resolve(subdir)]);
    expect(showItemInFolderCalls).toEqual([]);
  });
});
