import { describe, expect, test } from "bun:test";

import { expandHtmlTables, type MdNode } from "../utils/safeHtmlTable";
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

describe("useMarkdown raw HTML tables", () => {
  test("a raw <table> reply expands into table nodes with no literal tags", async () => {
    const { parse } = useMarkdown();
    const src = [
      "Here you go, all 16.",
      "",
      "<table><tr><th>Fixture</th><th>Home</th></tr><tr><td>A</td><td>B</td></tr></table>",
    ].join("\n");
    const tokens = await parse(src);
    expect(tokens).not.toBeNull();
    const list = tokens ?? [];
    // html:false keeps the markup as escaped text — never a table token.
    expect(list.some((t) => t.type === "table_open")).toBe(false);
    expect(list.some((t) => t.type === "inline" && t.content.includes("<table>"))).toBe(true);
    // The thread lifts that text into real table nodes before rendering.
    const kids: MdNode[] = [];
    for (const inline of list) {
      if (inline.type !== "inline") continue;
      for (const kid of inline.children ?? []) {
        if (kid.type === "text" && kid.content.includes("<table>")) {
          kids.push({ type: "text", tag: "", attrs: {}, children: [], content: kid.content, info: "" });
        }
      }
    }
    expect(kids.length).toBeGreaterThan(0);
    const nodes = expandHtmlTables([
      { type: "paragraph", tag: "p", attrs: {}, children: kids, content: "", info: "" },
    ]);
    expect(nodes.some((n) => n.type === "table")).toBe(true);
    const texts: string[] = [];
    const walk = (node: MdNode): void => {
      if (node.type === "text") texts.push(node.content);
      for (const child of node.children) walk(child);
    };
    for (const node of nodes) walk(node);
    expect(texts).toContain("Fixture");
    expect(texts.some((t) => t.includes("<table>"))).toBe(false);
  });
});
