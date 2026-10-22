import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordingSpawn } from "./testing/win32Launch.js";
import { resolveLaunch, spawnLaunch, splitWindowsPath } from "./windowsLaunch.js";

// PATH as Windows (libuv's `search_path`, src/win/process.c) reads it: a quoted
// entry may hold a `;`, its quotes are not part of the directory, and a relative
// entry is a directory under the launch's cwd, not under kone's own. The
// fixtures are real directories on the Linux host with `platform: "win32"`
// injected, as in windowsLaunch.test.ts.

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kone-windows-path-"));
  roots.push(dir);
  return dir;
}

function makeFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "MZ");
  return file;
}

describe("splitWindowsPath", () => {
  test("a quoted entry keeps its ; and loses its quotes", () => {
    expect(splitWindowsPath('"a;b";c')).toEqual(["a;b", "c"]);
  });

  test("single quotes delimit an entry too", () => {
    expect(splitWindowsPath("'a;b';c")).toEqual(["a;b", "c"]);
  });

  test("empty entries are skipped", () => {
    expect(splitWindowsPath(";;a;")).toEqual(["a"]);
    expect(splitWindowsPath('"";a')).toEqual(["a"]);
  });

  test("an unterminated quote runs to the end of PATH", () => {
    expect(splitWindowsPath('a;"b;c')).toEqual(["a", "b;c"]);
  });

  test("a plain PATH splits on every ;", () => {
    expect(splitWindowsPath("C:\\one;C:\\two")).toEqual(["C:\\one", "C:\\two"]);
  });
});

describe("quoted PATH entries", () => {
  test("a native CLI under a quoted entry resolves", () => {
    const dir = path.join(tempDir(), "Program Files", "Codex");
    const exe = makeFile(dir, "codex.exe");
    const launch = resolveLaunch("codex", ["--version"], {
      env: { PATH: `"${dir}"` },
      platform: "win32",
    });
    expect(launch).toEqual({ ok: true, file: exe, args: ["--version"] });
  });

  test("a quoted entry whose directory name holds ; resolves", () => {
    const root = tempDir();
    const dir = path.join(root, "a;b");
    const exe = makeFile(dir, "codex.exe");
    const launch = resolveLaunch("codex", [], {
      env: { PATH: `"${dir}";${path.join(root, "other")}` },
      platform: "win32",
    });
    expect(launch).toEqual({ ok: true, file: exe, args: [] });
  });

  test("the unlaunchable sentence also looks inside a quoted entry", () => {
    const dir = path.join(tempDir(), "npm");
    const script = makeFile(dir, "codex");
    const launch = resolveLaunch("codex", [], { env: { PATH: `"${dir}"` }, platform: "win32" });
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.reason).toBe("unlaunchable");
    expect(launch.message).toContain(script);
  });
});

describe("relative PATH entries", () => {
  test("resolve against the launch cwd, to an absolute path", () => {
    const cwd = tempDir();
    const exe = makeFile(path.join(cwd, "bin"), "codex.exe");
    expect(process.cwd()).not.toBe(cwd);
    const launch = resolveLaunch("codex", [], { env: { PATH: "bin" }, platform: "win32", cwd });
    expect(launch).toEqual({ ok: true, file: exe, args: [] });
  });

  test("spawnLaunch hands the cwd-resolved file to spawn", () => {
    const cwd = tempDir();
    const exe = makeFile(path.join(cwd, "bin"), "codex.exe");
    const recorder = recordingSpawn();
    const result = spawnLaunch(
      "codex",
      ["exec"],
      { cwd, env: { PATH: "bin" }, stdio: "ignore" },
      { platform: "win32", spawn: recorder.spawn },
    );
    expect(result.ok).toBe(true);
    if (result.ok) result.child.kill();
    expect(recorder.calls.map((call) => call.file)).toEqual([exe]);
  });

  test("the unlaunchable sentence names the cwd-resolved file", () => {
    const cwd = tempDir();
    const script = makeFile(path.join(cwd, "bin"), "codex");
    const launch = resolveLaunch("codex", [], { env: { PATH: "bin" }, platform: "win32", cwd });
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.reason).toBe("unlaunchable");
    expect(launch.message).toContain(script);
  });

  test("a relative command with a separator resolves against the launch cwd", () => {
    const cwd = tempDir();
    const exe = makeFile(path.join(cwd, "bin"), "codex.exe");
    const launch = resolveLaunch("bin/codex", [], { env: {}, platform: "win32", cwd });
    expect(launch).toEqual({ ok: true, file: exe, args: [] });
  });
});

describe("off Windows", () => {
  test("a quoted or relative PATH changes nothing: the launch is a passthrough", () => {
    const launch = resolveLaunch("codex", ["exec"], {
      env: { PATH: '"quoted dir":bin' },
      platform: "linux",
      cwd: tempDir(),
    });
    expect(launch).toEqual({ ok: true, file: "codex", args: ["exec"] });
  });
});
