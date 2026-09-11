import { describe, expect, test } from "bun:test";

import { resolvePosition } from "./symbolResolver.js";
import type { SymbolResolveRequest } from "./symbolResolver.js";

function request(overrides: Partial<SymbolResolveRequest> & { documentLines: readonly string[] }): SymbolResolveRequest {
  return {
    line1Indexed: 1,
    projectAware: false,
    ...overrides,
  };
}

describe("resolvePosition lines", () => {
  test("resolves a 1-indexed line to a 0-based protocol line", () => {
    const result = resolvePosition(
      request({ documentLines: ["first", "second"], line1Indexed: 2 }),
    );
    expect(result).toEqual({ kind: "ok", line: 1, character: 0 });
  });

  test("rejects lines outside the document", () => {
    expect(resolvePosition(request({ documentLines: ["only"], line1Indexed: 0 })).kind).toBe("error");
    expect(resolvePosition(request({ documentLines: ["only"], line1Indexed: 2 })).kind).toBe("error");
    expect(resolvePosition(request({ documentLines: [], line1Indexed: 1 })).kind).toBe("error");
  });

  test("names the offending line in the error", () => {
    const result = resolvePosition(request({ documentLines: ["only"], line1Indexed: 9 }));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("9");
  });
});

describe("resolvePosition without a symbol", () => {
  test("errors on project-aware servers", () => {
    const result = resolvePosition(
      request({ documentLines: ["const foo = 1;"], projectAware: true }),
    );
    expect(result.kind).toBe("error");
  });

  test("resolves to the first non-whitespace column otherwise", () => {
    const result = resolvePosition(
      request({ documentLines: ["\t  hello();"], projectAware: false }),
    );
    expect(result).toEqual({ kind: "ok", line: 0, character: 3 });
  });

  test("treats a blank symbol as omitted", () => {
    const result = resolvePosition(
      request({ documentLines: ["  hello();"], symbol: "   ", projectAware: false }),
    );
    expect(result).toEqual({ kind: "ok", line: 0, character: 2 });
  });

  test("resolves a blank line to column zero", () => {
    const result = resolvePosition(request({ documentLines: ["   "], projectAware: false }));
    expect(result).toEqual({ kind: "ok", line: 0, character: 0 });
  });
});

describe("resolvePosition with a symbol", () => {
  const line = "const foo = foo(foo);";

  test("picks the first match by default", () => {
    const result = resolvePosition(request({ documentLines: [line], symbol: "foo" }));
    expect(result).toEqual({ kind: "ok", line: 0, character: 6 });
  });

  test("picks the nth match for an explicit occurrence", () => {
    expect(resolvePosition(request({ documentLines: [line], symbol: "foo", occurrence: 2 }))).toEqual({
      kind: "ok",
      line: 0,
      character: 12,
    });
    expect(resolvePosition(request({ documentLines: [line], symbol: "foo", occurrence: 3 }))).toEqual({
      kind: "ok",
      line: 0,
      character: 16,
    });
  });

  test("reports how many matches exist when the occurrence is out of range", () => {
    const result = resolvePosition(
      request({ documentLines: [line], symbol: "foo", occurrence: 4 }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("4");
      expect(result.message).toContain("3");
    }
  });

  test("rejects non-positive and fractional occurrences", () => {
    for (const occurrence of [0, -2, 1.5]) {
      expect(
        resolvePosition(request({ documentLines: [line], symbol: "foo", occurrence })).kind,
      ).toBe("error");
    }
  });

  test("names the line when the symbol is absent", () => {
    const result = resolvePosition(
      request({ documentLines: [line, "other"], line1Indexed: 2, symbol: "foo" }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("foo");
      expect(result.message).toContain("2");
    }
  });

  test("matches case-sensitively", () => {
    expect(
      resolvePosition(request({ documentLines: ["const foo = 1;"], symbol: "FOO" })).kind,
    ).toBe("error");
  });
});

describe("resolvePosition utf-16 columns", () => {
  test("counts an astral character as two columns", () => {
    const result = resolvePosition(
      request({ documentLines: ["const 😀 = foo;"], symbol: "foo" }),
    );
    expect(result).toEqual({ kind: "ok", line: 0, character: 11 });
  });

  test("finds an astral symbol at its leading unit", () => {
    const result = resolvePosition(
      request({ documentLines: ["const 😀 = 1;"], symbol: "😀" }),
    );
    expect(result).toEqual({ kind: "ok", line: 0, character: 6 });
  });
});
