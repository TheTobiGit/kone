import { describe, expect, test } from "bun:test";

import { useMarkdown } from "./useMarkdown";

// A real broken delimiter row — fewer cells than the header — which markdown-it
// refuses to parse as a table until the repair pass fixes it.
const BROKEN_TABLE = [
  "| | Normal mode (regular tasks/chats) | Studio |",
  "|---|---|",
  "| Purpose | Focused, interactive work | Long-running, agent-led work |",
].join("\n");

const VALID_TABLE = [
  "| A | B |",
  "|---|---|",
  "| 1 | 2 |",
].join("\n");

describe("useMarkdown table-delimiter repair", () => {
  test("parse() turns a broken delimiter row into a real table", async () => {
    const { parse } = useMarkdown();
    const tokens = await parse(BROKEN_TABLE);
    expect(tokens).not.toBeNull();
    expect(tokens!.some((token) => token.type === "table_open")).toBe(true);
  });

  test("render() repairs the same input into a <table>", async () => {
    const { render } = useMarkdown();
    const html = await render(BROKEN_TABLE);
    expect(html).not.toBeNull();
    expect(html).toContain("<table");
  });

  test("already-valid tables pass through unchanged", async () => {
    const { render } = useMarkdown();
    const html = await render(VALID_TABLE);
    expect(html).not.toBeNull();
    expect(html).toContain("<table");
    expect(html).not.toContain("</thead><tbody><tr><td>---");
  });
});
