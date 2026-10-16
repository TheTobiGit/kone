// markdown-it's flat token stream → the small node tree the thread renders.
//
// markdown-it hands a list with nesting encoded as open/close pairs. Folding it
// here, in one place, lets the component walk `.children` and lets tests fold
// the very tokens production parses — the same shape either way.
//
// The parser that feeds this runs with html enabled on the thread's instance,
// so raw markup arrives as `html_block` / `html_inline` tokens carrying the
// source exactly as written (inline transforms never touch them). Nothing here
// has to recover untransformed source after the fact.

import type Token from "markdown-it/lib/token.mjs";
import type { MdNode } from "./safeHtmlTable";

export function mkNode(tok: Token): MdNode {
  const attrs: Record<string, string> = {};
  for (const [k, v] of tok.attrs ?? []) attrs[k] = v;
  return {
    type: tok.type.replace(/_open$/, ""),
    tag: tok.tag,
    attrs,
    children: [],
    content: tok.content,
    info: tok.info,
  };
}

export function treeify(list: Token[]): MdNode[] {
  const root: MdNode = { type: "root", tag: "", attrs: {}, children: [], content: "", info: "" };
  const stack: MdNode[] = [root];
  for (const tok of list) {
    const top = stack[stack.length - 1]!;
    if (tok.type === "inline") {
      top.children.push(...treeify(tok.children ?? []));
      continue;
    }
    if (tok.nesting === 1) {
      const node = mkNode(tok);
      top.children.push(node);
      stack.push(node);
    } else if (tok.nesting === -1) {
      stack.pop();
    } else {
      top.children.push(mkNode(tok));
    }
  }
  return root.children;
}
