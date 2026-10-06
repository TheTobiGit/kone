import { expect, test } from "bun:test";
import { diffStats, parseUnifiedDiff, unifiedDiffFromTexts } from "./unifiedDiff.js";

test("hunk line numbers reset for each hunk and each file", () => {
  const lines = parseUnifiedDiff("@@ -42,2 +50,2 @@\n-old\n+new\n context\n@@ -100 +110 @@\n-a\n+b\n--- c\n+++ c\n@@ -5 +6 @@\n-x\n+y\n");
  expect(lines.filter((l) => l.kind === "del").map((l) => l.oldNo)).toEqual([42, 100, 5]);
  expect(lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([50, 110, 6]);
});

test("stdout prefixes and file headers never count as additions or deletions", () => {
  expect(diffStats("-no permission\n+retry\n--- a\n+++ b")).toEqual({ added: 0, removed: 0 });
  expect(diffStats("@@ -1 +1 @@\n---data\n+++data\n")).toEqual({ added: 1, removed: 1 });
});

test("a one-line edit in a long file is one small hunk", () => {
  const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 250", "LINE 250");
  const diff = unifiedDiffFromTexts(before, after);
  expect(diff.split("\n")[0]).toBe("@@ -248,7 +248,7 @@");
  expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
  const del = parseUnifiedDiff(diff).find((l) => l.kind === "del");
  expect(del).toMatchObject({ text: "line 250", oldNo: 251 });
});

test("changes far apart get their own hunks; close ones share one", () => {
  const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
  const far = before.replace("l5\n", "x5\n").replace("l30\n", "x30\n");
  expect(unifiedDiffFromTexts(before, far).match(/^@@/gm)).toHaveLength(2);
  const near = before.replace("l5\n", "x5\n").replace("l9\n", "x9\n");
  expect(unifiedDiffFromTexts(before, near).match(/^@@/gm)).toHaveLength(1);
});

test("created and removed files, and equal texts", () => {
  expect(unifiedDiffFromTexts("", "a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
  expect(unifiedDiffFromTexts("a\nb", "")).toBe("@@ -1,2 +0,0 @@\n-a\n-b");
  expect(unifiedDiffFromTexts("same\n", "same\n")).toBe("");
});

/** Apply a unified diff to `before`, trusting only its numbered lines. */
function applyDiff(before: string, diff: string): string {
  const lines = parseUnifiedDiff(diff);
  const kept = before === "" ? [] : before.split("\n");
  const rebuilt: string[] = [];
  let cursor = 1;
  for (const l of lines) {
    if (l.kind === "hunk") continue;
    const at = l.oldNo ?? cursor;
    while (cursor < at) rebuilt.push(kept[cursor++ - 1]!);
    if (l.kind === "context") { rebuilt.push(l.text); cursor++; }
    else if (l.kind === "del") cursor++;
    else rebuilt.push(l.text);
  }
  while (cursor <= kept.length) rebuilt.push(kept[cursor++ - 1]!);
  return rebuilt.join("\n");
}

test("the diff round-trips: applying it to before yields after", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
  const after = "a\nB\nc\nd\nnew\ne\nf\ng\ni\nj\nk";
  expect(applyDiff(before, unifiedDiffFromTexts(before, after))).toBe(after);
});

test("random edits round-trip", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 300; round++) {
    const before = Array.from({ length: rand(30) }, () => `v${rand(6)}`);
    const after = [...before];
    for (let edits = rand(6); edits > 0; edits--) {
      const at = rand(after.length + 1);
      if (rand(2) && after.length) after.splice(Math.min(at, after.length - 1), 1);
      else after.splice(at, 0, `n${rand(6)}`);
    }
    const a = before.join("\n");
    const b = after.join("\n");
    expect(applyDiff(a, unifiedDiffFromTexts(a, b))).toBe(b);
  }
});
