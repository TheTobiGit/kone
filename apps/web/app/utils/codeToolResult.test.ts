import { describe, expect, test } from "bun:test";
import { errorLines, isCommandInput, isToolInput, matchCount, outputTail, parseDiffSummary, parseSearchMatches, parseTestTally } from "./codeToolResult";

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

  test("keeps a first context line that starts with a dash", () => {
    expect(parseDiffSummary(" - item one\n-- item two\n+- item 2")).toMatchObject({ added: 1, removed: 1 });
  });

  test("declines Codex's before/after text pair", () => {
    expect(parseDiffSummary("--- before\nold\n\n+++ after\nnew")).toBeNull();
    expect(parseDiffSummary("+++ after\nnew file")).toBeNull();
    expect(parseDiffSummary("--- before\n-old")).toBeNull();
  });

  test("still reads a real diff that changes a `-- before` line", () => {
    expect(parseDiffSummary("@@ -1,1 +1,1 @@\n--- before\n+++ after")).toMatchObject({ added: 1, removed: 1 });
    expect(parseDiffSummary(" a\n--- old\n+++ new\n b")).toMatchObject({ added: 1, removed: 1 });
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

  test("reads Windows paths, drive letter and all", () => {
    const files = parseSearchMatches("C:\\repo\\foo.ts:12:const x = 1\nC:\\repo\\My File.ts");
    expect(files.map((f) => [f.path, f.matches.length])).toEqual([
      ["C:\\repo\\foo.ts", 1],
      ["C:\\repo\\My File.ts", 0],
    ]);
  });

  test("reads a root-level path with spaces", () => {
    expect(parseSearchMatches("My Component.vue").map((f) => f.path)).toEqual(["My Component.vue"]);
  });

  test("reads heading-style results under their file", () => {
    const files = parseSearchMatches("src/a.ts\n12:const a = 1\n30:const b = 2\n\nsrc/b.ts\n4:let c");
    expect(files.map((f) => [f.path, f.matches.map((m) => m.line)])).toEqual([
      ["src/a.ts", [12, 30]],
      ["src/b.ts", [4]],
    ]);
  });

  test("keeps a glob's dated filenames as files after another path", () => {
    expect(parseSearchMatches("notes/a.md\n2024-report.md").map((f) => f.path)).toEqual(["notes/a.md", "2024-report.md"]);
  });

  test("skips context rows and cluster separators", () => {
    const heading = parseSearchMatches("src/a.ts\n1-before\n2:hit\n3-after\n--\n9:again\n\nsrc/b.ts\n4:other");
    expect(heading.map((f) => [f.path, f.matches.map((m) => m.line)])).toEqual([
      ["src/a.ts", [2, 9]],
      ["src/b.ts", [4]],
    ]);
    const flat = parseSearchMatches("src/a.ts-1-before it\nsrc/a.ts:2:hit\nsrc/a.ts-3-after the hit\n--\nsrc/c.ts:7:more");
    expect(flat.map((f) => f.path)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(parseSearchMatches("src/foo-1-bar.ts-1-before\nsrc/foo-1-bar.ts:2:hit").map((f) => f.path)).toEqual(["src/foo-1-bar.ts"]);
  });

  test("reads a count-mode search's paths", () => {
    const files = parseSearchMatches("src/a.ts:3\nsrc/b.vue:1");
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.vue"]);
    expect(files.map(matchCount)).toEqual([3, 1]);
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

  test("reads pytest's xfail outcomes", () => {
    expect(parseTestTally("===== 1 passed, 1 xfailed, 1 xpassed in 0.02s =====")).toMatchObject({ passed: 2, failed: 0, skipped: 1 });
  });

  test("counts pytest errors as failures, but not a compiler's", () => {
    expect(parseTestTally("===== 1 failed, 2 passed, 1 error in 0.30s =====")).toMatchObject({ passed: 2, failed: 2 });
    expect(parseTestTally("Found 3 errors.\n 4 pass\n 0 fail")).toMatchObject({ passed: 4, failed: 0 });
    expect(parseTestTally("===== 1 error in 0.16s =====")).toMatchObject({ passed: 0, failed: 1 });
  });

  test("adds up every cargo test binary", () => {
    const out = "test result: ok. 1 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 2 passed; 1 failed; 1 ignored\n\ntest result: ok. 1 passed; 0 failed; 0 ignored";
    expect(parseTestTally(out)).toMatchObject({ passed: 4, failed: 1, skipped: 1 });
  });

  test("counts only the runner's summary, not what a test printed", () => {
    const bun = "log: 1 passed\nlog: 2 skipped\n✓ a\n 12 pass\n 1 skip\n 0 fail\nRan 13 tests across 1 file. [40ms]";
    expect(parseTestTally(bun)).toMatchObject({ passed: 12, failed: 0, skipped: 1 });
    expect(parseTestTally("  3 passing (5ms)\n  1 pending\n\n  1 failing\n\n  1) suite\n       x:\n     Error: boom")).toMatchObject({ passed: 3, failed: 1, skipped: 1 });
    expect(parseTestTally("  1 failed\n    [chromium] › a.spec.ts:3:1 › x\n  1 skipped\n  2 passed (3.2s)")).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
    expect(parseTestTally("saw 1 passed earlier\n===== 4 passed, 1 skipped in 0.20s =====")).toMatchObject({ passed: 4, skipped: 1 });
  });

  test("ignores a count line a test printed above the summary", () => {
    expect(parseTestTally("1 passed\n✓ a [2ms]\n\n 12 pass\n 0 fail\nRan 12 tests across 1 file. [40ms]")).toMatchObject({ passed: 12 });
  });

  test("counts playwright's flaky tests as passed", () => {
    expect(parseTestTally("  1 flaky\n    [chromium] › a.spec.ts:3:1 › x\n  2 passed (3.2s)")).toMatchObject({ passed: 3, failed: 0 });
  });

  test("adds up skipped and todo tests", () => {
    expect(parseTestTally("Tests:       1 skipped, 2 todo, 3 passed, 6 total")).toMatchObject({ passed: 3, skipped: 3 });
  });

  test("counts todo and ignored tests as skipped", () => {
    expect(parseTestTally("Tests:       1 todo, 2 passed, 3 total")).toMatchObject({ passed: 2, skipped: 1 });
    expect(parseTestTally("test result: ok. 5 passed; 0 failed; 2 ignored; 0 measured")).toMatchObject({ passed: 5, failed: 0, skipped: 2 });
  });

  test("takes jest's test totals over its suite totals", () => {
    const out = "Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 40 passed, 41 total\nTime:        2.1 s";
    expect(parseTestTally(out)).toMatchObject({ passed: 40, failed: 1, time: "2.1s" });
  });

  test("takes vitest's test totals over its file totals", () => {
    const out = " Test Files  1 passed (1)\n      Tests  40 passed (40)\n   Duration  1.20s";
    expect(parseTestTally(out)).toMatchObject({ passed: 40, failed: 0, time: "1.20s" });
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

describe("isCommandInput", () => {
  test("knows a shell call's input from JSON it printed", () => {
    expect(isCommandInput('{"command":"mkdir -p out","description":"Make dir"}', "mkdir -p out")).toBe(true);
    expect(isCommandInput('{"CommandLine":"true","Cwd":"/repo"}', "true")).toBe(true);
    expect(isCommandInput('{"command":"deploy"}', "cat command.json")).toBe(false);
    expect(isCommandInput('{"name":"kone"}', "cat package.json")).toBe(false);
    expect(isCommandInput("done", "true")).toBe(false);
  });
});
