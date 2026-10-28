import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findOnPath,
  findOnPathEntry,
  mergeWindowsPath,
  pathEnvKey,
  windowsCliDirs,
  windowsEnvKey,
} from "./processEnv.js";
import {
  SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS,
  findWindowsLaunchableIn,
  findWindowsLaunchableOnPath,
  pathExtensions,
  resolveLaunch,
  windowsLaunchExtensions,
} from "./windowsLaunch.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kone-process-env-"));
}

function makeExecutable(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, 0o755);
  return file;
}

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

  test("merges into the Path key Windows actually uses, never a second PATH", () => {
    // A spread process.env on Windows carries `Path`; writing `PATH` beside it
    // left two variables, one of them holding only the known dirs.
    const env = mergeWindowsPath({
      USERPROFILE: "C:\\Users\\testuser",
      Path: "C:\\Windows\\System32;C:\\Users\\testuser\\AppData\\Roaming\\npm",
    });
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["Path"]);
    expect(env.Path).toBe(
      "C:\\Windows\\System32;C:\\Users\\testuser\\AppData\\Roaming\\npm;" +
        "C:\\Users\\testuser\\.local\\bin;C:\\Users\\testuser\\.bun\\bin;" +
        "C:\\Users\\testuser\\scoop\\shims",
    );
  });

  test("pathEnvKey folds case on Windows only", () => {
    expect(pathEnvKey({ Path: "x" }, "win32")).toBe("Path");
    expect(pathEnvKey({ Path: "x", PATH: "y" }, "win32")).toBe("PATH");
    expect(pathEnvKey({}, "win32")).toBe("PATH");
    expect(pathEnvKey({ Path: "x" }, "linux")).toBe("PATH");
  });

  test("findOnPathEntry reads a Windows Path key", () => {
    const dir = tempDir();
    const exe = makeExecutable(dir, "codex.exe");
    expect(findOnPathEntry("codex", { Path: dir }, "win32")?.found).toBe(exe);
    expect(findOnPathEntry("codex.exe", { Path: dir }, "darwin")).toBeNull();
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

// Windows env keys are case-insensitive, so an env object can hold the same
// variable twice (`Path` and `PaTH`). Node keeps exactly one of them for the
// child: lib/child_process.js (normalizeSpawnArguments) sorts the keys and keeps
// the first per case-insensitive name. Whatever kone resolves a launch against
// has to be that same one, or the resolver and the child disagree about PATH.

/** Node's rule, restated as the oracle: the key the child would receive. */
function nodeKeptKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(env)
    .sort()
    .find((key) => key.toUpperCase() === name.toUpperCase());
}

describe("duplicate env key casing on Windows", () => {
  test("pathEnvKey picks the key Node passes to the child, whatever the insertion order", () => {
    expect(pathEnvKey({ Path: "a", PaTH: "b" }, "win32")).toBe("PaTH");
    expect(pathEnvKey({ PaTH: "b", Path: "a" }, "win32")).toBe("PaTH");
    expect(pathEnvKey({ path: "x", Path: "y" }, "win32")).toBe("Path");
    expect(pathEnvKey({ Path: "y", PATH: "z" }, "win32")).toBe("PATH");
    expect(pathEnvKey({ Path: "a", PaTH: "b" }, "linux")).toBe("PATH");
  });

  test("pathEnvKey agrees with Node's rule for every ordering of the variants", () => {
    const variants = ["path", "Path", "PaTH", "pATH"];
    for (const first of variants) {
      const env = Object.fromEntries(
        [first, ...variants.filter((key) => key !== first)].map((key) => [key, key]),
      );
      expect(pathEnvKey(env, "win32")).toBe(nodeKeptKey(env, "PATH")!);
    }
  });

  test("windowsEnvKey names the kept key for any variable, or nothing", () => {
    expect(windowsEnvKey({ pathext: ".EXE", PathExt: ".CMD" }, "PATHEXT")).toBe("PathExt");
    expect(windowsEnvKey({ comspec: "b", ComSpec: "a" }, "ComSpec")).toBe("ComSpec");
    expect(windowsEnvKey({ Other: "x" }, "SystemRoot")).toBeUndefined();
  });

  test("mergeWindowsPath leaves one PATH key: the value Node would have passed, merged", () => {
    const env = mergeWindowsPath({
      USERPROFILE: "C:\\Users\\u",
      Path: "C:\\valid",
      PaTH: "C:\\other",
    });
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PaTH"]);
    expect(env.PaTH).toBe(
      "C:\\other;C:\\Users\\u\\.local\\bin;C:\\Users\\u\\.bun\\bin;C:\\Users\\u\\scoop\\shims",
    );
  });

  test("findOnPathEntry reads the key Node keeps", () => {
    const kept = tempDir();
    const dropped = tempDir();
    const exe = makeExecutable(kept, "codex.exe");
    makeExecutable(dropped, "codex.exe");
    expect(findOnPathEntry("codex", { Path: dropped, PaTH: kept }, "win32")?.found).toBe(exe);
  });

  test("PATHEXT is read from the key Node keeps", () => {
    expect(pathExtensions({ Pathext: ".EXE", PATHEXT: ".CMD" })).toEqual([".CMD"]);
  });

  test("ComSpec is read from the key Node keeps", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "codex.cmd"), "@echo off\r\n");
    const launch = resolveLaunch("codex", [], {
      env: { PATH: dir, comspec: "C:\\wrong\\cmd.exe", ComSpec: "C:\\right\\cmd.exe" },
      platform: "win32",
    });
    expect(launch.ok && launch.file).toBe("C:\\right\\cmd.exe");
  });
});

describe("findOnPath", () => {
  test("finds an executable in PATH order", () => {
    const first = tempDir();
    const second = tempDir();
    makeExecutable(second, "some-tool");
    expect(findOnPath("some-tool", { PATH: `${first}:${second}` }, "darwin")).toBe(
      fs.realpathSync(path.join(second, "some-tool")),
    );
    expect(findOnPath("missing-tool", { PATH: first }, "darwin")).toBeNull();
  });
});

describe("pathExtensions", () => {
  test("defaults to what cmd.exe itself uses when PATHEXT is unset", () => {
    expect(pathExtensions({})).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
    expect(pathExtensions({ PATH: "C:\\Windows" })).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });

  test("reads PATHEXT under any key casing and ignores empty entries", () => {
    expect(pathExtensions({ PATHEXT: ".CMD;.EXE" })).toEqual([".CMD", ".EXE"]);
    expect(pathExtensions({ PathExt: ".CMD;;.EXE;" })).toEqual([".CMD", ".EXE"]);
    expect(pathExtensions({ pathext: ".bat" })).toEqual([".bat"]);
  });

  test("normalizes an entry that lacks its leading dot", () => {
    expect(pathExtensions({ PATHEXT: "EXE;.CMD" })).toEqual([".EXE", ".CMD"]);
  });

  test("falls back to the defaults when PATHEXT holds no usable entry", () => {
    expect(pathExtensions({ PATHEXT: ";;" })).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });
});

describe("windowsLaunchExtensions", () => {
  test("the supported suffixes are the ones Windows can start directly", () => {
    expect([...SUPPORTED_WINDOWS_LAUNCH_EXTENSIONS]).toEqual([".exe", ".com", ".cmd", ".bat"]);
  });

  test("keeps only the supported suffixes, in PATHEXT order", () => {
    expect(windowsLaunchExtensions({ PATHEXT: ".PS1;.CMD" })).toEqual([".CMD"]);
    expect(windowsLaunchExtensions({ PATHEXT: ".BAT;.VBS;.EXE" })).toEqual([".BAT", ".EXE"]);
  });

  test("compares case-insensitively under any PATHEXT key casing", () => {
    expect(windowsLaunchExtensions({ PathExt: ".ps1;.CmD" })).toEqual([".CmD"]);
    expect(windowsLaunchExtensions({ pathext: ".Ps1;.Exe" })).toEqual([".Exe"]);
  });

  test("falls back to cmd.exe's default order when PATHEXT lists none", () => {
    expect(windowsLaunchExtensions({})).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
    expect(windowsLaunchExtensions({ PATHEXT: ".PS1;.VBS" })).toEqual([
      ".COM",
      ".EXE",
      ".BAT",
      ".CMD",
    ]);
  });
});

describe("findWindowsLaunchableIn", () => {
  function makeFile(dir: string, name: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "@echo off\r\n");
    return file;
  }

  test("finds the PATHEXT completion of a bare name in one directory", () => {
    const dir = tempDir();
    makeFile(dir, "codex"); // npm's extensionless sh script: not launchable
    const cmd = makeFile(dir, "codex.cmd");

    expect(findWindowsLaunchableIn(dir, "codex", {})?.found).toBe(cmd);
  });

  test("a name that already carries a PATHEXT extension is not completed again", () => {
    const dir = tempDir();
    const cmd = makeFile(dir, "codex.cmd");
    makeFile(dir, "codex.cmd.exe");

    expect(findWindowsLaunchableIn(dir, "codex.cmd", {})?.found).toBe(cmd);
    expect(findWindowsLaunchableIn(dir, "codex", { PATHEXT: ".CMD" })?.found).toBe(cmd);
  });

  test("an unreadable or empty directory is simply no match", () => {
    const dir = tempDir();
    expect(findWindowsLaunchableIn(dir, "codex", {})).toBeNull();
    expect(findWindowsLaunchableIn(path.join(dir, "missing"), "codex", {})).toBeNull();
  });

  test("a .PS1 in PATHEXT is never a launch candidate", () => {
    const dir = tempDir();
    makeFile(dir, "codex");
    makeFile(dir, "codex.ps1");
    const cmd = makeFile(dir, "codex.cmd");

    expect(findWindowsLaunchableIn(dir, "codex", { PATHEXT: ".PS1;.CMD" })?.found).toBe(cmd);
    expect(findWindowsLaunchableIn(dir, "codex.ps1", { PATHEXT: ".PS1;.CMD" })).toBeNull();
  });

  test("an explicit supported suffix is used as-is whatever PATHEXT says", () => {
    const dir = tempDir();
    const exe = makeFile(dir, "codex.exe");
    const cmd = makeFile(dir, "codex.cmd");

    expect(findWindowsLaunchableIn(dir, "codex.exe", { PATHEXT: ".CMD" })?.found).toBe(exe);
    expect(findWindowsLaunchableIn(dir, "codex.cmd", { PATHEXT: ".EXE" })?.found).toBe(cmd);
  });

  test("a dotted name without a supported suffix is still completed", () => {
    const dir = tempDir();
    const completed = makeFile(dir, "foo.bar.cmd");

    expect(findWindowsLaunchableIn(dir, "foo.bar", { PATHEXT: ".PS1;.CMD" })?.found).toBe(
      completed,
    );
  });
});

describe("findWindowsLaunchableOnPath", () => {
  /** A plain file: Windows launchability is an extension question, not a mode
   *  bit, so these tests never need the executable bit. */
  function makeFile(dir: string, name: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "@echo off\r\n");
    return file;
  }

  test("skips npm's extensionless sh script in favour of the .cmd sibling", () => {
    const dir = tempDir();
    makeFile(dir, "codex");
    const cmd = makeFile(dir, "codex.cmd");
    makeFile(dir, "codex.ps1");

    expect(findWindowsLaunchableOnPath("codex", { PATH: dir })).toEqual({
      found: cmd,
      real: fs.realpathSync(cmd),
      dir,
    });
  });

  test("tries PATHEXT in order inside one directory", () => {
    const dir = tempDir();
    makeFile(dir, "codex.cmd");
    const exe = makeFile(dir, "codex.exe");

    expect(findWindowsLaunchableOnPath("codex", { PATH: dir })?.found).toBe(exe);
    // A different PATHEXT flips the winner without touching the directory.
    expect(findWindowsLaunchableOnPath("codex", { PATH: dir, PATHEXT: ".CMD;.EXE" })?.found).toBe(
      path.join(dir, "codex.cmd"),
    );
  });

  test("PATH order beats extension order", () => {
    const first = tempDir();
    const second = tempDir();
    const exe = makeFile(first, "codex.exe");
    makeFile(second, "codex.com");

    expect(findWindowsLaunchableOnPath("codex", { PATH: `${first};${second}` })?.found).toBe(exe);
  });

  test("a name that already carries a PATHEXT extension is tried as-is", () => {
    const dir = tempDir();
    const cmd = makeFile(dir, "codex.cmd");
    makeFile(dir, "codex.cmd.exe");

    expect(findWindowsLaunchableOnPath("codex.cmd", { PATH: dir })?.found).toBe(cmd);
    expect(findWindowsLaunchableOnPath("codex.exe", { PATH: dir })).toBeNull();
  });

  test("a bare .exe is found even when PATHEXT omits it", () => {
    const dir = tempDir();
    const exe = makeFile(dir, "codex.exe");

    expect(findWindowsLaunchableOnPath("codex.exe", { PATH: dir, PATHEXT: ".CMD" })?.found).toBe(
      exe,
    );
  });

  test("an extensionless or .ps1-only match is not launchable", () => {
    const bare = tempDir();
    makeFile(bare, "codex");
    expect(findWindowsLaunchableOnPath("codex", { PATH: bare })).toBeNull();

    const ps1 = tempDir();
    makeFile(ps1, "codex.ps1");
    expect(findWindowsLaunchableOnPath("codex", { PATH: ps1 })).toBeNull();
  });

  test("a directory named like the binary is not a match", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "codex.cmd"));
    expect(findWindowsLaunchableOnPath("codex", { PATH: dir })).toBeNull();
  });

  test("returns null when nothing on PATH matches", () => {
    expect(findWindowsLaunchableOnPath("codex", { PATH: tempDir() })).toBeNull();
    expect(findWindowsLaunchableOnPath("codex", {})).toBeNull();
  });
});
