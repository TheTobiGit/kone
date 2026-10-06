import { expect, test } from "bun:test";
import { diffStats, parseUnifiedDiff } from "./unifiedDiff.js";

test("hunk line numbers reset for each hunk and each file", () => {
  const lines = parseUnifiedDiff("@@ -42,2 +50,2 @@\n-old\n+new\n context\n@@ -100 +110 @@\n-a\n+b\n--- c\n+++ c\n@@ -5 +6 @@\n-x\n+y\n");
  expect(lines.filter((l) => l.kind === "del").map((l) => l.oldNo)).toEqual([42, 100, 5]);
  expect(lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([50, 110, 6]);
});

test("stdout prefixes and file headers never count as additions or deletions", () => {
  expect(diffStats("-no permission\n+retry\n--- a\n+++ b")).toEqual({ added: 0, removed: 0 });
  expect(diffStats("@@ -1 +1 @@\n---data\n+++data\n")).toEqual({ added: 1, removed: 1 });
});
