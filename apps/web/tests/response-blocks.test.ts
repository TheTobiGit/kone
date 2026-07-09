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

describe("inline markdown helpers", () => {
  test("recognizes and strips links and emphasis", () => {
    const value = "Read **the [guide](https://example.com)**.";
    expect(hasInlineMarkdown(value)).toBe(true);
    expect(stripInlineMarkdown(value)).toBe("Read the guide.");
  });
});
