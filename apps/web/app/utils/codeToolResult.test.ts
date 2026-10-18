import { describe, expect, test } from "bun:test";
import { errorLines, isToolInput, outputTail, parseDiffSummary, parseSearchMatches, parseTestTally } from "./codeToolResult";

describe("parseDiffSummary", () => {
  test("counts a unified hunk and keeps its first changed lines", () => {
    const diff = "@@ -472,3 +472,4 @@\n-    <p>{{ segText(seg) }}</p>\n+    <MarkdownMessage :source=\"segText(seg)\" />\n context\n+    <span />";
    expect(parseDiffSummary(diff)).toEqual({
      added: 2,
      removed: 1,
      preview: [
        { sign: "-", text: "<p>{{ segText(seg) }}</p>" },
        { sign: "+", text: "<MarkdownMessage :source=\"segText(seg)\" />" },
        { sign: "+", text: "<span />" },
      ],
    });
  });

  test("skips file headers", () => {
    expect(parseDiffSummary("diff --git a/x b/x\n--- a/x\n+++ b/x\n+one")?.added).toBe(1);
  });

  test("counts changed lines whose text starts with dashes or pluses", () => {
    expect(parseDiffSummary("@@ -1,1 +1,1 @@\n----\n+++bold+++")).toMatchObject({ added: 1, removed: 1 });
    expect(parseDiffSummary("----\n+===")).toMatchObject({ added: 1, removed: 1 });
  });

  test("declines Codex's before/after text pair", () => {
    expect(parseDiffSummary("--- before\nold\n\n+++ after\nnew")).toBeNull();
    expect(parseDiffSummary("+++ after\nnew file")).toBeNull();
  });

  test("still reads a real diff that changes a `-- before` line", () => {
    expect(parseDiffSummary("@@ -1,1 +1,1 @@\n--- before\n+++ after")).toMatchObject({ added: 1, removed: 1 });
  });

  test("ignores a call's streamed input and a body with no changes", () => {
    expect(parseDiffSummary('{"file_path":"a.ts","old_string":"-x"}')).toBeNull();
    expect(parseDiffSummary("Edit applied successfully.")).toBeNull();
  });
});

describe("parseSearchMatches", () => {
  test("groups file:line results by file, in order", () => {
    const files = parseSearchMatches("a.vue:42:  emit(\"send\")\nb.ts:205:  async function send()\na.vue:58:  emit(\"stop\")");
    expect(files.map((f) => [f.path, f.matches.length])).toEqual([
      ["a.vue", 2],
      ["b.ts", 1],
    ]);
    expect(files[0]!.matches[0]).toEqual({ line: 42, text: 'emit("send")' });
  });

  test("reads a glob's bare paths", () => {
    expect(parseSearchMatches("src/a.ts\nsrc/b.vue").map((f) => f.path)).toEqual(["src/a.ts", "src/b.vue"]);
  });

  test("reads a glob's paths with spaces in them", () => {
    expect(parseSearchMatches("src/My Component.vue").map((f) => f.path)).toEqual(["src/My Component.vue"]);
  });

  test("reads a count-mode search's paths", () => {
    expect(parseSearchMatches("src/a.ts:3\nsrc/b.vue:1").map((f) => f.path)).toEqual(["src/a.ts", "src/b.vue"]);
  });

  test("reads extensionless and bracketed glob paths", () => {
    expect(parseSearchMatches("Dockerfile\napp/[id]/page.tsx").map((f) => f.path)).toEqual(["Dockerfile", "app/[id]/page.tsx"]);
  });

  test("reads nothing from prose", () => {
    expect(parseSearchMatches("No matches found")).toEqual([]);
    expect(parseSearchMatches("No files found in src/app")).toEqual([]);
    expect(parseSearchMatches("Found 3 files")).toEqual([]);
  });
});

describe("parseTestTally", () => {
  test("reads bun's summary", () => {
    expect(parseTestTally(" 12 pass\n 0 fail\n 27 expect() calls\nRan 12 tests across 1 file. [412ms]")).toEqual({
      passed: 12,
      failed: 0,
      skipped: 0,
      time: "412ms",
    });
  });

  test("takes the run's time, not a test's", () => {
    expect(parseTestTally("✓ a [3.10ms]\n 1 pass\n 0 fail\nRan 1 test across 1 file. [388ms]")?.time).toBe("388ms");
  });

  test("reads jest and pytest summaries", () => {
    expect(parseTestTally("Tests:       1 failed, 2 skipped, 40 passed, 43 total")).toMatchObject({ passed: 40, failed: 1, skipped: 2 });
    expect(parseTestTally("===== 3 failed, 97 passed in 4.20s =====")).toMatchObject({ passed: 97, failed: 3, time: "4.20s" });
  });

  test("takes jest's test totals over its suite totals", () => {
    const out = "Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 40 passed, 41 total\nTime:        2.1 s";
    expect(parseTestTally(out)).toMatchObject({ passed: 40, failed: 1 });
  });

  test("takes vitest's test totals over its file totals", () => {
    const out = " Test Files  1 passed (1)\n      Tests  40 passed (40)\n   Duration  1.20s";
    expect(parseTestTally(out)).toMatchObject({ passed: 40, failed: 0 });
  });

  test("counts a run where every test was skipped", () => {
    expect(parseTestTally("Tests:       4 skipped, 4 total")).toMatchObject({ passed: 0, failed: 0, skipped: 4 });
  });

  test("is null for output that isn't a test run", () => {
    expect(parseTestTally(" ✓ no type errors\nDone in 3.1s")).toBeNull();
  });
});

describe("isToolInput", () => {
  test("is a JSON object, not output that merely starts with a bracket", () => {
    expect(isToolInput('{"command":"bun test"}')).toBe(true);
    expect(isToolInput("[INFO] build started\n[INFO] done")).toBe(false);
    expect(isToolInput('["a","b"]')).toBe(false);
    expect(isToolInput('{"command": "bun t')).toBe(false);
  });
});

describe("output lines", () => {
  test("keep a command's output that starts with a bracket", () => {
    expect(outputTail('[INFO] start\n{"ok": true}')).toEqual(["[INFO] start", '{"ok": true}']);
    expect(errorLines("[ERROR] build failed")).toEqual(["[ERROR] build failed"]);
  });

  test("tail keeps the last printed lines", () => {
    expect(outputTail("a\n\nb\nc\n")).toEqual(["b", "c"]);
  });

  test("error lines prefer the ones naming an error", () => {
    const out = "src/x.vue\n  482:11  error  'toolsLive' is defined but never used\n\n✖ 1 problem (1 error, 0 warnings)";
    expect(errorLines(out)).toEqual(["482:11  error  'toolsLive' is defined but never used", "✖ 1 problem (1 error, 0 warnings)"]);
  });
});
