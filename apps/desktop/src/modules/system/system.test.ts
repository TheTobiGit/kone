import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import type { AppearancePush, ThemeRosterEntry } from "./system.js";

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
const { currentAppearance, currentThemeRoster, reveal, setTheme } = await import("./system.js");

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

// The renderer owns the theme library — built-ins plus whatever the user
// imported or authored — and the shell only mirrors what it reports. These
// cover the mirror, because the agent gateway offers themes out of it and a
// roster that empties or fills with junk is a library the agent gets wrong.
describe("appearance mirror", () => {
  const entry = (id: string, overrides: Partial<ThemeRosterEntry> = {}): ThemeRosterEntry => ({
    id,
    label: id,
    blurb: "",
    kind: "fixed",
    appearance: "dark",
    schemes: ["dark"],
    accent: "#a78bfa",
    ground: "#0f1018",
    origin: "built-in",
    ...overrides,
  });

  /** One appearance push, optionally carrying a library. `themes` is loose on
   *  purpose: what crosses IPC is whatever the renderer sent, and validating it
   *  is the thing under test. */
  const push = (themes?: Partial<ThemeRosterEntry>[]) => {
    const state: AppearancePush = {
      themeId: "nocturne",
      themeLabel: "Nocturne",
      mode: "dark",
      scheme: "dark",
      locked: true,
    };
    if (themes) {
      // SAFETY: a malformed entry is the point of these cases; readRosterEntry decides what survives.
      state.themes = themes as ThemeRosterEntry[];
    }
    setTheme("dark", state);
  };

  test("mirrors the appearance and the library the renderer reports", () => {
    push([entry("nocturne"), entry("dracula", { origin: "imported" })]);

    expect(currentAppearance()?.themeId).toBe("nocturne");
    expect(currentThemeRoster()?.map((t) => t.id)).toEqual(["nocturne", "dracula"]);
    expect(currentThemeRoster()?.[1]?.origin).toBe("imported");
  });

  // A mode toggle carries no library, and treating that as "the library is
  // now empty" would take every theme away from the agent until the next push.
  test("keeps the last roster when a push carries none", () => {
    push([entry("nocturne")]);
    push();

    expect(currentThemeRoster()?.map((t) => t.id)).toEqual(["nocturne"]);
  });

  test("drops an entry it cannot read and keeps the rest", () => {
    push([entry("nocturne"), { id: "broken" }, entry("grove", { kind: "adaptive", schemes: ["light", "dark"] })]);

    expect(currentThemeRoster()?.map((t) => t.id)).toEqual(["nocturne", "grove"]);
  });

  // Same reasoning as the missing-roster case: nothing usable arrived, so the
  // last good answer is better than no answer.
  test("keeps the last roster when nothing in a push survives validation", () => {
    push([entry("nocturne")]);
    push([{ id: "broken" }]);

    expect(currentThemeRoster()?.map((t) => t.id)).toEqual(["nocturne"]);
  });

  test("falls back to the theme's own appearance when it reports no schemes", () => {
    push([entry("northlight", { appearance: "light", schemes: [] })]);

    expect(currentThemeRoster()?.[0]?.schemes).toEqual(["light"]);
  });
});
