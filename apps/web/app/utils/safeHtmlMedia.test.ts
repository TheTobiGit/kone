import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { configureMarkdown } from "../composables/useMarkdown";
import { createHtmlMedia, createLinkSanitizer, isMediaOnlyLink } from "./safeHtmlMedia";
import type { MdNode } from "./safeHtmlTable";

// The parser the thread builds its media through: markdown-it's own canonical
// link rules, configured exactly as production configures them.
const md = configureMarkdown(new MarkdownIt({ html: true, linkify: true, typographer: true }));
const { parseMediaFragment, parseHtmlBlock, expandHtmlMedia } = createHtmlMedia(createLinkSanitizer(md));

function text(content: string): MdNode {
  return { type: "text", tag: "", attrs: {}, children: [], content, info: "" };
}
function softbreak(): MdNode {
  return { type: "softbreak", tag: "br", attrs: {}, children: [], content: "", info: "" };
}
function paragraph(children: MdNode[]): MdNode {
  return { type: "paragraph", tag: "p", attrs: {}, children, content: "", info: "" };
}
function htmlBlock(content: string): MdNode {
  return { type: "html_block", tag: "", attrs: {}, children: [], content, info: "" };
}

/** With no browser involved, resolve an href the way one would and hand back
 *  the scheme it would navigate with. */
function browserProtocol(href: string): string {
  return new URL(href, "https://example.test/").protocol;
}

describe("parseMediaFragment", () => {
  test("a centred hero becomes one centred paragraph holding the image", () => {
    const nodes = parseMediaFragment(
      '<p align="center"><img src="docs/shot.png" alt="Shot" width="200"></p>',
      "block",
    );
    expect(nodes).toHaveLength(1);
    const p = nodes![0]!;
    expect(p.type).toBe("paragraph");
    expect(p.attrs.align).toBe("center");
    expect(p.children).toHaveLength(1);
    const img = p.children[0]!;
    expect(img.type).toBe("image");
    expect(img.attrs.src).toBe("docs/shot.png");
    expect(img.attrs.width).toBe("200");
    expect(img.content).toBe("Shot");
  });

  test("a picture settles on its inner img", () => {
    const nodes = parseMediaFragment(
      '<picture><source srcset="x.webp" type="image/webp"><img src="x.png" alt="X"></picture>',
      "inline",
    );
    expect(nodes![0]!.attrs.src).toBe("x.png");
  });

  test("a picture with only a source srcset uses its first URL", () => {
    const nodes = parseMediaFragment('<picture><source srcset="a.png 1x, b.png 2x"></picture>', "inline");
    expect(nodes![0]!.attrs.src).toBe("a.png");
  });

  test("a badge row keeps the anchor and marks the link media-only", () => {
    const nodes = parseMediaFragment(
      '<p align="center"><a href="https://ci.example/x"><img src="https://img.example/b.svg" alt="CI"></a></p>',
      "block",
    );
    const p = nodes![0]!;
    expect(p.attrs.align).toBe("center");
    const link = p.children[0]!;
    expect(link.type).toBe("link");
    expect(link.attrs.href).toBe("https://ci.example/x");
    expect(link.children[0]!.type).toBe("image");
    expect(isMediaOnlyLink(link)).toBe(true);
  });

  test("a plain script URL drops the anchor but keeps the image", () => {
    const nodes = parseMediaFragment('<a href="javascript:alert(1)"><img src="a.png"></a>', "inline");
    expect(nodes).toHaveLength(1);
    expect(nodes![0]!.type).toBe("image");
  });

  test("an entity-spelled script URL decodes before it is judged, and is refused", () => {
    // `jav&#x61;script:` is `javascript:` once a browser decodes the attribute.
    const nodes = parseMediaFragment('<a href="jav&#x61;script:alert(1)"><img src="a.png"></a>', "inline");
    expect(nodes).toHaveLength(1);
    expect(nodes![0]!.type).toBe("image");
  });

  test("a tab hidden in a scheme entity makes an inert href, never javascript", () => {
    const nodes = parseMediaFragment('<a href="java&#x09;script:alert(1)"><img src="x.png"></a>', "inline");
    const link = nodes!.find((n) => n.type === "link");
    expect(link).toBeDefined();
    expect(link!.attrs.href).not.toMatch(/[\t\n\r]/);
    expect(browserProtocol(link!.attrs.href ?? "")).not.toBe("javascript:");
  });

  test("a raw newline in the scheme is normalized away too", () => {
    const nodes = parseMediaFragment('<a href="java\nscript:alert(1)"><img src="x.png"></a>', "inline");
    const link = nodes!.find((n) => n.type === "link");
    expect(link).toBeDefined();
    expect(link!.attrs.href).not.toMatch(/[\t\n\r]/);
    expect(browserProtocol(link!.attrs.href ?? "")).not.toBe("javascript:");
  });

  test("a named whitespace entity cannot smuggle a live scheme", () => {
    // `&Tab;` is left as written (the decoder keeps its five XML names), which
    // the browser also never decodes in a JS-set attribute — so it stays inert.
    const nodes = parseMediaFragment('<a href="java&Tab;script:alert(1)"><img src="x.png"></a>', "inline");
    const link = nodes!.find((n) => n.type === "link");
    expect(link).toBeDefined();
    expect(browserProtocol(link!.attrs.href ?? "")).not.toBe("javascript:");
  });

  test("a data:text/html href is refused, a data image is kept", () => {
    const dropped = parseMediaFragment(
      '<a href="data:text/html,<script>alert(1)</script>"><img src="a.png"></a>',
      "inline",
    );
    expect(dropped![0]!.type).toBe("image");
    const kept = parseMediaFragment('<a href="data:image/png;base64,AAAA"><img src="a.png"></a>', "inline");
    expect(kept![0]!.type).toBe("link");
  });

  test("a file link survives so it can render as an inert chip", () => {
    const nodes = parseMediaFragment('<a href="file:///tmp/x.png"><img src="a.png"></a>', "inline");
    expect(nodes![0]!.type).toBe("link");
    expect(nodes![0]!.attrs.href).toBe("file:///tmp/x.png");
  });

  test("plain prose with no media parses to nothing", () => {
    expect(parseMediaFragment("just some words", "block")).toBeNull();
    expect(parseMediaFragment("<p>hello</p>", "block")).toBeNull();
  });

  test("text around a block image keeps its own paragraph", () => {
    const nodes = parseMediaFragment("Intro line\n<p align=\"center\"><img src=\"a.png\"></p>", "block");
    expect(nodes!.map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
    expect(nodes![0]!.attrs.align).toBeUndefined();
    expect(nodes![1]!.attrs.align).toBe("center");
  });
});

describe("parseHtmlBlock", () => {
  test("a README hero renders whole, links and all", () => {
    const hero = `<div align="center">
  <img src="./assets/logo.svg" width="112" alt="Logo">
  <h1>Synara</h1>
  <p><strong>Tagline.</strong><br>More words.</p>
  <p><a href="https://example.com/">Website</a></p>
</div>`;
    const nodes = parseHtmlBlock(hero);
    expect(nodes!.map((n) => n.type)).toEqual(["paragraph", "heading", "paragraph", "paragraph"]);
    expect(nodes![0]!.attrs.align).toBe("center");
    expect(nodes![0]!.children[1]!.type).toBe("image");
    expect(nodes![1]!.children[0]!.content).toBe("Synara");
    const link = nodes![3]!.children.find((c) => c.type === "link");
    expect(link!.attrs.href).toBe("https://example.com/");
  });

  test("a details block keeps its summary text and drops its tags", () => {
    const nodes = parseHtmlBlock("<details open>\n  <summary><strong>Table of contents</strong></summary>");
    expect(nodes).toHaveLength(1);
    expect(nodes![0]!.type).toBe("paragraph");
    expect(nodes![0]!.children[0]!.type).toBe("strong");
  });

  test("a run that is nothing but a closing tag renders as nothing", () => {
    expect(parseHtmlBlock("</div>")).toEqual([]);
    expect(parseHtmlBlock("</details>\n</div>")).toEqual([]);
  });

  test("a run that does not open with an owned tag is left alone", () => {
    expect(parseHtmlBlock("hello <img src=x>")).toBeNull();
    expect(parseHtmlBlock("<script>alert(1)</script>")).toBeNull();
    expect(parseHtmlBlock("<https://example.com>")).toBeNull();
    expect(parseHtmlBlock("< 5 things")).toBeNull();
  });
});

describe("expandHtmlMedia", () => {
  test("an html block with a heading is rebuilt with its alignment", () => {
    const node = htmlBlock('<div align="center"><h1>Hi</h1></div>');
    const out = expandHtmlMedia([node]);
    expect(out.map((n) => n.type)).toEqual(["heading"]);
    expect(out[0]!.attrs.align).toBe("center");
  });

  test("a centred raw block splits the media out into a centred paragraph", () => {
    const out = expandHtmlMedia([htmlBlock('<div align="center">\n<img src="logo.png">\n</div>')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("paragraph");
    expect(out[0]!.attrs.align).toBe("center");
  });

  test("a paragraph of pure prose is untouched", () => {
    const src = paragraph([text("Hello "), softbreak(), text("world")]);
    const out = expandHtmlMedia([src]);
    expect(out).toBeArray();
    expect(out[0]).toBe(src);
  });

  test("an inline image beside rich markdown swaps in place", () => {
    const strong: MdNode = { type: "strong", tag: "strong", attrs: {}, children: [text("bold")], content: "", info: "" };
    const html: MdNode = { type: "html_inline", tag: "", attrs: {}, children: [], content: '<img src="a.png">', info: "" };
    const src = paragraph([text("see "), strong, html]);
    const out = expandHtmlMedia([src]);
    const first = out[0]!;
    expect(first.children.some((n) => n.type === "image")).toBe(true);
    expect(first.children.some((n) => n.type === "strong")).toBe(true);
  });

  test("a multi-tag inline anchor and image recombine into one link", () => {
    const html = (content: string): MdNode => ({ type: "html_inline", tag: "", attrs: {}, children: [], content, info: "" });
    const src = paragraph([
      text("badges: "),
      html('<a href="https://ci.example/">'),
      html('<img src="b.svg" alt="CI">'),
      html("</a>"),
    ]);
    const out = expandHtmlMedia([src]);
    const link = out[0]!.children.find((n) => n.type === "link");
    expect(link).toBeDefined();
    expect(link!.attrs.href).toBe("https://ci.example/");
    expect(isMediaOnlyLink(link!)).toBe(true);
    expect(out[0]!.children.some((n) => n.type === "text" && n.content.includes("<a href"))).toBe(false);
  });

  test("a text child that merely looks like markup is never reparsed", () => {
    const src = paragraph([text('see <img src="a.png"> here')]);
    const out = expandHtmlMedia([src]);
    expect(out[0]).toBe(src);
    expect(out[0]!.children.every((n) => n.type !== "image")).toBe(true);
  });

  test("nested children are walked", () => {
    const item: MdNode = {
      type: "list_item",
      tag: "li",
      attrs: {},
      children: [htmlBlock('<p align="center"><img src="a.png"></p>')],
      content: "",
      info: "",
    };
    const list: MdNode = { type: "bullet_list", tag: "ul", attrs: {}, children: [item], content: "", info: "" };
    const out = expandHtmlMedia([list]);
    const inner = out[0]!.children[0]!.children[0]!;
    expect(inner.attrs.align).toBe("center");
  });

  test("non-media raw markup is left as inert tokens", () => {
    const src: MdNode = { type: "html_inline", tag: "", attrs: {}, children: [], content: "<span>", info: "" };
    const out = expandHtmlMedia([src]);
    expect(out[0]!.type).toBe("html_inline");
    expect(out[0]!.content).toBe("<span>");
  });
});
