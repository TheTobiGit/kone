import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  antigravityHarnessFileName,
  findOnPath,
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
