// Raw HTML tables from model replies, rendered without ever touching v-html.
//
// markdown-it runs with html:false, so a reply containing
// `<table><tr><th>Fixture</th>…` arrives as plain text — and would read as a
// wall of literal tags. These helpers fold such text back into the same node
// shape GFM tables already produce (table → thead/tbody → tr → th/td), so the
// thread renders them through the existing styled table path.
//
// Safety comes from construction, not from filtering rendered markup: only the
// six table elements can ever become nodes, a cell keeps nothing but its text
// (every inner tag is stripped, so a nested script degrades to its words) and
// its validated colspan/rowspan, and every other attribute is dropped unseen.
// Nothing here creates elements or sets HTML — the component still mounts
// everything through `h()`, so there is no string a script could hide in.
//
// The parse is pure string work (no DOMParser), so it runs in the renderer and
// under `bun test` alike.

/** A table's opening tag and its close. Every path that asks "is there a table
 *  in this string?" asks through these two, and `TABLE_BLOCK` is the one
 *  splitter — so a change to what counts as a table lands in one place. */
const TABLE_OPEN = /<table[\s>]/i;
const TABLE_CLOSE = /<\/table\s*>/i;
const TABLE_BLOCK = /(<table\b[\s\S]*?<\/table\s*>)/i;

function hasCompleteTable(text: string): boolean {
  return TABLE_OPEN.test(text) && TABLE_CLOSE.test(text);
}

/** The markdown node tree both this module and MarkdownMessage work in: a
 *  markdown-it token folded to `{type, tag, attrs, children, content, info}`.
 *  One shape, defined once, so a table lifted out of raw text is the same thing
 *  to the renderer as one markdown-it parsed itself. */
export interface MdNode {
  type: string;
  tag: string;
  attrs: Record<string, string>;
  children: MdNode[];
  content: string;
  info: string;
}

function textNode(content: string): MdNode {
  return { type: "text", tag: "", attrs: {}, children: [], content, info: "" };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

// Named entities are deliberately limited to the five XML ones plus `&nbsp;`:
// those are what escaping a table's own text produces, and they are the only
// ones whose meaning is structural here. A `&copy;` or `&mdash;` stays literal
// rather than pulling in (and having to keep current) the full HTML5 table —
// a visible `&copy;` is a wrong glyph, where a wrong decode would be a wrong
// character with no way to tell.
function decodeEntities(value: string): string {
  const named = value.replace(/&(amp|lt|gt|quot|nbsp|apos);/gi, (full, word: string) => {
    const w = word.toLowerCase();
    if (w === "amp") return "&";
    if (w === "lt") return "<";
    if (w === "gt") return ">";
    if (w === "quot") return '"';
    if (w === "nbsp") return " ";
    if (w === "apos") return "'";
    return full;
  });
  const decimal = named.replace(/&#(\d{1,7});/g, (full, digits: string) => {
    const n = Number(digits);
    if (!Number.isInteger(n) || n < 1 || n > 1114111) return full;
    return String.fromCodePoint(n);
  });
  return decimal.replace(/&#x([0-9a-f]{1,6});/gi, (full, hex: string) => {
    const n = Number(`0x${hex}`);
    if (!Number.isInteger(n) || n < 1 || n > 1114111) return full;
    return String.fromCodePoint(n);
  });
}

export type SpanAttrs = { colspan?: number; rowspan?: number };
const SPAN_NAMES = ["colspan", "rowspan"] as const;
const SPAN_ATTR = /\b(colspan|rowspan)\s*=\s*(?:"(\d{1,3})"|'(\d{1,3})'|(\d{1,3}))/i;

/** The one span rule, applied on both sides of the node boundary: a cell keeps
 *  colspan/rowspan of 2–100. A span of 1 is the default and is omitted;
 *  anything unparsable is dropped. The parse below writes attrs through it, and
 *  the renderer reads them back through it — so there is one bound to change,
 *  not two that can drift apart. */
export function validatedSpans(attrs: Record<string, string | undefined>): SpanAttrs {
  const out: SpanAttrs = {};
  for (const name of SPAN_NAMES) {
    const raw = attrs[name];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 2 || n > 100) continue;
    out[name] = n;
  }
  return out;
}

/** Pull span candidates out of a cell's raw attribute text and keep the ones
 *  `validatedSpans` accepts, stringified back into the node's attr map. */
function parseSpan(attrText: string): Record<string, string> {
  const candidates: Record<string, string> = {};
  const hits = attrText.match(new RegExp(SPAN_ATTR.source, "gi")) ?? [];
  for (const hit of hits) {
    const m = SPAN_ATTR.exec(hit);
    const name = m?.[1]?.toLowerCase();
    const raw = m?.[2] ?? m?.[3] ?? m?.[4];
    if (name === undefined || raw === undefined) continue;
    if (candidates[name] === undefined) candidates[name] = raw;
  }
  const out: Record<string, string> = {};
  const spans = validatedSpans(candidates);
  for (const name of SPAN_NAMES) {
    const n = spans[name];
    if (n !== undefined) out[name] = String(n);
  }
  return out;
}

function cellToNode(cellHtml: string, isHeader: boolean): MdNode | null {
  const m = /^<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>$/i.exec(cellHtml.trim());
  if (!m) return null;
  const tag = m[1];
  if (tag === undefined) return null;
  const attrText = m[2] ?? "";
  const inner = m[3] ?? "";
  const lower = tag.toLowerCase();
  const kind = isHeader ? "th" : lower === "th" ? "th" : "td";
  const text = decodeEntities(stripTags(inner)).trim();
  return {
    type: kind,
    tag: kind,
    attrs: parseSpan(attrText),
    children: text ? [textNode(text)] : [],
    content: "",
    info: "",
  };
}

function rowToNode(rowHtml: string, isHeader: boolean): MdNode | null {
  const parts = rowHtml.match(/<(th|td)\b[^>]*>[\s\S]*?<\/\1\s*>/gi) ?? [];
  const cells: MdNode[] = [];
  for (const part of parts) {
    const cell = cellToNode(part, isHeader);
    if (cell) cells.push(cell);
  }
  if (cells.length === 0) return null;
  return { type: "tr", tag: "tr", attrs: {}, children: cells, content: "", info: "" };
}

/** A table fragment becomes a table node, or null when it holds no real rows —
 *  the caller then keeps the source as inert text rather than dropping words. */
export function tableHtmlToNode(tableHtml: string): MdNode | null {
  if (!hasCompleteTable(tableHtml)) return null;
  const thead = /<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i.exec(tableHtml);
  const theadInner = thead?.[1];
  const fullThead = thead?.[0];
  const headerRows: MdNode[] = [];
  const bodyRows: MdNode[] = [];
  if (theadInner !== undefined) {
    const parts = theadInner.match(/<tr\b[\s\S]*?<\/tr\s*>/gi) ?? [];
    for (const part of parts) {
      const row = rowToNode(part, true);
      if (row) headerRows.push(row);
    }
  }
  const rest = fullThead !== undefined ? tableHtml.replace(fullThead, "") : tableHtml;
  const rowHtmls = rest.match(/<tr\b[\s\S]*?<\/tr\s*>/gi) ?? [];
  let start = 0;
  // No explicit thead: a leading row of header cells is the header, matching
  // how the DOM reads `<table><tr><th>…` written without section elements.
  if (theadInner === undefined && rowHtmls.length > 0) {
    const first = rowHtmls[0];
    if (first !== undefined && /<th[\s>]/i.test(first)) {
      const head = rowToNode(first, true);
      if (head) headerRows.push(head);
      start = 1;
    }
  }
  for (let i = start; i < rowHtmls.length; i += 1) {
    const rowHtml = rowHtmls[i];
    if (rowHtml === undefined) continue;
    const row = rowToNode(rowHtml, false);
    if (row) bodyRows.push(row);
  }
  const children: MdNode[] = [];
  if (headerRows.length > 0) {
    children.push({ type: "thead", tag: "thead", attrs: {}, children: headerRows, content: "", info: "" });
  }
  if (bodyRows.length > 0) {
    children.push({ type: "tbody", tag: "tbody", attrs: {}, children: bodyRows, content: "", info: "" });
  }
  if (children.length === 0) return null;
  return { type: "table", tag: "table", attrs: {}, children, content: "", info: "" };
}

/** Plain text becomes a paragraph, preserving line breaks as softbreaks so the
 *  reveal pass keeps its word-by-word mounting. Blank runs become nothing. */
function textToParagraph(text: string): MdNode | null {
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const children: MdNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (i > 0) {
      children.push({ type: "softbreak", tag: "", attrs: {}, children: [], content: "", info: "" });
    }
    if (line) children.push(textNode(line));
  }
  let hasText = false;
  for (const child of children) {
    if (child.type === "text") {
      hasText = true;
      break;
    }
  }
  if (!hasText) return null;
  return { type: "paragraph", tag: "p", attrs: {}, children, content: "", info: "" };
}

/** One split of a source string on complete table blocks: prose runs and parsed
 *  table nodes, in order. Null when the string holds no table that parsed — the
 *  caller then keeps its original node rather than rebuilding it for nothing. A
 *  table fragment that fails to parse stays prose, so no words are dropped.
 *
 *  Both expansion paths below run through here: the plain one turns each prose
 *  run into a paragraph, the rich one folds it back among its sibling inlines. */
type TableSegment =
  | { kind: "prose"; text: string }
  | { kind: "table"; node: MdNode };

function splitOnTables(content: string): TableSegment[] | null {
  if (!hasCompleteTable(content)) return null;
  const out: TableSegment[] = [];
  let sawTable = false;
  for (const part of content.split(TABLE_BLOCK)) {
    if (!part) continue;
    if (/^<table\b/i.test(part)) {
      const node = tableHtmlToNode(part);
      if (node) {
        out.push({ kind: "table", node });
        sawTable = true;
        continue;
      }
    }
    out.push({ kind: "prose", text: part });
  }
  return sawTable ? out : null;
}

/** Mixed prose/table source as block siblings — each prose run a paragraph. */
function splitMixed(content: string): MdNode[] | null {
  const segments = splitOnTables(content);
  if (!segments) return null;
  const out: MdNode[] = [];
  for (const segment of segments) {
    if (segment.kind === "table") {
      out.push(segment.node);
      continue;
    }
    const para = textToParagraph(segment.text);
    if (para) out.push(para);
  }
  return out.length > 0 ? out : null;
}

function isPlainInline(nodeType: string): boolean {
  return (
    nodeType === "text" ||
    nodeType === "softbreak" ||
    nodeType === "hardbreak" ||
    nodeType === "html_inline"
  );
}

/** A paragraph whose text carries table markup becomes prose/table siblings —
 *  a table can never stay an inline child, so the paragraph splits around it. */
function expandParagraph(node: MdNode): MdNode[] {
  let hasMarker = false;
  for (const child of node.children) {
    if (
      (child.type === "text" || child.type === "html_inline") &&
      TABLE_OPEN.test(child.content)
    ) {
      hasMarker = true;
      break;
    }
  }
  if (!hasMarker) return [node];
  let allPlain = true;
  for (const child of node.children) {
    if (!isPlainInline(child.type)) {
      allPlain = false;
      break;
    }
  }
  if (allPlain) {
    // A multiline table arrives with its line breaks as softbreak children, so
    // rejoin on newlines before splitting — no single child holds the table.
    let combined = "";
    for (const child of node.children) {
      combined += child.type === "softbreak" || child.type === "hardbreak" ? "\n" : child.content;
    }
    const split = splitMixed(combined);
    return split ?? [node];
  }
  // Rich inlines beside the table (emphasis, links): split each text run that
  // carries a complete table, keeping the rich nodes in their prose runs.
  const out: MdNode[] = [];
  let run: MdNode[] = [];
  let sawTable = false;
  const flush = (): void => {
    if (run.length > 0) {
      out.push({ type: "paragraph", tag: "p", attrs: {}, children: run, content: "", info: "" });
      run = [];
    }
  };
  for (const child of node.children) {
    const segments =
      child.type === "text" || child.type === "html_inline"
        ? splitOnTables(child.content)
        : null;
    if (!segments) {
      run.push(child);
      continue;
    }
    for (const segment of segments) {
      if (segment.kind === "table") {
        flush();
        out.push(segment.node);
        sawTable = true;
        continue;
      }
      run.push(textNode(segment.text));
    }
  }
  if (!sawTable) return [node];
  flush();
  return out;
}

function expandRawHtml(content: string): MdNode[] | null {
  return splitMixed(content);
}

/** Walk a parsed reply and lift raw table markup into real table nodes. Blocks
 *  without table markup — including a partial table still streaming in — pass
 *  through untouched and keep rendering as inert text. */
export function expandHtmlTables(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const node of nodes) {
    if (node.type === "paragraph") {
      const expanded = expandParagraph(node);
      for (const item of expanded) out.push(item);
      continue;
    }
    if (node.type === "html_block" || node.type === "html_inline" || node.type === "text") {
      const expanded = expandRawHtml(node.content);
      if (expanded) {
        for (const item of expanded) out.push(item);
        continue;
      }
      out.push(node);
      continue;
    }
    if (node.children.length > 0) {
      const children = expandHtmlTables(node.children);
      out.push({ ...node, children });
      continue;
    }
    out.push(node);
  }
  return out;
}
