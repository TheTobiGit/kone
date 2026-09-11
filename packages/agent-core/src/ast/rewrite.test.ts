// Fixed rewrite preview tests: pure functions over fixture strings only.
// No filesystem anywhere in this file — the disk-untouched promise is
// asserted at the gateway layer, where files actually exist.

import { describe, expect, test } from "bun:test";

import { Lang } from "@ast-grep/napi";

import {
  AST_MAX_MATCHES,
  AST_OUTPUT_BUDGET_CHARS,
  AST_TRUNCATION_MARKER,
} from "./engine.js";
import {
  AstRewriteError,
  applyEditsToText,
  formatRewritePreview,
  previewAddArgument,
  previewRenameCall,
} from "./rewrite.js";
import type { AstFilePreview } from "./rewrite.js";

function invalidInputOf(fn: () => AstFilePreview): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AstRewriteError);
    // SAFETY: the instanceof guard above pins the shape before reading.
    return (error as AstRewriteError).issue;
  }
  throw new Error("expected an AstRewriteError");
}

describe("previewRenameCall", () => {
  test("renames single-line calls with one row per match", () => {
    const preview = previewRenameCall("foo(1, 2);\nfoo();\nbar(1);\n", {
      from: "foo",
      to: "bar",
      path: "a.ts",
    });
    expect(preview.path).toBe("a.ts");
    expect(preview.replacements).toEqual([
      { line: 1, before: "foo(1, 2);", after: "bar(1, 2);" },
      { line: 2, before: "foo();", after: "bar();" },
    ]);
  });

  test("keeps multi-line formatting by splicing only the callee", () => {
    const source = 'foo(\n  "a",\n  "b",\n);\n';
    const preview = previewRenameCall(source, { from: "foo", to: "bar", path: "a.ts" });
    expect(preview.replacements).toEqual([{ line: 1, before: "foo(", after: "bar(" }]);
  });

  test("returns a neutral empty preview when nothing matches", () => {
    expect(previewRenameCall("bar(1);\n", { from: "foo", to: "baz", path: "a.ts" })).toEqual({
      path: "a.ts",
      replacements: [],
    });
  });

  test("refuses a non-identifier target instead of splicing it", () => {
    expect(invalidInputOf(() => previewRenameCall("foo(1);\n", { from: "foo", to: "a b" }))).toBe(
      "invalid-input",
    );
    expect(
      invalidInputOf(() => previewRenameCall("foo(1);\n", { from: "foo($$$ARGS)", to: "bar" })),
    ).toBe("invalid-input");
  });

  test("throws a parse issue for unparseable source", () => {
    try {
      previewRenameCall("const = = = broken (((\nfoo(1);\n", { from: "foo", to: "bar" });
    } catch (error) {
      expect(error).toBeInstanceOf(AstRewriteError);
      // SAFETY: the instanceof guard above pins the shape before reading.
      const rewriteError = error as AstRewriteError;
      expect(rewriteError.issue).toBe("parse");
      expect(rewriteError.message).toMatch(/could not parse/);
      return;
    }
    throw new Error("expected a parse AstRewriteError");
  });

  test("aborts the file on nested overlapping matches", () => {
    try {
      previewRenameCall("foo(foo(1));\n", { from: "foo", to: "bar", path: "a.ts" });
    } catch (error) {
      expect(error).toBeInstanceOf(AstRewriteError);
      // SAFETY: the instanceof guard above pins the shape before reading.
      const rewriteError = error as AstRewriteError;
      expect(rewriteError.issue).toBe("overlap");
      expect(rewriteError.message).toMatch(/a\.ts/);
      return;
    }
    throw new Error("expected an overlap AstRewriteError");
  });

  test("parses per the caller's language", () => {
    const source = "foo(<div />);\n";
    expect(() =>
      previewRenameCall(source, { from: "foo", to: "bar", lang: Lang.TypeScript }),
    ).toThrow(AstRewriteError);
    const preview = previewRenameCall(source, { from: "foo", to: "bar", lang: Lang.Tsx });
    expect(preview.replacements).toEqual([{ line: 1, before: "foo(<div />);", after: "bar(<div />);" }]);
  });

  test("stays byte-correct past multibyte characters", () => {
    const preview = previewRenameCall("// 😀\nfoo(1);\n", { from: "foo", to: "bar" });
    expect(preview.replacements).toEqual([{ line: 2, before: "foo(1);", after: "bar(1);" }]);
  });
});

describe("previewAddArgument", () => {
  test("appends last by default", () => {
    const preview = previewAddArgument("foo(1);\n", { name: "foo", argText: "2", path: "a.ts" });
    expect(preview.replacements).toEqual([{ line: 1, before: "foo(1);", after: "foo(1, 2);" }]);
  });

  test("prepends first with the separator after the new argument", () => {
    const preview = previewAddArgument("foo(1);\n", {
      name: "foo",
      argText: "2",
      position: "first",
    });
    expect(preview.replacements).toEqual([{ line: 1, before: "foo(1);", after: "foo(2, 1);" }]);
  });

  test("inserts bare into empty argument lists either way", () => {
    for (const position of ["first", "last"] as const) {
      const preview = previewAddArgument("foo();\n", { name: "foo", argText: "ctx", position });
      expect(preview.replacements).toEqual([{ line: 1, before: "foo();", after: "foo(ctx);" }]);
    }
  });

  test("keeps multi-line formatting with a point edit at the paren", () => {
    const source = 'foo(\n  "a"\n);\n';
    const last = previewAddArgument(source, { name: "foo", argText: '"b"' });
    expect(last.replacements).toEqual([{ line: 3, before: ");", after: ', "b");' }]);
    const first = previewAddArgument(source, { name: "foo", argText: '"b"', position: "first" });
    expect(first.replacements).toEqual([{ line: 1, before: "foo(", after: 'foo("b",' }]);
  });

  test("returns a neutral empty preview when nothing matches", () => {
    expect(previewAddArgument("bar(1);\n", { name: "foo", argText: "2", path: "a.ts" })).toEqual({
      path: "a.ts",
      replacements: [],
    });
  });

  test("accepts spreads and lists, refusing empties", () => {
    expect(
      previewAddArgument("foo(1);\n", { name: "foo", argText: "...args" }).replacements.length,
    ).toBe(1);
    expect(
      previewAddArgument("foo(1);\n", { name: "foo", argText: '"a", 2' }).replacements.length,
    ).toBe(1);
    expect(invalidInputOf(() => previewAddArgument("foo(1);\n", { name: "foo", argText: "" }))).toBe(
      "invalid-input",
    );
    expect(invalidInputOf(() => previewAddArgument("foo(1);\n", { name: "foo", argText: "   " }))).toBe(
      "invalid-input",
    );
  });

  test("rejects smuggled statements by naming the extra code", () => {
    for (const argText of ["1); evil(", "a(b))(", "1, 2); foo("]) {
      let message = "";
      try {
        previewAddArgument("foo(1);\n", { name: "foo", argText });
      } catch (error) {
        expect(error).toBeInstanceOf(AstRewriteError);
        // SAFETY: the instanceof guard above pins the shape before reading.
        const rewriteError = error as AstRewriteError;
        expect(rewriteError.issue).toBe("invalid-input");
        message = rewriteError.message;
      }
      expect(message).toMatch(/only the argument list/);
    }
  });

  test("refuses a non-identifier name and aborts nested matches", () => {
    expect(invalidInputOf(() => previewAddArgument("foo(1);\n", { name: "a b", argText: "2" }))).toBe(
      "invalid-input",
    );
    try {
      previewAddArgument("foo(foo(1));\n", { name: "foo", argText: "2", path: "a.ts" });
    } catch (error) {
      expect(error).toBeInstanceOf(AstRewriteError);
      // SAFETY: the instanceof guard above pins the shape before reading.
      expect((error as AstRewriteError).issue).toBe("overlap");
      return;
    }
    throw new Error("expected an overlap AstRewriteError");
  });
});

describe("applyEditsToText", () => {
  test("splices disjoint edits while keeping the rest byte-identical", () => {
    expect(applyEditsToText("foo(1, 2);", [{ start: 0, end: 3, newText: "bar" }])).toBe(
      "bar(1, 2);",
    );
    expect(
      applyEditsToText("foo(1);\nfoo(2);\n", [
        { start: 8, end: 11, newText: "bar" },
        { start: 0, end: 3, newText: "bar" },
      ]),
    ).toBe("bar(1);\nbar(2);\n");
  });

  test("preserves multi-line formatting on a callee splice", () => {
    const source = 'foo(\n  "a",\n);\n';
    expect(applyEditsToText(source, [{ start: 0, end: 3, newText: "bar" }])).toBe(
      'bar(\n  "a",\n);\n',
    );
  });

  test("applies same-point inserts in order", () => {
    expect(
      applyEditsToText("foo();", [
        { start: 4, end: 4, newText: "a" },
        { start: 4, end: 4, newText: "b" },
      ]),
    ).toBe("foo(ab);");
  });

  test("aborts the whole text on overlapping edits, never partially", () => {
    expect(() =>
      applyEditsToText("foo(1);", [
        { start: 0, end: 3, newText: "x" },
        { start: 2, end: 5, newText: "y" },
      ]),
    ).toThrow(AstRewriteError);
    try {
      applyEditsToText("foo(1);", [
        { start: 0, end: 7, newText: "x" },
        { start: 2, end: 5, newText: "y" },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(AstRewriteError);
      // SAFETY: the instanceof guard above pins the shape before reading.
      expect((error as AstRewriteError).issue).toBe("overlap");
      return;
    }
    throw new Error("expected an overlap AstRewriteError");
  });

  test("refuses out-of-range and inverted edits", () => {
    expect(() => applyEditsToText("foo();", [{ start: 0, end: 99, newText: "x" }])).toThrow(
      AstRewriteError,
    );
    expect(() => applyEditsToText("foo();", [{ start: 4, end: 2, newText: "x" }])).toThrow(
      AstRewriteError,
    );
  });

  test("leaves the text alone with no edits", () => {
    expect(applyEditsToText("foo(1);\n", [])).toBe("foo(1);\n");
  });
});

describe("formatRewritePreview", () => {
  const shown: AstFilePreview = {
    path: "src/a.ts",
    replacements: [{ line: 1, before: "foo(1, 2);", after: "bar(1, 2);" }],
  };

  test("reports an empty result with neutral copy", () => {
    const text = formatRewritePreview({
      change: { kind: "rename", from: "foo", to: "bar" },
      files: [],
      totalReplacements: 0,
      filesTouched: 0,
      filesSearched: 2,
      limitReached: false,
      parseIssues: [],
      parseIssuesTotal: 0,
    });
    expect(text).toBe('No calls to "foo" found — nothing to preview.');
  });

  test("groups rows by file with path:line anchors and both lines", () => {
    const text = formatRewritePreview({
      change: { kind: "rename", from: "foo", to: "bar" },
      files: [shown],
      totalReplacements: 1,
      filesTouched: 1,
      filesSearched: 2,
      limitReached: false,
      parseIssues: [],
      parseIssuesTotal: 0,
    });
    expect(text).toContain('1 call to "foo" renamed to "bar" across 1 file (2 files searched, preview only — nothing was changed):');
    expect(text).toContain("src/a.ts:");
    expect(text).toContain("  src/a.ts:1 - foo(1, 2); → bar(1, 2);");
    expect(text).toContain("Re-verify each match before applying");
  });

  test("heads an add-argument preview with the inserted text", () => {
    const text = formatRewritePreview({
      change: { kind: "add", name: "foo", argText: "ctx" },
      files: [{ path: "a.ts", replacements: [{ line: 1, before: "foo();", after: "foo(ctx);" }] }],
      totalReplacements: 1,
      filesTouched: 1,
      filesSearched: 1,
      limitReached: false,
      parseIssues: [],
      parseIssuesTotal: 0,
    });
    expect(text).toContain('1 call to "foo" with "ctx" added across 1 file');
  });

  test("notes the replacement cap and parse issues on the same output", () => {
    const text = formatRewritePreview({
      change: { kind: "rename", from: "foo", to: "bar" },
      files: [shown],
      totalReplacements: AST_MAX_MATCHES + 1,
      filesTouched: 1,
      filesSearched: 2,
      limitReached: true,
      parseIssues: [{ path: "broken.ts", message: "could not parse file: the source has syntax errors" }],
      parseIssuesTotal: 1,
    });
    expect(text).toContain("limit reached");
    expect(text).toContain(`${AST_MAX_MATCHES} replacements`);
    expect(text).toContain("1 file could not be parsed and was skipped:");
    expect(text).toContain("broken.ts");
  });

  test("cuts past the output budget with a marker", () => {
    const big: AstFilePreview = {
      path: "big.ts",
      replacements: [
        { line: 1, before: `x${"y".repeat(AST_OUTPUT_BUDGET_CHARS)}`, after: "z" },
      ],
    };
    const text = formatRewritePreview({
      change: { kind: "rename", from: "foo", to: "bar" },
      files: [big],
      totalReplacements: 1,
      filesTouched: 1,
      filesSearched: 1,
      limitReached: false,
      parseIssues: [],
      parseIssuesTotal: 0,
    });
    expect(text.endsWith(AST_TRUNCATION_MARKER)).toBe(true);
  });
});
