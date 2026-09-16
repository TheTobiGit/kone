import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

import { expandHtmlTables, tableHtmlToNode, type MdNode } from "./safeHtmlTable";

function text(content: string): MdNode {
  return { type: "text", tag: "", attrs: {}, children: [], content, info: "" };
}

function softbreak(): MdNode {
  return { type: "softbreak", tag: "", attrs: {}, children: [], content: "", info: "" };
}

function para(children: MdNode[]): MdNode {
  return { type: "paragraph", tag: "p", attrs: {}, children, content: "", info: "" };
}

/** Every text run in the tree, in order. */
function allText(nodes: MdNode[]): string[] {
  const out: string[] = [];
  const walk = (node: MdNode): void => {
    if (node.type === "text") out.push(node.content);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** Every element tag in the tree. */
function allTags(nodes: MdNode[]): string[] {
  const out: string[] = [];
  const walk = (node: MdNode): void => {
    if (node.tag) out.push(node.tag);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

function findTable(nodes: MdNode[]): MdNode | undefined {
  return nodes.find((n) => n.type === "table");
}

/** Fold real markdown-it tokens (html:false, as the thread configures it) into
 *  paragraph nodes the way the message component does. */
function paragraphsFromTokens(tokens: Token[]): MdNode[] {
  const out: MdNode[] = [];
  let current: MdNode[] | null = null;
  for (const tok of tokens) {
    if (tok.type === "paragraph_open") {
      current = [];
      continue;
    }
    if (tok.type === "paragraph_close") {
      if (current) {
        out.push(para(current));
        current = null;
      }
      continue;
    }
    if (tok.type === "inline") {
      for (const kid of tok.children ?? []) {
        if (!current) continue;
        if (kid.type === "text") current.push(text(kid.content));
        else if (kid.type === "softbreak" || kid.type === "hardbreak") current.push(softbreak());
        else if (kid.type === "html_inline") {
          current.push({ type: "html_inline", tag: "", attrs: {}, children: [], content: kid.content, info: "" });
        }
      }
    }
  }
  return out;
}

const BUG_SOURCE = [
  "Here you go, all 16.",
  "",
  "<table><tr><th>Fixture</th><th>Home</th></tr><tr><td>A</td><td>B</td></tr></table>",
].join("\n");

describe("safeHtmlTable", () => {
  test("a raw single-line table becomes a table node with its cells", () => {
    const nodes = expandHtmlTables([
      para([text("Here you go, all 16.")]),
      para([text("<table><tr><th>Fixture</th><th>Home</th></tr><tr><td>A</td><td>B</td></tr></table>")]),
    ]);
    expect(nodes[0]?.type).toBe("paragraph");
    const table = findTable(nodes);
    expect(table).toBeDefined();
    const texts = allText(nodes);
    expect(texts).toContain("Fixture");
    expect(texts).toContain("Home");
    expect(texts).toContain("A");
    expect(texts).toContain("B");
    expect(texts.some((t) => t.includes("<table>"))).toBe(false);
    expect(texts.some((t) => t.includes("</table>"))).toBe(false);
  });

  test("a multiline table split across softbreaks still becomes one table", () => {
    const nodes = expandHtmlTables([
      para([
        text("<table>"),
        softbreak(),
        text("<tr><th>Fixture</th></tr>"),
        softbreak(),
        text("<tr><td>A</td></tr>"),
        softbreak(),
        text("</table>"),
      ]),
    ]);
    const table = findTable(nodes);
    expect(table).toBeDefined();
    expect(allText(nodes)).toContain("Fixture");
    expect(allText(nodes)).toContain("A");
  });

  test("an inline table amid prose splits into prose/table/prose", () => {
    const nodes = expandHtmlTables([
      para([text("before <table><tr><td>x</td></tr></table> after")]),
    ]);
    expect(nodes.length).toBe(3);
    expect(nodes[0]?.type).toBe("paragraph");
    expect(nodes[1]?.type).toBe("table");
    expect(nodes[2]?.type).toBe("paragraph");
    expect(allText(nodes)).toContain("before ");
    expect(allText(nodes)).toContain("x");
    expect(allText(nodes)).toContain(" after");
  });

  test("a lone script stays inert text and never becomes a node", () => {
    const nodes = expandHtmlTables([para([text('<script>alert("x")</script>')])]);
    expect(findTable(nodes)).toBeUndefined();
    expect(allTags(nodes)).not.toContain("script");
    // Still present as text (renders escaped), never executed.
    expect(allText(nodes).join("")).toContain('alert("x")');
  });

  test("a script nested in a cell degrades to its words", () => {
    const table = tableHtmlToNode("<table><tr><td><script>alert(1)</script></td></tr></table>");
    expect(table).not.toBeNull();
    const tags = allTags(table ? [table] : []);
    expect(tags).not.toContain("script");
    expect(allText(table ? [table] : []).join("")).toBe("alert(1)");
  });

  test("only colspan/rowspan survive; handlers, styles and classes are dropped", () => {
    const table = tableHtmlToNode(
      '<table class="evil" onclick="steal()"><tr><td colspan="2" rowspan="3" style="color:red" onclick="x()" class="c">A</td><td>B</td></tr></table>',
    );
    expect(table).not.toBeNull();
    const tags = allTags(table ? [table] : []);
    expect(tags).toContain("td");
    const firstRow = table?.children[0]?.children[0] ?? table?.children[1]?.children[0];
    const firstCell = firstRow?.children[0];
    expect(firstCell?.attrs.colspan).toBe("2");
    expect(firstCell?.attrs.rowspan).toBe("3");
    expect(firstCell?.attrs.onclick).toBeUndefined();
    expect(firstCell?.attrs.style).toBeUndefined();
    expect(firstCell?.attrs.class).toBeUndefined();
    expect(table?.attrs.onclick).toBeUndefined();
    expect(table?.attrs.class).toBeUndefined();
  });

  test("a span of 1 is omitted and absurd spans are dropped", () => {
    const table = tableHtmlToNode('<table><tr><td colspan="1" rowspan="999">A</td></tr></table>');
    expect(table).not.toBeNull();
    const cell = table?.children[0]?.children[0]?.children[0];
    expect(cell?.attrs.colspan).toBeUndefined();
    expect(cell?.attrs.rowspan).toBeUndefined();
  });

  test("a partial table still streaming in stays untouched text", () => {
    const source = "<table><tr><td>A</td></tr>";
    const nodes = expandHtmlTables([para([text(source)])]);
    expect(findTable(nodes)).toBeUndefined();
    expect(allText(nodes).join("")).toBe(source);
  });

  test("an empty table parses to null instead of an empty node", () => {
    expect(tableHtmlToNode("<table></table>")).toBeNull();
    expect(tableHtmlToNode("<table><tr></tr></table>")).toBeNull();
  });

  test("an explicit thead/tbody structure is preserved", () => {
    const table = tableHtmlToNode(
      "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>",
    );
    expect(table).not.toBeNull();
    expect(table?.children.map((c) => c.tag)).toEqual(["thead", "tbody"]);
    expect(allText(table ? [table] : [])).toEqual(["H", "B"]);
  });

  test("end to end: real html:false tokens for the reported reply expand to a table", () => {
    const md = new MarkdownIt({ html: false });
    const tokens = md.parse(BUG_SOURCE, {});
    // The bug shape: no table_open token; the markup sits in text.
    expect(tokens.some((t) => t.type === "table_open")).toBe(false);
    expect(tokens.some((t) => t.type === "inline" && t.content.includes("<table>"))).toBe(true);
    const nodes = expandHtmlTables(paragraphsFromTokens(tokens));
    const table = findTable(nodes);
    expect(table).toBeDefined();
    const texts = allText(nodes);
    expect(texts).toContain("Here you go, all 16.");
    expect(texts).toContain("Fixture");
    expect(texts.some((t) => t.includes("<table>"))).toBe(false);
  });
});
