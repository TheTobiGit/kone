import { describe, expect, test } from "bun:test";

import {
  deleteEnvVar,
  envKeyFor,
  envKeyMatches,
  envValue,
  setEnvVar,
  windowsEnvKey,
} from "./envKeys.js";

describe("envKeys", () => {
  test("windowsEnvKey chooses the casing Node passes to a child", () => {
    expect(windowsEnvKey({ Path: "a", PATH: "b" }, "PATH")).toBe("PATH");
    expect(windowsEnvKey({ PATHEXT: ".EXE", PathExt: ".CMD" }, "PATHEXT")).toBe("PATHEXT");
    expect(windowsEnvKey({ Other: "x" }, "PATH")).toBeUndefined();
  });

  test("envKeyFor is exact on POSIX and folds on Windows", () => {
    expect(envKeyFor({ Path: "x" }, "PATH", "linux")).toBe("PATH");
    expect(envKeyFor({ Path: "x" }, "PATH", "win32")).toBe("Path");
    expect(envKeyFor({}, "PATH", "win32")).toBe("PATH");
  });

  test("envValue reads the key Node would use", () => {
    expect(envValue({ Path: "dropped", PATH: "kept" }, "PATH", "win32")).toBe("kept");
    expect(envValue({ Path: "kept" }, "PATH", "win32")).toBe("kept");
    expect(envValue({ Path: "posix-miss" }, "PATH", "linux")).toBeUndefined();
  });

  test("setEnvVar replaces every casing on Windows and preserves the kept key", () => {
    const env: NodeJS.ProcessEnv = { Path: "old", PATH: "older", Other: "x" };
    setEnvVar(env, "Path", "new", "win32");
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.PATH).toBe("new");
    expect(env.Other).toBe("x");
  });

  test("setEnvVar keeps the exact name and case on POSIX", () => {
    const env: NodeJS.ProcessEnv = { Path: "old" };
    setEnvVar(env, "PATH", "new", "linux");
    expect(env).toEqual({ Path: "old", PATH: "new" });
  });

  test("deleteEnvVar removes every casing on Windows only", () => {
    const windows: NodeJS.ProcessEnv = { Path: "a", PATH: "b", Other: "x" };
    deleteEnvVar(windows, "path", "win32");
    expect(windows).toEqual({ Other: "x" });

    const posix: NodeJS.ProcessEnv = { Path: "a", PATH: "b" };
    deleteEnvVar(posix, "PATH", "linux");
    expect(posix).toEqual({ Path: "a" });
  });

  test("envKeyMatches follows the platform's case rules", () => {
    expect(envKeyMatches("PaTh", "PATH", "win32")).toBe(true);
    expect(envKeyMatches("PaTh", "PATH", "linux")).toBe(false);
    expect(envKeyMatches("PATH", "PATH", "linux")).toBe(true);
  });
});
