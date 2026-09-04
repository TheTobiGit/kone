import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureAntigravityAcpRuntime,
  installedAntigravityAcpVersion,
  isAntigravityAcpRuntimeCurrent,
  removeAntigravityAcpRuntime,
} from "./antigravityAcpInstall.js";
import { ANTIGRAVITY_ACP_RELEASE_VERSION } from "./antigravityRelease.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kone-antigravity-install-"));
}

/** Minimal CRC-32 for hand-built stored zip entries. */
let crcTable: number[] | null = null;

function crc32(data: Buffer): number {
  if (!crcTable) {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crcTable = table;
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (const byte of data) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal stored (uncompressed) zip holding the given named entries. */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(crc32(entry.data), 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, entry.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 12);
    record.writeUInt16LE(0, 14);
    record.writeUInt32LE(crc32(entry.data), 18);
    record.writeUInt32LE(entry.data.length, 22);
    record.writeUInt32LE(entry.data.length, 26);
    record.writeUInt16LE(name.length, 30);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.data.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDir, end]);
}

function stubFetch(zip: Buffer) {
  return async (): Promise<Response> =>
    new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
}

describe("installedAntigravityAcpVersion", () => {
  test("reads the active pointer when its files exist", () => {
    const userData = tempDir();
    const managedDir = path.join(userData, "tools", "antigravity-acp", "darwin-arm64");
    fs.mkdirSync(path.join(managedDir, ANTIGRAVITY_ACP_RELEASE_VERSION), { recursive: true });
    fs.writeFileSync(path.join(managedDir, ANTIGRAVITY_ACP_RELEASE_VERSION, "agy_acp_server.par"), "x");
    fs.writeFileSync(path.join(managedDir, ANTIGRAVITY_ACP_RELEASE_VERSION, "localharness_external"), "x");
    fs.writeFileSync(
      path.join(managedDir, "active.json"),
      JSON.stringify({
        version: ANTIGRAVITY_ACP_RELEASE_VERSION,
        executable: `${ANTIGRAVITY_ACP_RELEASE_VERSION}/agy_acp_server.par`,
        harness: `${ANTIGRAVITY_ACP_RELEASE_VERSION}/localharness_external`,
      }),
    );
    expect(installedAntigravityAcpVersion(userData, "darwin", "arm64")).toBe(
      ANTIGRAVITY_ACP_RELEASE_VERSION,
    );
    expect(isAntigravityAcpRuntimeCurrent(userData, "darwin", "arm64")).toBe(true);
  });

  test("returns null when files are missing or nothing is installed", () => {
    const userData = tempDir();
    expect(installedAntigravityAcpVersion(userData, "darwin", "arm64")).toBeNull();
    expect(isAntigravityAcpRuntimeCurrent(userData, "darwin", "arm64")).toBe(false);
    const managedDir = path.join(userData, "tools", "antigravity-acp", "darwin-arm64");
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      path.join(managedDir, "active.json"),
      JSON.stringify({ version: "old", executable: "gone", harness: "gone" }),
    );
    expect(installedAntigravityAcpVersion(userData, "darwin", "arm64")).toBeNull();
  });
});

describe("ensureAntigravityAcpRuntime", () => {
  test("rejects hosts with no published runtime", async () => {
    await expect(
      ensureAntigravityAcpRuntime(tempDir(), { platform: "darwin", arch: "x64" }),
    ).rejects.toThrow("No managed Antigravity ACP runtime");
  });

  test("rejects bytes that fail verification and cleans up", async () => {
    const zip = buildZip([
      { name: "agy_acp_server.par", data: Buffer.from("not the real server") },
      { name: "localharness_external", data: Buffer.from("not the real harness") },
    ]);
    const userData = tempDir();
    await expect(
      ensureAntigravityAcpRuntime(userData, {
        platform: "darwin",
        arch: "arm64",
        fetchImpl: stubFetch(zip),
      }),
    ).rejects.toThrow("verification");
    expect(installedAntigravityAcpVersion(userData, "darwin", "arm64")).toBeNull();
  });

  test("shares one download between concurrent callers", async () => {
    let calls = 0;
    const zip = buildZip([{ name: "agy_acp_server.par", data: Buffer.from("x") }]);
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(zip, { status: 200 });
    };
    const userData = tempDir();
    const results = await Promise.allSettled([
      ensureAntigravityAcpRuntime(userData, { platform: "darwin", arch: "arm64", fetchImpl }),
      ensureAntigravityAcpRuntime(userData, { platform: "darwin", arch: "arm64", fetchImpl }),
    ]);
    expect(calls).toBe(1);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });
});

describe("removeAntigravityAcpRuntime", () => {
  test("removes the managed dir", async () => {
    const userData = tempDir();
    const managedDir = path.join(userData, "tools", "antigravity-acp", "darwin-arm64");
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, "active.json"), "{}");
    await removeAntigravityAcpRuntime(userData, "darwin", "arm64");
    expect(fs.existsSync(managedDir)).toBe(false);
  });
});
