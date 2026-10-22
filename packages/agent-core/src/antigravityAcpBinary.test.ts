import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  antigravityHarnessFileName,
  readAntigravityAcpActiveRecord,
  resolveAntigravityAcpBinary,
  resolveAntigravityAcpManagedDir,
  resolveAntigravityAcpManagedRoot,
} from "./antigravityAcpBinary.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kone-antigravity-bin-"));
}

function makeExecutable(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, 0o755);
  return file;
}

describe("antigravityHarnessFileName", () => {
  test("windows uses the exe harness", () => {
    expect(antigravityHarnessFileName("win32")).toBe("localharness_external.exe");
    expect(antigravityHarnessFileName("darwin")).toBe("localharness_external");
    expect(antigravityHarnessFileName("linux")).toBe("localharness_external");
  });
});

describe("readAntigravityAcpActiveRecord", () => {
  test("reads a well-formed active pointer", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "active.json"),
      JSON.stringify({ version: "agy_acp_server_1.1.1", executable: "agy_acp_server.par", harness: "localharness_external" }),
    );
    expect(readAntigravityAcpActiveRecord(dir)?.version).toBe("agy_acp_server_1.1.1");
  });

  test("returns null for a missing or malformed record", () => {
    expect(readAntigravityAcpActiveRecord(tempDir())).toBeNull();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "active.json"), "{not json");
    expect(readAntigravityAcpActiveRecord(dir)).toBeNull();
    const empty = tempDir();
    fs.writeFileSync(path.join(empty, "active.json"), JSON.stringify({ version: "", executable: "", harness: "" }));
    expect(readAntigravityAcpActiveRecord(empty)).toBeNull();
  });
});

describe("resolveAntigravityAcpBinary", () => {
  test("an explicit absolute path wins and pairs the sibling harness", () => {
    const dir = tempDir();
    const exe = makeExecutable(dir, "agy_acp_server.par");
    const resolved = resolveAntigravityAcpBinary({
      userDataDir: tempDir(),
      binaryPath: exe,
      platform: "darwin",
    });
    expect(resolved?.source).toBe("override");
    expect(resolved?.executablePath).toBe(path.resolve(exe));
    expect(resolved?.harnessPath).toBe(path.join(dir, "localharness_external"));
  });

  test("a missing explicit path resolves to null", () => {
    expect(
      resolveAntigravityAcpBinary({
        userDataDir: tempDir(),
        binaryPath: "/no/such/binary",
        platform: "darwin",
      }),
    ).toBeNull();
  });

  test("a managed runtime resolves with verified files", () => {
    const userData = tempDir();
    const managedDir = resolveAntigravityAcpManagedDir(userData, "darwin", "arm64");
    expect(managedDir).toBe(
      path.join(resolveAntigravityAcpManagedRoot(userData), "darwin-arm64"),
    );
    fs.mkdirSync(managedDir, { recursive: true });
    makeExecutable(managedDir, "agy_acp_server.par");
    makeExecutable(managedDir, "localharness_external");
    fs.writeFileSync(
      path.join(managedDir, "active.json"),
      JSON.stringify({
        version: "agy_acp_server_1.1.1",
        executable: "agy_acp_server.par",
        harness: "localharness_external",
      }),
    );
    const resolved = resolveAntigravityAcpBinary({ userDataDir: userData, platform: "darwin", arch: "arm64" });
    expect(resolved?.source).toBe("managed");
    expect(resolved?.executablePath).toBe(path.join(managedDir, "agy_acp_server.par"));
  });

  test("a managed record with missing files falls through to null", () => {
    const userData = tempDir();
    const managedDir = resolveAntigravityAcpManagedDir(userData, "darwin", "arm64");
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      path.join(managedDir, "active.json"),
      JSON.stringify({
        version: "agy_acp_server_1.1.1",
        executable: "agy_acp_server.par",
        harness: "localharness_external",
      }),
    );
    expect(
      resolveAntigravityAcpBinary({ userDataDir: userData, platform: "darwin", arch: "arm64", env: { PATH: "" } }),
    ).toBeNull();
  });

  test("a bare override name resolves on PATH", () => {
    const dir = tempDir();
    const exe = makeExecutable(dir, "custom-agy-acp");
    const resolved = resolveAntigravityAcpBinary({
      userDataDir: tempDir(),
      binaryPath: "custom-agy-acp",
      env: { PATH: dir },
      platform: "darwin",
    });
    expect(resolved?.source).toBe("override");
    expect(resolved?.executablePath).toBe(fs.realpathSync(exe));
  });
});

describe("resolveAntigravityAcpBinary on Windows", () => {
  // A win32 lookup walks only the suffixes Windows can start, in a real
  // directory: the install layout below is written to disk, never spawned.

  const PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";

  /** npm's Windows install shape: the `.cmd` Windows starts, an extensionless sh
   *  script it cannot, and a `.ps1` with no interpreter. */
  function installNpmSiblings(dir: string, name: string): void {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 1\n");
    fs.writeFileSync(path.join(dir, `${name}.cmd`), "@echo off\r\n");
    fs.writeFileSync(path.join(dir, `${name}.ps1`), "# not launchable\n");
  }

  test("a bare name resolves the PATH .cmd with the harness beside it", () => {
    const dir = tempDir();
    installNpmSiblings(dir, "agy");
    const harness = path.join(dir, "localharness_external.exe");
    fs.writeFileSync(harness, "");
    const resolved = resolveAntigravityAcpBinary({
      userDataDir: tempDir(),
      binaryPath: "agy",
      env: { PATH: dir, PATHEXT },
      platform: "win32",
    });
    expect(resolved?.source).toBe("override");
    expect(resolved?.executablePath).toBe(path.join(dir, "agy.cmd"));
    expect(resolved?.harnessPath).toBe(harness);
  });

  test("an extensionless configured path completes to its .cmd sibling", () => {
    const dir = tempDir();
    installNpmSiblings(dir, "agy");
    const resolved = resolveAntigravityAcpBinary({
      userDataDir: tempDir(),
      binaryPath: path.join(dir, "agy"),
      env: { PATH: "", PATHEXT },
      platform: "win32",
    });
    expect(resolved?.source).toBe("override");
    expect(resolved?.executablePath).toBe(path.join(dir, "agy.cmd"));
    expect(resolved?.harnessPath).toBe(path.join(dir, "localharness_external.exe"));
  });

  test("a configured .ps1 with nothing launchable beside it resolves to null", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "agy.ps1"), "# not launchable\n");
    expect(
      resolveAntigravityAcpBinary({
        userDataDir: tempDir(),
        binaryPath: path.join(dir, "agy.ps1"),
        env: { PATH: "", PATHEXT },
        platform: "win32",
      }),
    ).toBeNull();
  });

  test("the default name probe finds a .cmd install as the last resort", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "agy_acp_server.cmd"), "@echo off\r\n");
    fs.writeFileSync(path.join(dir, "agy_acp_server.ps1"), "# not launchable\n");
    const resolved = resolveAntigravityAcpBinary({
      userDataDir: tempDir(),
      env: { PATH: dir, PATHEXT },
      platform: "win32",
    });
    expect(resolved?.source).toBe("path");
    expect(resolved?.executablePath).toBe(path.join(dir, "agy_acp_server.cmd"));
    expect(resolved?.harnessPath).toBe(path.join(dir, "localharness_external.exe"));
  });

  test("the default name probe refuses a PATH holding only the sh script and .ps1", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "agy_acp_server"), "#!/bin/sh\nexit 1\n");
    fs.writeFileSync(path.join(dir, "agy_acp_server.ps1"), "# not launchable\n");
    // Neither is a program Windows can start, so there is no transport — the
    // caller falls back to print mode instead of launching a file that fails.
    expect(
      resolveAntigravityAcpBinary({
        userDataDir: tempDir(),
        env: { PATH: dir, PATHEXT },
        platform: "win32",
      }),
    ).toBeNull();
  });

  test("off Windows a configured path is still taken as given", () => {
    const dir = tempDir();
    const extensionless = makeExecutable(dir, "agy");
    fs.writeFileSync(path.join(dir, "agy.cmd"), "@echo off\r\n");
    // The extensionless file exists, so it is the answer — no suffix completion.
    const resolved = resolveAntigravityAcpBinary({
      userDataDir: tempDir(),
      binaryPath: extensionless,
      env: { PATH: "" },
      platform: "darwin",
    });
    expect(resolved?.executablePath).toBe(path.resolve(extensionless));

    // A lone .cmd sibling is not a completion off Windows: nothing exists at the
    // configured path, so the answer stays null.
    const other = tempDir();
    fs.writeFileSync(path.join(other, "agy.cmd"), "@echo off\r\n");
    expect(
      resolveAntigravityAcpBinary({
        userDataDir: tempDir(),
        binaryPath: path.join(other, "agy"),
        env: { PATH: "" },
        platform: "darwin",
      }),
    ).toBeNull();
  });
});
