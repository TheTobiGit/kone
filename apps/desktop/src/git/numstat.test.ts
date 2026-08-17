import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "./core.js";
import { numstat, parseNumstat } from "./numstat.js";

// Paths that break a naive parser. Plain spaces are the easy case — git leaves
// those alone even without -z — so each of the others carries a byte that git
// would quote or escape, or that a line-oriented split would cut in half.
const AWKWARD = {
  nonAscii: "café.txt",
  spaces: "plain name with space.txt",
  quoted: 'quote"and\\backslash.txt',
  tab: "tab\there.txt",
  newline: "new\nline.txt",
} as const;

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kone-git-numstat-"));
  const g = (args: string[]) => git(dir, args);
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "test@kone.app"]);
  await g(["config", "user.name", "Kone Test"]);
  // Quoting on is git's default; set it explicitly so the test still proves
  // something on a machine whose global config turned it off.
  await g(["config", "core.quotePath", "true"]);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body);
  }
  await g(["add", "-A"]);
  await g(["commit", "-m", "one"]);
  return dir;
}

describe("parseNumstat", () => {
  test("reads a plain entry", () => {
    expect(parseNumstat("3\t1\ta.txt\0")).toEqual([
      { path: "a.txt", added: 3, removed: 1, binary: false },
    ]);
  });

  test("reads a rename as one entry carrying its from-path", () => {
    // The path slot is empty and the two paths follow as their own records.
    expect(parseNumstat("1\t0\t\0old.txt\0new.txt\0")).toEqual([
      { path: "new.txt", from: "old.txt", added: 1, removed: 0, binary: false },
    ]);
  });

  test("reports a binary file as 0/0 rather than NaN", () => {
    const [entry] = parseNumstat("-\t-\tbin.dat\0");
    expect(entry).toEqual({
      path: "bin.dat",
      added: 0,
      removed: 0,
      binary: true,
    });
    // The counts are summed and rendered; a NaN here would poison the total.
    expect(Number.isNaN(entry!.added)).toBe(false);
  });

  test("keeps a path containing a newline in one piece", () => {
    expect(parseNumstat("2\t0\tnew\nline.txt\0")).toEqual([
      { path: "new\nline.txt", added: 2, removed: 0, binary: false },
    ]);
  });

  test("keeps a path containing a tab in one piece", () => {
    // Only the first two tabs are separators — the rest of the record is path.
    expect(parseNumstat("2\t0\ttab\there.txt\0")).toEqual([
      { path: "tab\there.txt", added: 2, removed: 0, binary: false },
    ]);
  });

  test("ignores empty and malformed records", () => {
    expect(parseNumstat("")).toEqual([]);
    expect(parseNumstat("\0\0")).toEqual([]);
    expect(parseNumstat("garbage\0")).toEqual([]);
    expect(parseNumstat("1\tonly-one-tab\0")).toEqual([]);
  });

  test("parses what git actually emits for an awkward path", async () => {
    // Guards the hand-written fixtures above against a format change: if git
    // ever moves the separators, this fails alongside the real callers.
    const dir = await makeRepo({ [AWKWARD.nonAscii]: "a\nb\n" });
    await writeFile(path.join(dir, AWKWARD.nonAscii), "a\nb\nc\n");
    const raw = await git(dir, [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "HEAD",
    ]);
    expect(parseNumstat(raw)).toEqual([
      { path: AWKWARD.nonAscii, added: 1, removed: 0, binary: false },
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("numstat", () => {
  test("returns paths as raw bytes, not git's quoted form", async () => {
    // Without -z git would hand back `"caf\303\251.txt"` and
    // `"quote\"and\\\\backslash.txt"`, which match no real path.
    const dir = await makeRepo({
      [AWKWARD.nonAscii]: "a\n",
      [AWKWARD.spaces]: "a\n",
      [AWKWARD.quoted]: "a\n",
    });
    for (const name of [AWKWARD.nonAscii, AWKWARD.spaces, AWKWARD.quoted]) {
      await writeFile(path.join(dir, name), "a\nb\n");
    }

    const byPath = new Map(
      (await numstat(dir, ["--no-renames", "HEAD"])).map((e) => [e.path, e]),
    );
    for (const name of [AWKWARD.nonAscii, AWKWARD.spaces, AWKWARD.quoted]) {
      expect(byPath.get(name)?.added).toBe(1);
    }
    for (const key of byPath.keys()) {
      expect(key.startsWith('"')).toBe(false);
    }

    await rm(dir, { recursive: true, force: true });
  });

  test("pairs a renamed non-ASCII path with where it came from", async () => {
    const dir = await makeRepo({ [AWKWARD.nonAscii]: "a\nb\nc\nd\ne\nf\n" });
    await git(dir, ["mv", AWKWARD.nonAscii, "renamed ünicode.txt"]);
    await git(dir, ["add", "-A"]);

    const entries = await numstat(dir, ["--find-renames", "--cached", "HEAD"]);
    expect(entries).toEqual([
      {
        path: "renamed ünicode.txt",
        from: AWKWARD.nonAscii,
        added: 0,
        removed: 0,
        binary: false,
      },
    ]);

    await rm(dir, { recursive: true, force: true });
  });
});
