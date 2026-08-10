import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";

import { repairMarkdownTableDelimiters } from "./padMarkdown";

describe("repairMarkdownTableDelimiters", () => {
  test("pads a delimiter row that has fewer cells than the header", () => {
    const source = [
      "Studio vs. normal mode:",
      "",
      "| | Normal mode (regular tasks/chats) | Studio |",
      "|---|---|",
      "| Purpose | Focused, interactive work | Long-running, agent-led work |",
    ].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      [
        "Studio vs. normal mode:",
        "",
        "| | Normal mode (regular tasks/chats) | Studio |",
        "| --- | --- | --- |",
        "| Purpose | Focused, interactive work | Long-running, agent-led work |",
      ].join("\n"),
    );
  });

  test("drops delimiter cells beyond the header cell count", () => {
    const source = ["| a | b |", "|:--|---|--:|", "| 1 | 2 |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a | b |", "| :-- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  test("keeps the kept cells' alignment markers when padding", () => {
    const source = ["| a | b | c |", "|:--|--:|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a | b | c |", "| :-- | --: | --- |"].join("\n"),
    );
  });

  test("returns the input string unchanged when every table is well-formed", () => {
    const source = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("ignores pipe-and-dash lines inside fenced code blocks", () => {
    const source = ["```", "| a | b |", "|---|", "```"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("repairs a table that follows a closed fence", () => {
    const source = ["```ts", "const x = 1;", "```", "", "| a | b |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["```ts", "const x = 1;", "```", "", "| a | b |", "| --- | --- |"].join("\n"),
    );
  });

  test("ignores indented code blocks", () => {
    const source = ["Example:", "", "    | a | b |", "    |---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("ignores blockquoted headers", () => {
    const source = ["> | a | b |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("does not treat a dashed body row of an ongoing table as a delimiter", () => {
    const source = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| --- |"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("does not pair two delimiter-shaped rows as header and delimiter", () => {
    const source = ["|---|---|", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("does not count escaped pipes as cell boundaries", () => {
    const source = ["| a \\| b | c |", "|---|"].join("\n");

    expect(repairMarkdownTableDelimiters(source)).toBe(
      ["| a \\| b | c |", "| --- | --- |"].join("\n"),
    );
  });

  test("leaves text without any table candidates untouched", () => {
    const source = "plain prose - with a dash | and a pipe";

    expect(repairMarkdownTableDelimiters(source)).toBe(source);
  });

  test("repair makes markdown-it render a table the model's output would lose", () => {
    const md = new MarkdownIt();
    // A three-column header over a two-cell delimiter: GFM rejects the block
    // and renders it as a paragraph (the run-on wall of pipes).
    const raw = ["| | Normal mode | Studio |", "|---|---|", "| A | B | C |"].join("\n");
    const repaired = repairMarkdownTableDelimiters(raw);

    const types = (src: string) => md.parse(src, {}).map((t) => t.type);
    expect(types(raw)).not.toContain("table_open");
    expect(types(raw)).toContain("paragraph_open");
    expect(types(repaired)).toContain("table_open");
    expect(types(repaired)).not.toContain("paragraph_open");
  });
});
