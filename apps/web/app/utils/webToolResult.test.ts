import { describe, expect, test } from "bun:test";
import { formatBytes, parseWebPage, parseWebSearchHits, webKey } from "./webToolResult";

describe("parseWebSearchHits", () => {
  test("reads Claude's Links arrays across rounds, each page once", () => {
    const detail = [
      'Web search results for query: "vue streaming"',
      "",
      'Links: [{"title":"Streaming in Vue","url":"https://vuejs.org/guide/streaming"},{"title":"A post","url":"https://blog.dev/post"}]',
      "",
      'Links: [{"title":"Streaming again","url":"https://www.vuejs.org/guide/streaming/"}]',
      "",
      "A summary of what was found.",
    ].join("\n");
    expect(parseWebSearchHits(detail)).toEqual([
      { title: "Streaming in Vue", url: "https://vuejs.org/guide/streaming", host: "vuejs.org" },
      { title: "A post", url: "https://blog.dev/post", host: "blog.dev" },
    ]);
  });

  test("falls back to markdown links, then bare URLs", () => {
    expect(parseWebSearchHits("1. [Docs](https://docs.rs/x) and more")).toEqual([
      { title: "Docs", url: "https://docs.rs/x", host: "docs.rs" },
    ]);
    expect(parseWebSearchHits("see https://example.com/a, then")).toEqual([
      { title: "example.com", url: "https://example.com/a", host: "example.com" },
    ]);
  });

  test("keeps balanced parentheses in a bare URL", () => {
    expect(parseWebSearchHits("(see https://en.wikipedia.org/wiki/Vue_(framework))")).toEqual([
      { title: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Vue_(framework)", host: "en.wikipedia.org" },
    ]);
  });

  test("keeps balanced parentheses in a markdown link", () => {
    expect(parseWebSearchHits("[Vue](https://en.wikipedia.org/wiki/Vue_(framework)).")).toEqual([
      { title: "Vue", url: "https://en.wikipedia.org/wiki/Vue_(framework)", host: "en.wikipedia.org" },
    ]);
  });

  test("reads nothing from an empty or link-free body", () => {
    expect(parseWebSearchHits(undefined)).toEqual([]);
    expect(parseWebSearchHits("No results.")).toEqual([]);
  });
});

describe("parseWebPage", () => {
  test("takes the heading and the first real paragraph", () => {
    const page = parseWebPage("# AI SDK 4.2\n\nShort.\n\nThe **smoothStream** transform chunks text by word so a stream reads evenly.");
    expect(page?.title).toBe("AI SDK 4.2");
    expect(page?.excerpt).toBe("The smoothStream transform chunks text by word so a stream reads evenly.");
  });

  test("works without a heading", () => {
    expect(parseWebPage("Just one paragraph of text that is long enough to count.")?.title).toBe("");
  });

  test("returns null for an empty body", () => {
    expect(parseWebPage("  ")).toBeNull();
  });
});

describe("webKey", () => {
  test("spells one page one way", () => {
    expect(webKey("https://www.Vercel.com/blog/ai-sdk/")).toBe("vercel.com/blog/ai-sdk");
    expect(webKey("vercel.com/blog/ai-sdk#top")).toBe("vercel.com/blog/ai-sdk");
    expect(webKey("https://example.com:8443/a")).toBe("example.com:8443/a");
    expect(webKey("https://example.com:443/a")).toBe("example.com/a");
  });
});

describe("formatBytes", () => {
  test("reads like a size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2150)).toBe("2.1 KB");
    expect(formatBytes(40_000)).toBe("39 KB");
  });
});
