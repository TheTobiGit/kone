import { describe, expect, test } from "bun:test";

import {
  hasInlineMarkdown,
  parseResponseBlocks,
  stripInlineMarkdown,
} from "../app/lib/response-blocks";

describe("parseResponseBlocks", () => {
  test("parses mixed response content in stable order", () => {
    const blocks = parseResponseBlocks(`# Result

One **calm** paragraph.

- first
- second

> Keep the useful context.

| File | State |
| --- | --- |
| index.vue | changed |

\`\`\`ts
const ready = true;
\`\`\``);

    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "blockquote",
      "table",
      "code",
    ]);
  });

  test("keeps an unterminated streaming fence as code", () => {
    expect(parseResponseBlocks("```ts\nconst partial = true;")).toEqual([
      {
        type: "code",
        language: "ts",
        text: "const partial = true;",
      },
    ]);
  });

  test("returns no phantom paragraph for empty text", () => {
    expect(parseResponseBlocks(" \n ")).toEqual([]);
  });
});

describe("nested lists", () => {
  test("keeps a flat list's items childless", () => {
    const blocks = parseResponseBlocks("- first\n- second");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [{ text: "first" }, { text: "second" }],
      },
    ]);
  });

  test("nests indented items under their parent (2+ spaces per level)", () => {
    const blocks = parseResponseBlocks(
      "- parent one\n  - child one\n  - child two\n- parent two",
    );

    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          {
            text: "parent one",
            children: {
              type: "list",
              ordered: false,
              items: [{ text: "child one" }, { text: "child two" }],
            },
          },
          { text: "parent two" },
        ],
      },
    ]);
  });

  test("supports a tab as one indent level and mixed ordered/unordered nesting", () => {
    const blocks = parseResponseBlocks(
      "1. step one\n\t1. sub step a\n\t2. sub step b\n2. step two\n  - a note",
    );

    expect(blocks).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          {
            text: "step one",
            children: {
              type: "list",
              ordered: true,
              items: [{ text: "sub step a" }, { text: "sub step b" }],
            },
          },
          {
            text: "step two",
            children: {
              type: "list",
              ordered: false,
              items: [{ text: "a note" }],
            },
          },
        ],
      },
    ]);
  });

  test("supports three levels of nesting", () => {
    const blocks = parseResponseBlocks(
      "- a\n  - b\n    - c",
    );

    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          {
            text: "a",
            children: {
              type: "list",
              ordered: false,
              items: [
                {
                  text: "b",
                  children: {
                    type: "list",
                    ordered: false,
                    items: [{ text: "c" }],
                  },
                },
              ],
            },
          },
        ],
      },
    ]);
  });
});

describe("inline markdown helpers", () => {
  test("recognizes and strips links and emphasis", () => {
    const value = "Read **the [guide](https://example.com)**.";
    expect(hasInlineMarkdown(value)).toBe(true);
    expect(stripInlineMarkdown(value)).toBe("Read the guide.");
  });
});
