import { describe, expect, test } from "bun:test";

import { stabilizeStreamingMarkdown as stabilize } from "./streamingMarkdown";

describe("stabilizeStreamingMarkdown", () => {
  test("leaves finished text alone", () => {
    expect(stabilize("Hello **world**.")).toBe("Hello **world**.");
    expect(stabilize("")).toBe("");
  });

  test("holds back a trailing line that is only a block marker", () => {
    expect(stabilize("Intro\n\n#")).toBe("Intro\n\n");
    expect(stabilize("Intro\n##")).toBe("Intro\n");
    expect(stabilize("- one\n-")).toBe("- one\n");
    expect(stabilize("1. one\n2.")).toBe("1. one\n");
    expect(stabilize("> ")).toBe("");
  });

  test("keeps a marker line once it has content", () => {
    expect(stabilize("## Setup")).toBe("## Setup");
    expect(stabilize("- one")).toBe("- one");
  });

  test("does not mistake a rule for a bare marker", () => {
    expect(stabilize("above\n\n---")).toBe("above\n\n---");
  });

  test("closes an open bold mark provisionally", () => {
    expect(stabilize("This is **bo")).toBe("This is **bo**");
  });

  test("holds back a bold opener with nothing after it", () => {
    expect(stabilize("This is **")).toBe("This is ");
  });

  test("closes open inline code, and ignores asterisks inside it", () => {
    expect(stabilize("Run `bun te")).toBe("Run `bun te`");
    expect(stabilize("Glob `**/*.ts` then **ne")).toBe("Glob `**/*.ts` then **ne**");
    expect(stabilize("Run `")).toBe("Run ");
  });

  test("only looks at the block being written", () => {
    expect(stabilize("Stray ** earlier.\n\nNow **bo")).toBe("Stray ** earlier.\n\nNow **bo**");
  });

  test("never touches the inside of an open code fence", () => {
    const src = "```ts\nconst a = `x\n#";
    expect(stabilize(src)).toBe(src);
  });

  test("works again after a fence closes", () => {
    expect(stabilize("```\ncode\n```\n\nThen **bo")).toBe("```\ncode\n```\n\nThen **bo**");
  });
});
