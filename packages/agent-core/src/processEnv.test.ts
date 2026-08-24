import { describe, expect, test } from "bun:test";

import { mergeWindowsPath, windowsCliDirs } from "./processEnv.js";

describe("windowsCliDirs", () => {
  test("lists the known install dirs under USERPROFILE", () => {
    expect(windowsCliDirs({ USERPROFILE: "C:\\Users\\testuser" })).toEqual([
      "C:\\Users\\testuser\\.local\\bin",
      "C:\\Users\\testuser\\.bun\\bin",
      "C:\\Users\\testuser\\scoop\\shims",
    ]);
  });

  test("returns an empty list without USERPROFILE", () => {
    expect(windowsCliDirs({})).toEqual([]);
  });
});

describe("mergeWindowsPath", () => {
  test("appends the known dirs after the inherited PATH, deduped", () => {
    const env = mergeWindowsPath({
      USERPROFILE: "C:\\Users\\testuser",
      PATH: "C:\\Windows\\System32;C:\\Users\\testuser\\.local\\bin",
    });
    expect(env.PATH).toBe(
      "C:\\Windows\\System32;C:\\Users\\testuser\\.local\\bin;" +
        "C:\\Users\\testuser\\.bun\\bin;C:\\Users\\testuser\\scoop\\shims",
    );
  });

  test("handles an empty or missing PATH", () => {
    const env = mergeWindowsPath({ USERPROFILE: "C:\\Users\\testuser" });
    expect(env.PATH).toBe(
      "C:\\Users\\testuser\\.local\\bin;" +
        "C:\\Users\\testuser\\.bun\\bin;C:\\Users\\testuser\\scoop\\shims",
    );
  });

  test("does not mutate the input env", () => {
    const base = { USERPROFILE: "C:\\Users\\testuser" };
    const env = mergeWindowsPath(base);
    expect(base.PATH).toBeUndefined();
    expect(env).not.toBe(base);
    expect(env.PATH).toContain(".local\\bin");
  });
});
