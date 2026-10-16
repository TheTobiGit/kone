// Media written as raw HTML — read without ever touching v-html.
//
// A README's `<p align="center"><img …>` arrives as `html_block`/`html_inline`
// tokens (the thread's parser tokenizes HTML before the inline transforms run,
// so nothing here has to undo linkify or typographer). READMEs lean on a small
// vocabulary of HTML for their media — a centred hero logo, a `width="200"`
// screenshot, a `<picture>` fallback, a row of badge images wrapped in links, a
// `<br>` between them — and these helpers fold that vocabulary into the same
// node shape markdown-it's own tokens produce, so the existing renderer draws
// it: images settle into the framed figure, links wear their favicon, a centred
// block centres.
//
// Safety comes from construction, not from filtering rendered markup. The
// parser only ever emits nodes this renderer already knows how to build — text,
// image, link, br, strong/em/code and aligned paragraphs/headings — and only
// ever copies four attributes (src, alt, width on an image; href on a link).
// An image src still faces `classifyImageSource`'s scheme check; a link href is
// put through the same normalizeLink/validateLink pair markdown-it trusts for
// its own links. Nothing here sets HTML, so no string can carry a script, and
// tags outside the vocabulary are unwrapped (their text kept, the tag dropped).
//
// The parse is pure string work (no DOMParser), so it runs in the renderer and
// under `bun test` alike.

import { decodeEntities, type MdNode } from "./safeHtmlTable";

/** Tags that never wrap content. */
const VOID_TAGS = new Set([
  "img", "br", "hr", "source", "wbr", "input", "area", "base", "col", "embed",
  "link", "meta", "param", "track",
]);

/** Tags that hold block content — recursed into, not run together as inlines. */
const BLOCK_TAGS = new Set([
  "div", "center", "section", "figure", "figcaption", "p", "blockquote",
  "header", "footer", "article", "main", "aside", "nav", "details", "summary",
]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** The only signal that a text run is worth parsing at all. */
const MEDIA_MARK = /<(?:img|picture)\b/i;

/** Block tags whose markup we own when a run *opens* with one — a README hero,
 *  a badge row, a `<details>` summary. `table` is deliberately absent: tables
 *  keep their own path, and `script`/`style`/`iframe` never render, so a run
 *  opening with them is left as inert text. */
const BLOCK_OPEN_TAGS = new Set([
  "div", "p", "center", "section", "figure", "figcaption", "header", "footer",
  "article", "main", "aside", "nav", "blockquote", "details", "summary",
  "img", "picture", "a", "br", "h1", "h2", "h3", "h4", "h5", "h6",
]);

const OPEN_TAG = /^<([a-zA-Z][a-zA-Z0-9-]*)\b/;
const CLOSE_ONLY = /^(?:<\/[a-zA-Z][a-zA-Z0-9-]*\s*>\s*)+$/;

/** The URL half of a MarkdownIt instance: the canonical normalize/validate
 *  pair markdown-it runs over its own link destinations. */
export interface LinkRules {
  normalizeLink(url: string): string;
  validateLink(url: string): boolean;
}

/** An entity-decoded `href`, in and a href safe to emit out (null drops the
 *  anchor). Feeding the value through `normalizeLink` first is what makes this
 *  canonical rather than a scheme blacklist: it percent-encodes control
 *  characters, so a `java&#x09;script:` attribute — a real tab once decoded the
 *  way a browser decodes it — becomes the inert `java%09script:` a browser
 *  treats as a relative path, while `javascript:` and its entity spellings are
 *  refused by `validateLink`. */
export type LinkSanitizer = (href: string) => string | null;

export function createLinkSanitizer(md: LinkRules): LinkSanitizer {
  return (href) => {
    const normalized = md.normalizeLink(href);
    return md.validateLink(normalized) ? normalized : null;
  };
}

/** The parsed fragment. A tag and a text run are distinct things, so they are
 *  distinct cases — never a bare string that has to be told apart by shape. */
type HtmlText = { kind: "text"; text: string };
type HtmlTag = { kind: "tag"; tag: string; attrs: Record<string, string>; children: HtmlNode[] };
type HtmlNode = HtmlText | HtmlTag;

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+)))?/g;

function textNode(content: string): MdNode {
  return { type: "text", tag: "", attrs: {}, children: [], content, info: "" };
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = ATTR_RE.exec(raw)) !== null; ) {
    const name = m[1]?.toLowerCase();
    if (name === undefined) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (attrs[name] === undefined) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Fold the tag stream into a shallow tree. A closing tag pops back to its
 *  match; a stray one is ignored, and anything left open closes at the end. */
function buildTree(html: string): HtmlNode[] {
  const roots: HtmlNode[] = [];
  const stack: { node: HtmlTag; parent: HtmlNode[] }[] = [];
  const top = (): HtmlNode[] => stack[stack.length - 1]?.parent ?? roots;

  TAG_RE.lastIndex = 0;
  let cursor = 0;
  for (let m: RegExpExecArray | null; (m = TAG_RE.exec(html)) !== null; ) {
    const before = html.slice(cursor, m.index);
    if (before) top().push({ kind: "text", text: decodeEntities(before) });
    cursor = m.index + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.node.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: HtmlTag = { kind: "tag", tag, attrs: parseAttrs(m[3] ?? ""), children: [] };
    top().push(node);
    if (!VOID_TAGS.has(tag) && m[4] !== "/") stack.push({ node, parent: node.children });
  }
  const trailing = html.slice(cursor);
  if (trailing) top().push({ kind: "text", text: decodeEntities(trailing) });
  return roots;
}

/** A numeric pixel width, or null. `200`, `200px` and `200.5px` qualify. */
function pixelWidth(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const m = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(raw.trim());
  return m ? m[1]! : null;
}

function imageNode(src: string, alt: string, width: string | null): MdNode {
  const attrs: Record<string, string> = { src };
  if (width) attrs.width = width;
  if (alt) attrs.alt = alt;
  return { type: "image", tag: "img", attrs, children: [], content: alt, info: "" };
}

/** A `<picture>`'s image: the inner `<img>` first, else the first `<source>`
 *  srcset URL. Null when it carries no src at all. */
function pictureImage(node: HtmlTag): MdNode | null {
  const queue: HtmlNode[] = [...node.children];
  let source: HtmlTag | null = null;
  while (queue.length > 0) {
    const child = queue.shift()!;
    if (child.kind === "text") continue;
    if (child.tag === "img" && child.attrs.src) {
      return imageNode(child.attrs.src, child.attrs.alt ?? "", pixelWidth(child.attrs.width));
    }
    if (child.tag === "source" && source === null) source = child;
    queue.push(...child.children);
  }
  const srcset = source?.attrs.srcset ?? source?.attrs["data-srcset"];
  const first = srcset?.split(",")[0]?.trim().split(/\s+/)[0];
  return first ? imageNode(first, "", null) : null;
}

/** The node a single tag becomes, or null when it carries no media of its own
 *  (the caller then unwraps it). */
function mediaNode(node: HtmlTag): MdNode | null {
  if (node.tag === "img") {
    return node.attrs.src ? imageNode(node.attrs.src, node.attrs.alt ?? "", pixelWidth(node.attrs.width)) : null;
  }
  if (node.tag === "picture") return pictureImage(node);
  return null;
}

/** Every text character under a node, tags ignored. */
function plainText(node: HtmlNode): string {
  if (node.kind === "text") return node.text;
  let out = "";
  for (const child of node.children) out += plainText(child);
  return out.trim();
}

/** The parse/expand entry points, bound to one link policy. */
export interface HtmlMedia {
  parseMediaFragment(html: string, mode: "block" | "inline"): MdNode[] | null;
  parseHtmlBlock(raw: string): MdNode[] | null;
  expandHtmlMedia(nodes: MdNode[]): MdNode[];
}

export function createHtmlMedia(link: LinkSanitizer): HtmlMedia {
  /** Inline HTML → inline nodes. Anchors keep a href the sanitizer accepts,
   *  emphasis/code keep their meaning, and everything else is unwrapped. */
  function convertInline(child: HtmlNode): MdNode[] {
    if (child.kind === "text") return child.text ? [textNode(child.text)] : [];
    const media = mediaNode(child);
    if (media) return [media];
    const tag = child.tag;
    if (tag === "br") return [{ type: "hardbreak", tag: "br", attrs: {}, children: [], content: "", info: "" }];
    if (tag === "a") {
      const raw = child.attrs.href?.trim();
      const href = raw ? link(raw) : null;
      if (href === null) return convertInlineList(child.children);
      const children = convertInlineList(child.children);
      if (children.length === 0) return [];
      return [{ type: "link", tag: "a", attrs: { href }, children, content: "", info: "" }];
    }
    if (tag === "strong" || tag === "b") return [wrap("strong", child)];
    if (tag === "em" || tag === "i") return [wrap("em", child)];
    if (tag === "code" || tag === "kbd" || tag === "samp") {
      const text = plainText(child);
      return text ? [{ type: "code_inline", tag: "code", attrs: {}, children: [], content: text, info: "" }] : [];
    }
    return convertInlineList(child.children);
  }

  function convertInlineList(children: HtmlNode[]): MdNode[] {
    const out: MdNode[] = [];
    for (const child of children) out.push(...convertInline(child));
    return out;
  }

  function wrap(tag: string, node: HtmlTag): MdNode {
    return { type: tag, tag, attrs: {}, children: convertInlineList(node.children), content: "", info: "" };
  }

  /** The alignment a container imposes: its own `align="center"`, `<center>`, or
   *  whatever it inherited from an enclosing centred block. */
  function alignOf(node: HtmlTag, inherited: string | null): string | null {
    if ((node.attrs.align ?? "").toLowerCase() === "center" || node.tag === "center") return "center";
    return inherited;
  }

  function paragraph(children: MdNode[], align: string | null): MdNode {
    const attrs: Record<string, string> = align ? { align } : {};
    return { type: "paragraph", tag: "p", attrs, children, content: "", info: "" };
  }

  function convertBlock(child: HtmlTag, inherited: string | null): MdNode[] {
    const align = alignOf(child, inherited);
    if (HEADINGS.has(child.tag)) {
      const attrs: Record<string, string> = {};
      if (align) attrs.align = align;
      return [{ type: "heading", tag: child.tag, attrs, children: convertInlineList(child.children), content: "", info: "" }];
    }
    if (child.tag === "p" || child.tag === "figcaption") {
      const children = convertInlineList(child.children);
      return children.length > 0 ? [paragraph(children, align)] : [];
    }
    return convertBlocks(child.children, align);
  }

  /** Block HTML → block nodes. Consecutive inline content (text, images, <br>)
   *  gathers into one aligned paragraph; block containers recurse. */
  function convertBlocks(children: HtmlNode[], inherited: string | null): MdNode[] {
    const out: MdNode[] = [];
    let run: MdNode[] = [];
    const flush = (): void => {
      let hasMedia = false;
      let hasText = false;
      for (const n of run) {
        if (n.type === "image") hasMedia = true;
        else if (n.type === "text" && n.content.trim()) hasText = true;
        else if (n.type !== "text") hasText = true;
      }
      if (hasMedia || hasText) out.push(paragraph(run, inherited));
      run = [];
    };
    for (const child of children) {
      if (child.kind === "text") {
        if (child.text) run.push(textNode(child.text));
        continue;
      }
      const tag = child.tag;
      if (BLOCK_TAGS.has(tag) || HEADINGS.has(tag)) {
        flush();
        out.push(...convertBlock(child, inherited));
        continue;
      }
      const media = mediaNode(child);
      if (media) {
        run.push(media);
        continue;
      }
      if (tag === "br") {
        run.push({ type: "hardbreak", tag: "br", attrs: {}, children: [], content: "", info: "" });
        continue;
      }
      for (const item of convertInline(child)) run.push(item);
    }
    flush();
    return out;
  }

  function hasMedia(nodes: MdNode[]): boolean {
    for (const node of nodes) {
      if (node.type === "image") return true;
      if (node.children.length > 0 && hasMedia(node.children)) return true;
    }
    return false;
  }

  /** Read a raw-HTML fragment that carries media into nodes, or null when it
   *  holds none (the caller then keeps its source as inert text). `inline` keeps
   *  the fragment at inline level — an image inside a running sentence — where
   *  `block` gathers it into aligned paragraphs and headings. */
  function parseMediaFragment(html: string, mode: "block" | "inline"): MdNode[] | null {
    if (!MEDIA_MARK.test(html)) return null;
    const roots = buildTree(html);
    const nodes = mode === "inline" ? convertInlineList(roots) : convertBlocks(roots, null);
    return nodes.length > 0 && hasMedia(nodes) ? nodes : null;
  }

  /** Read a raw-HTML *block* — a run whose own source opens with a tag we render
   *  — into nodes. Null when the run doesn't open with a tag we own; an empty
   *  list when it is nothing but closing tags, so a stray `</div>` renders as
   *  nothing rather than as text. */
  function parseHtmlBlock(raw: string): MdNode[] | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("<")) return null;
    if (CLOSE_ONLY.test(trimmed)) return [];
    const tag = OPEN_TAG.exec(trimmed)?.[1]?.toLowerCase();
    if (tag === undefined || !BLOCK_OPEN_TAGS.has(tag)) return null;
    const nodes = convertBlocks(buildTree(raw), null);
    return nodes.length > 0 ? nodes : null;
  }

  /** Replace each run of consecutive `html_inline` siblings with the media
   *  nodes it spells, leaving every other inline (text, emphasis, code) exactly
   *  as parsed. A run is the only place nesting survives: `<a …>` and `<img>`
   *  are separate tokens, so they are rejoined here — and only here, never a
   *  run of ordinary text. A run that spells no media is left as the tokens it
   *  was, so unknown tags render inert. */
  function spliceHtmlRuns(children: MdNode[]): MdNode[] {
    let changed = false;
    const out: MdNode[] = [];
    let run: MdNode[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const parsed = parseMediaFragment(
        run.map((r) => r.content).join(""),
        "inline",
      );
      if (parsed) {
        out.push(...parsed);
        changed = true;
      } else {
        out.push(...run);
      }
      run = [];
    };
    for (const child of children) {
      if (child.type === "html_inline") {
        run.push(child);
        continue;
      }
      flush();
      out.push(child);
    }
    flush();
    return changed ? out : children;
  }

  /** Walk a reply and lift its raw HTML tokens into real nodes. Only tokens the
   *  parser marked as HTML are read: an `html_block` is rebuilt whole, and an
   *  `html_inline` run inside an inline container is spliced in place. Ordinary
   *  text is passed through untouched — escaped markup (`&lt;img …&gt;`) is a
   *  text node and must stay literal, not be reparsed as a tag. */
  function expandHtmlMedia(nodes: MdNode[]): MdNode[] {
    let changed = false;
    const out: MdNode[] = [];
    for (const node of nodes) {
      if (node.type === "html_block") {
        const parsed = parseHtmlBlock(node.content) ?? parseMediaFragment(node.content, "block");
        if (parsed) {
          for (const item of parsed) out.push(item);
          changed = true;
          continue;
        }
        out.push(node);
        continue;
      }
      if (node.type === "html_inline") {
        const parsed = parseMediaFragment(node.content, "inline");
        if (parsed) {
          for (const item of parsed) out.push(item);
          changed = true;
          continue;
        }
        out.push(node);
        continue;
      }
      if (node.children.length > 0) {
        const spliced = spliceHtmlRuns(node.children);
        const expanded = expandHtmlMedia(spliced);
        if (spliced === node.children && expanded === spliced) {
          out.push(node);
        } else {
          out.push({ ...node, children: expanded });
          changed = true;
        }
        continue;
      }
      out.push(node);
    }
    return changed ? out : nodes;
  }

  return { parseMediaFragment, parseHtmlBlock, expandHtmlMedia };
}

/** True when a link's only visible content is media — an image wrapped in an
 *  anchor is a clickable picture, not a link with a favicon in front of it. */
export function isMediaOnlyLink(node: MdNode): boolean {
  let seenImage = false;
  for (const child of node.children) {
    if (child.type === "image") {
      seenImage = true;
      continue;
    }
    if (child.type === "text" && child.content.trim() === "") continue;
    return false;
  }
  return seenImage;
}
