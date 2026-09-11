import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BUDGET_CHARS,
  DEFAULT_MAX_REFERENCES_WITH_CONTEXT,
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatReferences,
  formatSymbols,
  formatWorkspaceEdit,
  TRUNCATION_MARKER,
} from "./responseBudget.js";
import type { BudgetReference, BudgetSymbol } from "./responseBudget.js";

function reference(line: number, file = "src/a.ts"): BudgetReference {
  return {
    path: file,
    line,
    character: 4,
    contextLines: [`line ${line} before`, `line ${line} match`, `line ${line} after`],
  };
}

describe("formatReferences", () => {
  test("reports an empty result plainly", () => {
    expect(formatReferences([])).toBe("No references found.");
  });

  test("renders every reference with context under the limit", () => {
    const text = formatReferences([reference(3)]);
    expect(text).toBe(["src/a.ts:3", "  line 3 before", "  line 3 match", "  line 3 after"].join("\n"));
  });

  test("collapses the tail past the default limit", () => {
    const refs: BudgetReference[] = [];
    for (let line = 1; line <= DEFAULT_MAX_REFERENCES_WITH_CONTEXT + 1; line += 1) {
      refs.push(reference(line, `src/f${line}.ts`));
    }
    const lines = formatReferences(refs).split("\n");
    expect(lines).toContain("... 1 more shown without context");
    const divider = lines.indexOf("... 1 more shown without context");
    expect(lines[divider + 1]).toBe(
      `src/f${DEFAULT_MAX_REFERENCES_WITH_CONTEXT + 1}.ts:${DEFAULT_MAX_REFERENCES_WITH_CONTEXT + 1}:5`,
    );
    // Detailed section keeps context; the collapsed pointer carries none.
    expect(lines.slice(0, divider).join("\n")).toContain("line 1 match");
  });

  test("honours a custom context limit", () => {
    const text = formatReferences([reference(1), reference(2), reference(3)], { maxWithContext: 1 });
    const lines = text.split("\n");
    expect(lines[0]).toBe("src/a.ts:1");
    expect(lines).toContain("... 2 more shown without context");
    expect(lines).toContain("src/a.ts:2:5");
    expect(lines).toContain("src/a.ts:3:5");
  });

  test("collapses everything when the limit is zero", () => {
    const lines = formatReferences([reference(1), reference(2)], { maxWithContext: 0 }).split("\n");
    expect(lines[0]).toBe("... 2 more shown without context");
  });

  test("falls back to the default on an unusable limit", () => {
    const refs: BudgetReference[] = [];
    for (let line = 1; line <= DEFAULT_MAX_REFERENCES_WITH_CONTEXT + 1; line += 1) {
      refs.push(reference(line));
    }
    expect(formatReferences(refs, { maxWithContext: -1 })).toBe(formatReferences(refs));
  });
});

describe("formatLocations", () => {
  test("reports an empty result plainly", () => {
    expect(formatLocations([])).toBe("No locations found.");
  });

  test("renders path:line:col pointers", () => {
    expect(
      formatLocations([{ path: "src/a.ts", line: 3, character: 6 }]),
    ).toBe("src/a.ts:3:7");
  });

  test("truncates past the character budget with a marker", () => {
    const locations = [];
    for (let line = 1; line <= 50; line += 1) {
      locations.push({ path: "src/very/long/file-name-that-pads-each-line.ts", line, character: 0 });
    }
    const text = formatLocations(locations, { maxChars: 100 });
    expect(text.endsWith(`\n${TRUNCATION_MARKER}`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100 + `\n${TRUNCATION_MARKER}`.length);
  });

  test("leaves text inside the budget untouched", () => {
    const single = "src/a.ts:3:7";
    expect(formatLocations([{ path: "src/a.ts", line: 3, character: 6 }], { maxChars: single.length })).toBe(
      single,
    );
  });

  test("uses the default budget without options", () => {
    const text = "x".repeat(DEFAULT_BUDGET_CHARS + 1);
    expect(formatHover(text).endsWith(`\n${TRUNCATION_MARKER}`)).toBe(true);
  });
});

describe("formatHover", () => {
  test("reports missing hover plainly", () => {
    expect(formatHover("")).toBe("No hover information found.");
    expect(formatHover("   \n ")).toBe("No hover information found.");
  });

  test("passes short hover text through", () => {
    expect(formatHover("```ts\nconst foo: number\n```")).toBe("```ts\nconst foo: number\n```");
  });
});

describe("formatDiagnostics", () => {
  test("reports a clean file plainly", () => {
    expect(formatDiagnostics([])).toBe("No diagnostics found.");
  });

  test("renders severity, message, and source", () => {
    const text = formatDiagnostics([
      { path: "src/a.ts", line: 2, character: 8, severity: 1, source: "ts", message: "Cannot find name." },
      { path: "src/a.ts", line: 5, character: 0, severity: 2, message: "Unused variable." },
      { path: "src/b.ts", line: 1, character: 0, message: "A note without metadata." },
    ]);
    expect(text).toBe(
      [
        "src/a.ts:2:9 [error] Cannot find name. (ts)",
        "src/a.ts:5:1 [warning] Unused variable.",
        "src/b.ts:1:1 A note without metadata.",
      ].join("\n"),
    );
  });

  test("labels every severity", () => {
    const text = formatDiagnostics([
      { path: "a.ts", line: 1, character: 0, severity: 3, message: "m" },
      { path: "a.ts", line: 2, character: 0, severity: 4, message: "m" },
    ]);
    expect(text).toContain("[information]");
    expect(text).toContain("[hint]");
  });

  test("truncates past the character budget with a marker", () => {
    const diagnostics = [];
    for (let line = 1; line <= 200; line += 1) {
      diagnostics.push({ path: "src/a.ts", line, character: 0, severity: 1 as const, message: "Broken." });
    }
    const text = formatDiagnostics(diagnostics, { maxChars: 64 });
    expect(text.endsWith(`\n${TRUNCATION_MARKER}`)).toBe(true);
  });
});

describe("formatSymbols", () => {
  test("reports an empty result plainly", () => {
    expect(formatSymbols([])).toBe("No symbols found.");
  });

  test("renders the name, detail, and pointer", () => {
    const symbols: BudgetSymbol[] = [
      { name: "Store/save", detail: "method", path: "src/a.ts", line: 3, character: 6 },
      { name: "plain", path: "src/b.ts", line: 1, character: 0 },
    ];
    expect(formatSymbols(symbols)).toBe(
      ["Store/save (method) - src/a.ts:3:7", "plain - src/b.ts:1:1"].join("\n"),
    );
  });

  test("truncates past the character budget with a marker", () => {
    const symbols: BudgetSymbol[] = [];
    for (let line = 1; line <= 60; line += 1) {
      symbols.push({ name: `symbol${line}`, path: "src/very/long/file-name-that-pads.ts", line, character: 0 });
    }
    const text = formatSymbols(symbols, { maxChars: 100 });
    expect(text.endsWith(`\n${TRUNCATION_MARKER}`)).toBe(true);
  });
});

describe("formatWorkspaceEdit", () => {
  test("reports an empty preview plainly", () => {
    expect(formatWorkspaceEdit([])).toBe("No changes previewed.");
    expect(formatWorkspaceEdit([{ path: "src/a.ts", edits: [] }])).toBe("No changes previewed.");
  });

  test("lists files with edit counts, ranges, and replacement previews", () => {
    const text = formatWorkspaceEdit([
      {
        path: "src/a.ts",
        edits: [
          { line: 2, character: 4, endLine: 2, endCharacter: 7, newText: "bar" },
          { line: 5, character: 0, endLine: 5, endCharacter: 3, newText: "bar" },
        ],
      },
      {
        path: "src/b.ts",
        edits: [{ line: 1, character: 0, endLine: 1, endCharacter: 3, newText: "bar" }],
      },
    ]);
    expect(text).toBe(
      [
        "3 edits across 2 files (preview only, nothing was changed):",
        "src/a.ts: 2 edits",
        '  2:5-2:8 -> "bar"',
        '  5:1-5:4 -> "bar"',
        "src/b.ts: 1 edit",
        '  1:1-1:4 -> "bar"',
      ].join("\n"),
    );
  });

  test("sorts files and edits deterministically", () => {
    const text = formatWorkspaceEdit([
      {
        path: "src/z.ts",
        edits: [
          { line: 9, character: 0, endLine: 9, endCharacter: 1, newText: "b" },
          { line: 2, character: 0, endLine: 2, endCharacter: 1, newText: "a" },
        ],
      },
      { path: "src/a.ts", edits: [{ line: 1, character: 0, endLine: 1, endCharacter: 1, newText: "a" }] },
    ]);
    const lines = text.split("\n");
    expect(lines[1]).toBe("src/a.ts: 1 edit");
    expect(lines[3]).toBe("src/z.ts: 2 edits");
    expect(lines[4]).toBe('  2:1-2:2 -> "a"');
    expect(lines[5]).toBe('  9:1-9:2 -> "b"');
  });

  test("truncates past the character budget with a marker", () => {
    const text = formatWorkspaceEdit(
      [
        {
          path: "src/a.ts",
          edits: [
            { line: 1, character: 0, endLine: 1, endCharacter: 3, newText: "x".repeat(500) },
          ],
        },
      ],
      { maxChars: 64 },
    );
    expect(text.endsWith(`\n${TRUNCATION_MARKER}`)).toBe(true);
  });
});
