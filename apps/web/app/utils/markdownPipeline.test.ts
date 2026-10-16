import { describe, expect, test } from "bun:test";
import { useMarkdown } from "../composables/useMarkdown";
import type { MdNode } from "./safeHtmlTable";
import { isMediaOnlyLink } from "./safeHtmlMedia";

async function pipeline(src: string): Promise<MdNode[]> {
  return (await useMarkdown().parseNodes(src)) ?? [];
}

function walk(nodes: MdNode[], visit: (node: MdNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

function links(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  walk(nodes, (node) => {
    if (node.type === "link") out.push(node);
  });
  return out;
}

function browserProtocol(href: string): string {
  return new URL(href, "https://example.test/").protocol;
}

describe("markdown message pipeline", () => {
  test("the HTML-string renderer escapes raw tags while conversation parsing supports media", async () => {
    const src = '<img src="x.png" onerror="alert(1)"><script>alert(2)</script>';
    const rendered = await useMarkdown().render(src);
    expect(rendered).toContain("&lt;img");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<script");
    const nodes = await pipeline(src);
    const images: MdNode[] = [];
    walk(nodes, (node) => {
      if (node.type === "image") images.push(node);
    });
    expect(images).toHaveLength(1);
    expect(images[0]!.attrs).toEqual({ src: "x.png" });
  });
  test("a README hero expands to centred media, heading and link", async () => {
    const hero = `<div align="center">
  <img src="./assets/logo.svg" width="112" alt="Logo">
  <h1>Synara</h1>
  <p><a href="https://example.com/">Website</a></p>
</div>`;
    const out = await pipeline(hero);
    expect(out.map((n) => n.type)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(out[0]!.attrs.align).toBe("center");
    expect(out[0]!.children.some((n) => n.type === "image")).toBe(true);
    expect(out[1]!.children[0]!.content).toBe("Synara");
    const link = links(out)[0]!;
    expect(link.attrs.href).toBe("https://example.com/");
  });

  test("a badge row keeps its clickable picture and marks it media-only", async () => {
    const out = await pipeline(
      '<p align="center"><a href="https://ci.example/x"><img src="https://img.example/b.svg" alt="CI"></a></p>',
    );
    const link = links(out)[0]!;
    expect(link).toBeDefined();
    expect(link.attrs.href).toBe("https://ci.example/x");
    expect(isMediaOnlyLink(link)).toBe(true);
  });

  test("an attribute's straight quotes survive the inline transforms", async () => {
    const out = await pipeline('intro <img src="a.png" alt="Quote"> outro');
    const image = out.flatMap((n) => n.children).find((n) => n.type === "image");
    expect(image).toBeDefined();
    expect(image!.attrs.src).toBe("a.png");
    expect(image!.attrs.alt).toBe("Quote");
  });

  test("escaped markup stays literal text", async () => {
    const out = await pipeline('intro &lt;img src="x.png"&gt; outro');
    let sawImage = false;
    walk(out, (node) => {
      if (node.type === "image") sawImage = true;
    });
    expect(sawImage).toBe(false);
    const texts: string[] = [];
    walk(out, (node) => {
      if (node.type === "text") texts.push(node.content);
    });
    expect(texts.join("")).toContain("<img src=");
  });

  test("markdown links and emphasis beside a raw media anchor keep their structure", async () => {
    const src =
      'See [docs](https://example.com) and **bold** then <a href="https://ci.example/x"><img src="b.svg" alt="CI"></a> end';
    const out = await pipeline(src);
    const found = links(out);
    expect(found.some((l) => l.attrs.href === "https://example.com")).toBe(true);
    const mediaLink = found.find((l) => l.attrs.href === "https://ci.example/x");
    expect(mediaLink).toBeDefined();
    expect(isMediaOnlyLink(mediaLink!)).toBe(true);
    let bold = false;
    walk(out, (node) => {
      if (node.type === "strong" && node.children.some((c) => c.content === "bold")) bold = true;
    });
    expect(bold).toBe(true);
  });

  test("a tab-hidden script scheme in a reply renders an inert link, not javascript", async () => {
    const out = await pipeline('Here <a href="java&#x09;script:alert(1)"><img src="x.png"></a> end');
    let sawImage = false;
    walk(out, (node) => {
      if (node.type === "image") sawImage = true;
    });
    expect(sawImage).toBe(true);
    const found = links(out);
    expect(found.length).toBe(1);
    expect(found[0]!.attrs.href).not.toMatch(/[\t\n\r]/);
    expect(browserProtocol(found[0]!.attrs.href ?? "")).not.toBe("javascript:");
  });

  test("an entity-spelled javascript reply drops the anchor", async () => {
    const out = await pipeline('Here <a href="jav&#x61;script:alert(1)"><img src="x.png"></a> end');
    expect(links(out)).toHaveLength(0);
    walk(out, (node) => {
      if (node.type === "image") expect(node.attrs.src).toBe("x.png");
    });
  });

  test("a raw HTML table still expands into a real table, no literal tags", async () => {
    const src = [
      "Here you go, all 16.",
      "",
      "<table><tr><th>Fixture</th><th>Home</th></tr><tr><td>A</td><td>B</td></tr></table>",
    ].join("\n");
    const out = await pipeline(src);
    expect(out.some((n) => n.type === "table")).toBe(true);
    const texts: string[] = [];
    walk(out, (node) => {
      if (node.type === "text") texts.push(node.content);
    });
    expect(texts).toContain("Fixture");
    expect(texts.some((t) => t.includes("<table>"))).toBe(false);
  });
});
