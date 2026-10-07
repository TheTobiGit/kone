import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import {
  clampPageHeight,
  formatPageShown,
  injectPageBootstrap,
  PAGE_MAX_HEIGHT,
  PAGE_MIN_HEIGHT,
  pageThemeFragment,
  pageThemeMessage,
  PageFrameMessageSchema,
  parsePageShown,
} from "./pageRender";

const page = { attachmentId: "att_0f3c-11aa", title: "Latency by region", height: 420 };

describe("the shown-page record", () => {
  test("round-trips through the result text", () => {
    expect(parsePageShown(formatPageShown(page))).toEqual(page);
  });

  test("tells the model not to restate the page", () => {
    expect(JSON.parse(formatPageShown(page)).note).toContain("Don't announce");
  });

  test("reads nothing out of an error, a sentence or another tool's record", () => {
    expect(parsePageShown("invalid_input: No file at: /tmp/a.png.")).toBeNull();
    expect(parsePageShown(JSON.stringify({ to: "moss", from: null, summary: "Applied" }))).toBeNull();
    expect(parsePageShown(undefined)).toBeNull();
  });

  test("refuses an id that is not an attachment's", () => {
    const text = formatPageShown({ ...page, attachmentId: "../../etc/passwd" });
    expect(parsePageShown(text)).toBeNull();
  });

  test("clamps the height it reads", () => {
    expect(parsePageShown(formatPageShown({ ...page, height: 99_999 }))?.height).toBe(PAGE_MAX_HEIGHT);
    expect(clampPageHeight(3)).toBe(PAGE_MIN_HEIGHT);
    expect(clampPageHeight(Number.NaN)).toBe(PAGE_MIN_HEIGHT);
  });
});

describe("injectPageBootstrap", () => {
  const marker = '<style id="kone-page-theme">';

  test("goes straight after the head tag, ahead of the page's own scripts", () => {
    const html = "<!doctype html><html lang=en><head><script>window.x=1</script></head><body></body></html>";
    const out = injectPageBootstrap(html);
    expect(out.startsWith(`<!doctype html><html lang=en><head>${marker}`)).toBe(true);
    expect(out.indexOf(marker)).toBeLessThan(out.indexOf("window.x=1"));
  });

  test("goes first in a fragment with no head", () => {
    expect(injectPageBootstrap("<div>hi</div>").startsWith(marker)).toBe(true);
  });

  test("skips leading comments and a doctype without a head", () => {
    const out = injectPageBootstrap("<!-- chart --><!DOCTYPE html><body><p>x</p></body>");
    expect(out.startsWith(`<!-- chart --><!DOCTYPE html>${marker}`)).toBe(true);
  });

  test("leaves the page's own markup intact", () => {
    const html = "<head><title>t</title></head><body><p>x</p></body>";
    expect(injectPageBootstrap(html).replace(/<style id="kone-page-theme"><\/style><script>[\s\S]*?<\/script>/, "")).toBe(
      html,
    );
  });
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

describe("the frame's messages", () => {
  const read = (data: z.input<typeof PageFrameMessageSchema> | Record<string, JsonValue>) => {
    const parsed = PageFrameMessageSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  };

  test("an Escape the page left unhandled reaches the app", () => {
    expect(read({ jsonrpc: "2.0", method: "kone/escape-pressed" })).toEqual({ kind: "escape" });
  });

  test("a size report carries the height", () => {
    expect(read({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 312 } })).toEqual({
      kind: "size",
      height: 312,
    });
    expect(read({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: -1 } })).toBeNull();
    expect(read({ jsonrpc: "2.0", method: "ui/other", params: { height: 312 } })).toBeNull();
  });

  test("a link request opens only http(s)", () => {
    const ask = (url: string | number) => read({ jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url } });
    expect(ask("https://example.com/a")).toEqual({ kind: "link", url: "https://example.com/a" });
    expect(ask("javascript:alert(1)")).toEqual({ kind: "link", url: null });
    expect(ask("file:///etc/passwd")).toEqual({ kind: "link", url: null });
    expect(ask(42)).toBeNull();
  });

  test("a theme carries the chart series and drops what a stylesheet cannot hold", () => {
    const message = pageThemeMessage({
      appearance: "light",
      variables: { "--ink": "#111", "--accent": "red;}body{display:none", "bad name": "x" },
    });
    expect(message.params.theme).toBe("light");
    expect(message.params.styles.variables["--ink"]).toBe("#111");
    expect(message.params.styles.variables["--accent"]).toBe("redbodydisplay:none");
    expect(message.params.styles.variables["--chart-1"]).toBe("var(--accent)");
    expect("bad name" in message.params.styles.variables).toBe(false);
  });

  test("the first theme rides the address", () => {
    const fragment = pageThemeFragment({ appearance: "dark", variables: { "--ground": "#000" } });
    const decoded = JSON.parse(decodeURIComponent(fragment.slice("#kone-theme=".length)));
    expect(decoded.appearance).toBe("dark");
    expect(decoded.variables["--ground"]).toBe("#000");
  });
});
