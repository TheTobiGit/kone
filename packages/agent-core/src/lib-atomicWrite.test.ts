import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeFileAtomic, writeFileAtomicSync } from "./lib-atomicWrite.js";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kone-atomicwrite-"));
}

function tmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("writeFileAtomicSync", () => {
  test("creates a missing file with the exact contents", () => {
    const dir = freshDir();
    const target = path.join(dir, "state.json");
    writeFileAtomicSync(target, '{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("replaces existing content atomically (old bytes are gone)", () => {
    const dir = freshDir();
    const target = path.join(dir, "state.json");
    writeFileAtomicSync(target, "first");
    writeFileAtomicSync(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("accepts a Uint8Array body", () => {
    const dir = freshDir();
    const target = path.join(dir, "bytes.bin");
    writeFileAtomicSync(target, new Uint8Array([1, 2, 3]));
    expect(readFileSync(target)).toEqual(Buffer.from([1, 2, 3]));
  });

  test("throws and cleans up when the destination cannot be replaced", () => {
    const dir = freshDir();
    // A directory at the destination makes the final rename fail, so the write
    // must throw and must not leave its temp file behind.
    const target = path.join(dir, "state.json");
    mkdirSync(target);
    expect(() => writeFileAtomicSync(target, "x")).toThrow();
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("never writes a sibling file (temp is scoped to the target name)", () => {
    const dir = freshDir();
    const target = path.join(dir, "state.json");
    const sibling = path.join(dir, "other.json");
    writeFileAtomicSync(sibling, "keep me");
    writeFileAtomicSync(target, "new");
    expect(readFileSync(sibling, "utf8")).toBe("keep me");
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});

describe("writeFileAtomic (async)", () => {
  test("creates a missing file with the exact contents", async () => {
    const dir = freshDir();
    const target = path.join(dir, "state.json");
    await writeFileAtomic(target, '{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("replaces existing content and leaves no temp litter", async () => {
    const dir = freshDir();
    const target = path.join(dir, "state.json");
    writeFileSync(target, "old", "utf8");
    await writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("throws and cleans up when the destination cannot be replaced", async () => {
    const dir = freshDir();
    const target = path.join(dir, "state.json");
    mkdirSync(target);
    await expect(writeFileAtomic(target, "x")).rejects.toThrow();
    expect(tmpFiles(dir)).toEqual([]);
  });
});
