import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hasWindowsLaunchExtension,
  launchFailureError,
  ptyArgs,
  resolveLaunch,
  withLaunchOptions,
} from "./windowsLaunch.js";

// These tests inject `platform: "win32"` on Linux, so every fake Windows install
// is a real directory under the OS temp dir and its entries are plain files. A
// Windows launch is an extension question, not a mode bit, so no file here needs
// the executable bit. PATH entries are joined with ";" by hand: the launch reads
// PATH the way Windows does, not the host's separator.
//
// Several expectations are hand-written literals rather than calls to
// escapeCmdCommand/escapeCmdArgument, so the escaping is pinned independently of
// the helpers it could otherwise agree with by construction.

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A fresh temp root: one PATH entry per test, so a shim can never leak into
 *  another test's lookup. */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kone-windows-launch-"));
  roots.push(dir);
  return dir;
}

/** A directory under a temp root, created as needed. */
function subDir(root: string, ...parts: string[]): string {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A fake shim: plain text is enough, because nothing is ever spawned here. */
function makeFile(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "@echo off\r\n");
  return file;
}

const COMSPEC = "C:\\Windows\\System32\\cmd.exe";

/** The expected cmd.exe argv for a batch target whose command position needs no
 *  escaping: `/d /s /c "<line>"`, where each `login`-style argument is
 *  `^^^"arg^^^"` (quoted, then caret-escaped twice). */
function cmdArgs(line: string): string[] {
  return ["/d", "/s", "/c", `"${line}"`];
}

describe("resolveLaunch on a non-Windows platform", () => {
  test("passes the command and argv through untouched, with no extra keys", () => {
    const dir = tempDir();
    makeFile(dir, "x.cmd");

    for (const platform of ["linux", "darwin"] as const) {
      const launch = resolveLaunch("x", ["a b"], { env: { PATH: dir }, platform });
      // Deep equality, not toMatchObject: the non-Windows shape is exactly the
      // three documented keys — no `windowsVerbatimArguments: undefined`.
      expect(launch).toEqual({ ok: true, file: "x", args: ["a b"] });
    }
  });

  test("withLaunchOptions adds no key, and ptyArgs keeps the argv array", () => {
    const launch = resolveLaunch("x", ["a b"], { env: {}, platform: "linux" });
    if (!launch.ok) throw new Error(launch.message);

    const options = withLaunchOptions({ cwd: "/tmp", env: {} }, launch);
    expect(options).toEqual({ cwd: "/tmp", env: {} });
    expect("windowsVerbatimArguments" in options).toBe(false);
    expect(ptyArgs(launch)).toEqual(["a b"]);
  });
});

describe("resolveLaunch: npm sibling sets", () => {
  test("a bare name resolves the .cmd shim in node_modules/.bin, never the sh script", () => {
    const root = tempDir();
    const dir = subDir(root, "node_modules", ".bin");
    makeFile(dir, "x");
    makeFile(dir, "x.ps1");
    const cmd = makeFile(dir, "x.cmd");
    // The hand-written literal below assumes an unspaced command position.
    expect(cmd).not.toContain(" ");

    const launch = resolveLaunch("x", ["login"], {
      env: { PATH: dir, ComSpec: COMSPEC },
      platform: "win32",
    });

    expect(launch).toEqual({
      ok: true,
      file: COMSPEC,
      args: cmdArgs(`${cmd} ^^^"login^^^"`),
      windowsVerbatimArguments: true,
    });
  });

  test("the same sibling set in AppData/Roaming/npm also resolves the .cmd", () => {
    const root = tempDir();
    const dir = subDir(root, "AppData", "Roaming", "npm");
    const cmd = makeFile(dir, "x.cmd");
    makeFile(dir, "x");
    makeFile(dir, "x.ps1");

    const launch = resolveLaunch("x", ["login"], {
      env: { PATH: dir, ComSpec: COMSPEC },
      platform: "win32",
    });

    expect(launch).toEqual({
      ok: true,
      file: COMSPEC,
      args: cmdArgs(`${cmd} ^^^"login^^^"`),
      windowsVerbatimArguments: true,
    });
  });
});

describe("resolveLaunch: PATHEXT order", () => {
  test("PATHEXT=.PS1;.CMD picks the .cmd, skipping the .exe and .ps1", () => {
    const root = tempDir();
    const cmd = makeFile(root, "x.cmd");
    makeFile(root, "x.exe");
    makeFile(root, "x.ps1");
    makeFile(root, "x");

    const launch = resolveLaunch("x", ["login"], {
      env: { PATH: root, PATHEXT: ".PS1;.CMD", ComSpec: COMSPEC },
      platform: "win32",
    });

    expect(launch.ok && launch.args).toEqual(cmdArgs(`${cmd} ^^^"login^^^"`));
  });

  test("a PATHEXT with nothing supported falls back to cmd.exe's default order", () => {
    // .COM;.EXE;.BAT;.CMD — so the .exe wins over the .cmd here.
    const both = tempDir();
    const exe = makeFile(both, "x.exe");
    makeFile(both, "x.cmd");

    expect(
      resolveLaunch("x", ["login"], {
        env: { PATH: both, PATHEXT: ".ps1", ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({ ok: true, file: exe, args: ["login"] });

    // …and a lone .cmd is still found through the same fallback.
    const onlyCmd = tempDir();
    const cmd = makeFile(onlyCmd, "x.cmd");
    expect(
      resolveLaunch("x", ["login"], {
        env: { PATH: onlyCmd, PATHEXT: ".ps1", ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({
      ok: true,
      file: COMSPEC,
      args: cmdArgs(`${cmd} ^^^"login^^^"`),
      windowsVerbatimArguments: true,
    });
  });
});

describe("resolveLaunch: explicit configured paths", () => {
  test("an explicit .exe is used as-is with plain argv, whatever PATHEXT says", () => {
    const root = tempDir();
    const exe = makeFile(root, "x.exe");

    const launch = resolveLaunch(exe, ["login"], {
      env: { PATH: root, PATHEXT: ".CMD", ComSpec: COMSPEC },
      platform: "win32",
    });

    expect(launch).toEqual({ ok: true, file: exe, args: ["login"] });
    expect("windowsVerbatimArguments" in launch).toBe(false);
  });

  test("an explicit .cmd is wrapped even when PATHEXT omits .CMD", () => {
    const root = tempDir();
    const cmd = makeFile(root, "x.cmd");
    expect(cmd).not.toContain(" ");

    const launch = resolveLaunch(cmd, ["login"], {
      env: { PATH: root, PATHEXT: ".EXE", ComSpec: COMSPEC },
      platform: "win32",
    });

    expect(launch).toEqual({
      ok: true,
      file: COMSPEC,
      args: cmdArgs(`${cmd} ^^^"login^^^"`),
      windowsVerbatimArguments: true,
    });
  });

  test("a relative configured path is resolved against cwd", () => {
    const root = tempDir();
    const dir = subDir(root, "bin");
    const cmd = makeFile(dir, "x.cmd");

    const launch = resolveLaunch("bin/x.cmd", ["login"], {
      env: { PATH: "/nowhere", ComSpec: COMSPEC },
      platform: "win32",
      cwd: root,
    });

    expect(launch).toEqual({
      ok: true,
      file: COMSPEC,
      args: cmdArgs(`${cmd} ^^^"login^^^"`),
      windowsVerbatimArguments: true,
    });
  });
});

describe("resolveLaunch: failures", () => {
  const NOT_LAUNCHABLE = "isn't something Windows can run (expected .exe, .com, .cmd or .bat).";

  test("an explicit .ps1 with no launchable sibling is unlaunchable, not missing", () => {
    const root = tempDir();
    const ps1 = makeFile(root, "x.ps1");

    expect(
      resolveLaunch(ps1, ["login"], {
        env: { PATH: root, PATHEXT: ".PS1;.CMD", ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({
      ok: false,
      reason: "unlaunchable",
      message: `${ps1} ${NOT_LAUNCHABLE}`,
    });
  });

  test("a bare name that is only an extensionless sh script or .ps1 on PATH is unlaunchable", () => {
    const root = tempDir();
    const sh = makeFile(root, "x");
    makeFile(root, "x.ps1");

    expect(
      resolveLaunch("x", ["login"], {
        env: { PATH: root, ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({
      ok: false,
      reason: "unlaunchable",
      message: `x was found on your PATH at ${sh}, but it ${NOT_LAUNCHABLE}`,
    });
  });

  test("nothing on PATH, and nothing at the configured path, is missing", () => {
    const root = tempDir();
    expect(
      resolveLaunch("x", ["login"], {
        env: { PATH: root, ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({ ok: false, reason: "missing", message: "x isn't on your PATH." });

    const nowhere = path.join(root, "nope.exe");
    expect(
      resolveLaunch(nowhere, ["login"], {
        env: { PATH: root, ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({ ok: false, reason: "missing", message: `${nowhere} doesn't exist.` });
  });
});

describe("resolveLaunch: command-line escaping", () => {
  test("spaces in the command position are caret-escaped", () => {
    const root = tempDir();
    const dir = subDir(root, "Program Files", "nodejs");
    makeFile(dir, "x.cmd");

    const launch = resolveLaunch("x", ["login"], {
      env: { PATH: dir, ComSpec: COMSPEC },
      platform: "win32",
    });

    // Hand-derived: only the command position's spaces are escaped, and only
    // with a caret — no quotes around the script path.
    const line = `${root}/Program^ Files/nodejs/x.cmd ^^^"login^^^"`;
    expect(launch.ok && launch.args).toEqual(cmdArgs(line));
  });

  test("every cmd.exe metacharacter in an argument is caret-escaped", () => {
    const root = tempDir();
    const cmd = makeFile(root, "x.cmd");
    expect(cmd).not.toContain(" ");

    const launch = resolveLaunch(
      "x",
      ["&", "|", "<", ">", "^", "%", "!", "(", ")", "a b"],
      { env: { PATH: root, ComSpec: COMSPEC }, platform: "win32" },
    );

    // Hand-written literals, one per character group, in argument order:
    // quoted then escaped twice (the second pass escapes the first pass's
    // carets), which is what cross-spawn does for a batch target.
    const line = [
      cmd,
      '^^^"^^^&^^^"',
      '^^^"^^^|^^^"',
      '^^^"^^^<^^^"',
      '^^^"^^^>^^^"',
      '^^^"^^^^^^^"',
      '^^^"^^^%^^^"',
      '^^^"^^^!^^^"',
      '^^^"^^^(^^^"',
      '^^^"^^^)^^^"',
      '^^^"a^^^ b^^^"',
    ].join(" ");
    expect(launch.ok && launch.args).toEqual(cmdArgs(line));
  });

  test("an embedded double quote is backslash-escaped, then caret-escaped twice", () => {
    const root = tempDir();
    const cmd = makeFile(root, "x.cmd");
    expect(cmd).not.toContain(" ");

    const launch = resolveLaunch("x", ['say "hi"'], {
      env: { PATH: root, ComSpec: COMSPEC },
      platform: "win32",
    });

    // Hand-derived: `"` → `\"`, the whole word quoted, then both caret passes.
    expect(launch.ok && launch.args).toEqual(cmdArgs(`${cmd} ^^^"say^^^ \\^^^"hi\\^^^"^^^"`));
  });

  test("an argument spanning lines is refused for a batch target", () => {
    const root = tempDir();
    makeFile(root, "x.cmd");

    const launch = resolveLaunch("x", ["login", "a\nb"], {
      env: { PATH: root, ComSpec: COMSPEC },
      platform: "win32",
    });

    expect(launch).toMatchObject({ ok: false, reason: "invalid-argument" });
    if (launch.ok) throw new Error("expected a failure");
    expect(launch.message).toBe(
      `${path.join(root, "x.cmd")} is a batch file, and cmd.exe cannot pass an argument that spans lines.`,
    );
    // Carriage returns are refused too — cmd.exe ends the line on either.
    expect(
      resolveLaunch("x", ["a\rb"], {
        env: { PATH: root, ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toMatchObject({ ok: false, reason: "invalid-argument" });
  });

  test("the same multi-line argument is fine for a native executable", () => {
    const root = tempDir();
    const exe = makeFile(root, "x.exe");

    expect(
      resolveLaunch("x", ["a\nb"], {
        env: { PATH: root, ComSpec: COMSPEC },
        platform: "win32",
      }),
    ).toEqual({ ok: true, file: exe, args: ["a\nb"] });
  });
});

describe("resolveLaunch: ComSpec and PATH casing", () => {
  test("ComSpec is honoured under any key casing, fallback is cmd.exe", () => {
    const root = tempDir();
    makeFile(root, "x.cmd");

    for (const key of ["ComSpec", "COMSPEC", "comspec"] as const) {
      const interpreter = `C:\\${key}\\cmd.exe`;
      const launch = resolveLaunch("x", ["login"], {
        env: { PATH: root, [key]: interpreter },
        platform: "win32",
      });
      expect(launch.ok && launch.file).toBe(interpreter);
    }

    const fallback = resolveLaunch("x", ["login"], {
      env: { PATH: root },
      platform: "win32",
    });
    expect(fallback.ok && fallback.file).toBe("cmd.exe");
  });

  test("PATH is read case-insensitively, preferring an exact PATH key", () => {
    const root = tempDir();
    const dir = subDir(root, "bin");
    makeFile(dir, "x.cmd");

    // Windows env keys are case-insensitive: a spread process.env carries `Path`.
    expect(
      resolveLaunch("x", ["login"], {
        env: { Path: dir, ComSpec: COMSPEC },
        platform: "win32",
      }).ok,
    ).toBe(true);

    // With both keys the exact `PATH` wins outright — no concatenation.
    const exact = subDir(root, "exact");
    const exactCmd = makeFile(exact, "x.cmd");
    const launch = resolveLaunch("x", ["login"], {
      env: { PATH: exact, Path: dir, ComSpec: COMSPEC },
      platform: "win32",
    });
    expect(launch.ok && launch.args).toEqual(cmdArgs(`${exactCmd} ^^^"login^^^"`));
  });
});

describe("LaunchResult helpers", () => {
  test("ptyArgs pre-joins the batch wrapper and leaves argv alone", () => {
    const root = tempDir();
    const cmdDir = subDir(root, "cmd");
    makeFile(cmdDir, "x.cmd");
    const exeDir = subDir(root, "exe");
    const exe = makeFile(exeDir, "x.exe");

    const batch = resolveLaunch("x", ["login"], {
      env: { PATH: cmdDir, ComSpec: COMSPEC },
      platform: "win32",
    });
    if (!batch.ok) throw new Error(batch.message);
    expect(ptyArgs(batch)).toBe(batch.args.join(" "));
    expect(ptyArgs(batch)).toStartWith(`/d /s /c "`);

    const native = resolveLaunch(exe, ["login"], { env: {}, platform: "win32" });
    if (!native.ok) throw new Error(native.message);
    expect(ptyArgs(native)).toEqual(["login"]);
  });

  test("withLaunchOptions adds windowsVerbatimArguments only for the wrapper", () => {
    const root = tempDir();
    makeFile(root, "x.cmd");

    const batch = resolveLaunch("x", ["login"], {
      env: { PATH: root, ComSpec: COMSPEC },
      platform: "win32",
    });
    if (!batch.ok) throw new Error(batch.message);
    expect(withLaunchOptions({ cwd: "/tmp" }, batch)).toEqual({
      cwd: "/tmp",
      windowsVerbatimArguments: true,
    });
  });

  test("launchFailureError keeps one error path: ENOENT for missing, EINVAL otherwise", () => {
    const missing = launchFailureError("x", {
      ok: false,
      reason: "missing",
      message: "x isn't on your PATH.",
    });
    expect(missing).toBeInstanceOf(Error);
    expect(missing.code).toBe("ENOENT");
    expect(missing.message).toBe("x isn't on your PATH.");
    // Node sets `path` on a spawn failure; callers rely on it for diagnostics.
    expect(missing.path).toBe("x");

    for (const reason of ["unlaunchable", "invalid-argument"] as const) {
      const failure = launchFailureError("x.cmd", { ok: false, reason, message: "no." });
      expect(failure.code).toBe("EINVAL");
      expect(failure.path).toBe("x.cmd");
      expect(failure.message).toBe("no.");
    }
  });

  test("hasWindowsLaunchExtension recognises only the startable suffixes", () => {
    for (const name of ["x.exe", "x.COM", "x.cmd", "x.Bat"]) {
      expect(hasWindowsLaunchExtension(name)).toBe(true);
    }
    for (const name of ["x", "x.ps1", "x.vbs", "x.cmd.exe.bak"]) {
      expect(hasWindowsLaunchExtension(name)).toBe(false);
    }
  });
});
