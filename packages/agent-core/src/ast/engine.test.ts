// AstEngine tests: pure findCalls over fixture strings, plus one tmpdir walk
// covering node_modules, .gitignore, and globs. No network anywhere; the
// only filesystem writes are the walk fixtures, removed afterwards.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Lang } from "@ast-grep/napi";

import {
  AST_MAX_MATCHES,
  AST_SNIPPET_CHARS,
  AstEngine,
  findCallSpans,
  formatFindCalls,
  isPlainIdentifier,
  langForPath,
  snippetOf,
} from "./engine.js";
import type { AstFileInput } from "./engine.js";

const MULTI_LINE_SOURCE = [
  'import { foo } from "./x";',
  "// foo(1, 2) in a comment must not match",
  "foo(1, 2);",
  "foo(",
  '  "a",',
  '  "b",',
  ");",
  "myfoo(1, 2);",
  "obj.foo(1);",
  "",
].join("\n");

function inputs(entries: Array<[string, string]>): AstFileInput[] {
  return entries.map(([filePath, text]) => ({ path: filePath, text }));
}

describe("langForPath", () => {
  test("maps the six supported extensions, skipping the rest without error", () => {
    expect(langForPath("a.ts")).not.toBeNull();
    expect(langForPath("a.tsx")).not.toBeNull();
    expect(langForPath("a.js")).not.toBeNull();
    expect(langForPath("a.jsx")).not.toBeNull();
    expect(langForPath("a.mjs")).not.toBeNull();
    expect(langForPath("a.cjs")).not.toBeNull();
    expect(langForPath("a.py")).toBeNull();
    expect(langForPath("a.md")).toBeNull();
    expect(langForPath("Makefile")).toBeNull();
  });
});

describe("isPlainIdentifier", () => {
  test("accepts identifiers, refusing patterns and wildcards", () => {
    expect(isPlainIdentifier("foo")).toBe(true);
    expect(isPlainIdentifier("$foo")).toBe(true);
    expect(isPlainIdentifier("_f9")).toBe(true);
    expect(isPlainIdentifier("")).toBe(false);
    expect(isPlainIdentifier("foo($$$ARGS)")).toBe(false);
    expect(isPlainIdentifier("foo*")).toBe(false);
    expect(isPlainIdentifier("foo bar")).toBe(false);
    expect(isPlainIdentifier("9foo")).toBe(false);
  });
});

describe("AstEngine.parseText", () => {
  test("parses through to a root node", () => {
    const engine = new AstEngine();
    const root = engine.parseText(Lang.TypeScript, "foo(1);\n");
    expect(root.root().kind()).toBe("program");
  });
});

describe("AstEngine.findCalls", () => {
  test("matches single-line and multi-line calls by structure", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(inputs([["a.ts", MULTI_LINE_SOURCE]]), { name: "foo" });
    expect(result.matches.length).toBe(2);
    expect(result.matches[0]?.line).toBe(3);
    expect(result.matches[0]?.column).toBe(1);
    expect(result.matches[0]?.snippet).toBe("foo(1, 2)");
    expect(result.matches[1]?.line).toBe(4);
    expect(result.filesSearched).toBe(1);
    expect(result.limitReached).toBe(false);
  });

  test("ignores comments, partial identifiers, and member calls", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(inputs([["a.ts", MULTI_LINE_SOURCE]]), { name: "foo" });
    const snippets = result.matches.map((match) => match.snippet);
    expect(snippets.some((snippet) => snippet.includes("myfoo"))).toBe(false);
    expect(snippets.some((snippet) => snippet.includes("//"))).toBe(false);
    expect(snippets.some((snippet) => snippet.includes("obj.foo"))).toBe(false);
  });

  test("matches any arity with exact argument counts", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(
      inputs([["a.ts", "foo();\nfoo(1);\nfoo(1, 2, 3);\nfoo(1, /* note */ 2);\n"]]),
      { name: "foo" },
    );
    expect(result.matches.map((match) => match.argCount)).toEqual([0, 1, 3, 2]);
  });

  test("skips files that fail to parse with a counted issue, keeping the rest", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(
      inputs([
        ["broken.ts", "const = = = broken (((\nfoo(1);\n"],
        ["good.ts", "foo(2);\n"],
      ]),
      { name: "foo" },
    );
    expect(result.matches.map((match) => match.path)).toEqual(["good.ts"]);
    expect(result.parseIssuesTotal).toBe(1);
    expect(result.parseIssues.length).toBe(1);
    expect(result.parseIssues[0]?.path).toBe("broken.ts");
    expect(result.filesSearched).toBe(2);
  });

  test("skips unknown extensions without error or counting them as searched", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(inputs([["a.py", "foo(1)\n"]]), { name: "foo" });
    expect(result.matches).toEqual([]);
    expect(result.filesSearched).toBe(0);
    expect(result.parseIssuesTotal).toBe(0);
  });

  test("caps at 50 matches with limitReached set", () => {
    const engine = new AstEngine();
    const lines: string[] = [];
    for (let index = 0; index < AST_MAX_MATCHES + 10; index += 1) {
      lines.push(`foo(${index});`);
    }
    const result = engine.findCalls(inputs([["a.ts", `${lines.join("\n")}\n`]]), {
      name: "foo",
    });
    expect(result.matches.length).toBe(AST_MAX_MATCHES);
    expect(result.limitReached).toBe(true);
  });

  test("refuses a non-identifier name instead of building a pattern from it", () => {
    const engine = new AstEngine();
    expect(() => engine.findCalls(inputs([["a.ts", "foo(1);\n"]]), { name: "foo($$$ARGS)" })).toThrow();
  });
});

describe("findCallSpans", () => {
  function spansOf(text: string): ReturnType<typeof findCallSpans> {
    const engine = new AstEngine();
    const root = engine.parseText(Lang.TypeScript, text);
    return findCallSpans(root.root(), "foo");
  }

  function sliceBytes(text: string, start: number, end: number): string {
    return Buffer.from(text, "utf8").subarray(start, end).toString("utf8");
  }

  test("locates the callee and argument list as string offsets", () => {
    const text = "foo(1, 2);\n";
    const spans = spansOf(text);
    expect(spans.length).toBe(1);
    expect(sliceBytes(text, spans[0]?.startIndex ?? -1, spans[0]?.endIndex ?? -1)).toBe("foo(1, 2)");
    expect(sliceBytes(text, spans[0]?.calleeStartIndex ?? -1, spans[0]?.calleeEndIndex ?? -1)).toBe("foo");
    expect(sliceBytes(text, spans[0]?.argsStartIndex ?? -1, spans[0]?.argsEndIndex ?? -1)).toBe("(1, 2)");
    expect(spans[0]?.argCount).toBe(2);
    expect(spans[0]?.line).toBe(1);
    expect(spans[0]?.column).toBe(1);
  });

  test("reports string offsets past multibyte characters", () => {
    const text = "// 😀\nfoo(1);\n";
    const spans = spansOf(text);
    expect(spans.length).toBe(1);
    const callee = spans[0];
    expect(text.slice(callee?.calleeStartIndex ?? -1, callee?.calleeEndIndex ?? -1)).toBe("foo");
    expect(text.slice(callee?.startIndex ?? -1, callee?.endIndex ?? -1)).toBe("foo(1)");
  });

  test("spans a multi-line call from the callee through the closing paren", () => {
    const text = 'foo(\n  "a",\n);\n';
    const spans = spansOf(text);
    expect(spans.length).toBe(1);
    expect(sliceBytes(text, spans[0]?.calleeStartIndex ?? -1, spans[0]?.calleeEndIndex ?? -1)).toBe("foo");
    expect(sliceBytes(text, spans[0]?.argsStartIndex ?? -1, spans[0]?.argsEndIndex ?? -1)).toBe('(\n  "a",\n)');
  });

  test("agrees with findCalls on matches and arities", () => {
    const engine = new AstEngine();
    const found = engine.findCalls(inputs([["a.ts", MULTI_LINE_SOURCE]]), { name: "foo" });
    const root = engine.parseText(Lang.TypeScript, MULTI_LINE_SOURCE);
    const spans = findCallSpans(root.root(), "foo");
    expect(spans.length).toBe(found.matches.length);
    expect(spans.map((span) => span.argCount)).toEqual(found.matches.map((match) => match.argCount));
    expect(spans.map((span) => span.line)).toEqual(found.matches.map((match) => match.line));
  });

  test("orders nested matches outer-first for the overlap check", () => {
    const spans = spansOf("foo(foo(1));\n");
    expect(spans.length).toBe(2);
    expect(spans[0]?.startIndex).toBeLessThan(spans[1]?.startIndex ?? 0);
    expect(spans[0]?.endIndex).toBeGreaterThan(spans[1]?.endIndex ?? 0);
  });

  test("refuses a non-identifier name instead of building a pattern from it", () => {
    const engine = new AstEngine();
    const root = engine.parseText(Lang.TypeScript, "foo(1);\n");
    expect(() => findCallSpans(root.root(), "foo($$$ARGS)")).toThrow();
  });
});

describe("snippetOf", () => {
  test("keeps the first line whole under the width", () => {
    expect(snippetOf("foo(1, 2)")).toBe("foo(1, 2)");
  });

  test("cuts a multi-line match to its first line", () => {
    expect(snippetOf('foo(\n  "a",\n)')).toBe("foo(");
  });

  test("truncates past the snippet width with a marker", () => {
    const long = `foo("${"x".repeat(AST_SNIPPET_CHARS + 50)}");`;
    const snippet = snippetOf(long);
    expect(snippet.length).toBeLessThanOrEqual(AST_SNIPPET_CHARS + 1);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("AstEngine walk", () => {
  function fixtureProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-ast-walk-"));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(dir, "ignored"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), "ignored/\n*.log\n");
    writeFileSync(path.join(dir, "src", "a.ts"), "foo(1);\n");
    writeFileSync(path.join(dir, "src", "b.mjs"), "foo(2);\n");
    writeFileSync(path.join(dir, "src", "notes.md"), "foo(3);\n");
    writeFileSync(path.join(dir, "node_modules", "dep", "b.ts"), "foo(4);\n");
    writeFileSync(path.join(dir, "ignored", "c.ts"), "foo(5);\n");
    writeFileSync(path.join(dir, "debug.log"), "foo(6);\n");
    return dir;
  }

  test("skips node_modules, honours .gitignore, and drops unknown extensions", () => {
    const dir = fixtureProject();
    try {
      const engine = new AstEngine();
      const found = engine.collectFiles(dir, dir).sort();
      expect(found).toEqual([path.join(dir, "src", "a.ts"), path.join(dir, "src", "b.mjs")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("search walks, reads, and finds through the project root", () => {
    const dir = fixtureProject();
    try {
      const engine = new AstEngine();
      const result = engine.search(dir, dir, "foo");
      expect(result.filesSearched).toBe(2);
      expect(result.matches.length).toBe(2);
      expect(result.parseIssuesTotal).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("globs scope the walk, including zero-directory ** spans", () => {
    const dir = fixtureProject();
    try {
      const engine = new AstEngine();
      const scoped = engine.collectFiles(path.join(dir, "src", "*.ts"), dir);
      expect(scoped).toEqual([path.join(dir, "src", "a.ts")]);
      const deep = engine.collectFiles(path.join(dir, "**", "*.mjs"), dir);
      expect(deep).toEqual([path.join(dir, "src", "b.mjs")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatFindCalls", () => {
  test("reports an empty result with neutral copy", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(inputs([["a.ts", "bar(1);\n"]]), { name: "foo" });
    expect(formatFindCalls("foo", result)).toBe('No calls to "foo" found.');
  });

  test("groups matches by file with path:line anchors, snippets, and arities", () => {
    const engine = new AstEngine();
    const result = engine.findCalls(
      inputs([
        ["b.ts", "foo(1, 2);\n"],
        ["a.ts", "foo();\nfoo(9);\n"],
      ]),
      { name: "foo" },
    );
    const text = formatFindCalls("foo", result);
    expect(text).toContain('3 calls to "foo" across 2 files (2 files searched):');
    expect(text).toContain("a.ts:");
    expect(text).toContain("  a.ts:1 [0 args] foo()");
    expect(text).toContain("  b.ts:1 [2 args] foo(1, 2)");
  });

  test("notes the match cap and parse issues on the same output", () => {
    const engine = new AstEngine();
    const lines: string[] = [];
    for (let index = 0; index < AST_MAX_MATCHES + 1; index += 1) {
      lines.push(`foo(${index});`);
    }
    const result = engine.findCalls(
      inputs([
        ["a.ts", `${lines.join("\n")}\n`],
        ["broken.ts", "const = = = broken (((\n"],
      ]),
      { name: "foo" },
    );
    const text = formatFindCalls("foo", result);
    expect(text).toContain("limit reached");
    expect(text).toContain("1 file could not be parsed and was skipped:");
    expect(text).toContain("broken.ts");
  });
});
