import { describe, expect, it } from "bun:test";

import { probeTwoArgFooCalls } from "./astGrepProbe.js";

// Spike pins for the native binding: exact two-arg foo calls match across
// single and multi-line spellings, while lookalikes stay silent.
const SOURCE = [
  'import { foo } from "./x";',
  "// foo(1, 2) in a comment must not match",
  "foo(1, 2);",
  "foo(",
  '  "a",',
  '  "b",',
  ");",
  "myfoo(1, 2);",
  "foo(1);",
  "foo(1, 2, 3);",
  "",
].join("\n");

describe("astGrepProbe — native binding spike", () => {
  it("finds the single-line and multi-line two-arg calls", () => {
    const result = probeTwoArgFooCalls(SOURCE);
    expect(result.hits.length).toBe(2);
    expect(result.hits[0]?.text).toBe("foo(1, 2)");
    expect(result.hits[1]?.text).toBe('foo(\n  "a",\n  "b",\n)');
  });

  it("ignores the comment mention, the partial-identifier lookalike, and arity mismatches", () => {
    const result = probeTwoArgFooCalls(SOURCE);
    const texts = result.hits.map((hit) => hit.text);
    expect(texts.some((text) => text.includes("myfoo"))).toBe(false);
    expect(texts.some((text) => text.includes("//"))).toBe(false);
    expect(result.hits.length).toBe(2);
  });

  it("exposes ranges and metavars on each hit", () => {
    const result = probeTwoArgFooCalls(SOURCE);
    const second = result.hits[1]?.range;
    expect(second?.start.line).toBe(3);
    expect(second?.end.line).toBe(6);
    expect(result.firstArgOfFirstHit).toBe("1");
  });

  it("pins getTransformed as always-null so nobody builds on it", () => {
    const result = probeTwoArgFooCalls(SOURCE);
    expect(result.transformedOfFirstHit).toBeNull();
  });
});
