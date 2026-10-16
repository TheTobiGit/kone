import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import {
  clampVisualHeight,
  formatVisualShown,
  injectVisualBootstrap,
  isVisualShowToolName,
  placedVisualIds,
  splitVisualEmbeds,
  stripVisualEmbeds,
  VISUAL_UNAVAILABLE_HTML,
  visualEmbed,
  visualFrameHeight,
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
  visualThemeFragment,
  visualThemeMessage,
  VisualFrameMessageSchema,
  parseVisualShown,
} from "./visualRender";

const visual = { attachmentId: "att_0f3c-11aa", title: "Latency by region", height: 420 };

describe("the shown-visual record", () => {
  test("round-trips through the result text", () => {
    expect(parseVisualShown(formatVisualShown(visual))).toEqual(visual);
  });

  test("tells the model not to restate the visual", () => {
    expect(JSON.parse(formatVisualShown(visual)).note).toContain("Don't announce");
  });

  test("reads nothing out of an error, a sentence or another tool's record", () => {
    expect(parseVisualShown("invalid_input: No file at: /tmp/a.png.")).toBeNull();
    expect(parseVisualShown(JSON.stringify({ to: "moss", from: null, summary: "Applied" }))).toBeNull();
    expect(parseVisualShown(undefined)).toBeNull();
  });

  test("refuses an id that is not an attachment's", () => {
    const text = formatVisualShown({ ...visual, attachmentId: "../../etc/passwd" });
    expect(parseVisualShown(text)).toBeNull();
  });

  test("tells the model how to place the visual in its reply", () => {
    expect(JSON.parse(formatVisualShown(visual)).note).toContain(visualEmbed(visual.attachmentId));
  });

  test("reads a record written before visuals had their name", () => {
    const legacy = JSON.stringify({ page: visual, note: "Shown." });
    expect(parseVisualShown(legacy)).toEqual(visual);
    expect(isVisualShowToolName("page_show")).toBe(true);
    expect(isVisualShowToolName("visual_show")).toBe(true);
    expect(isVisualShowToolName("visual_preview")).toBe(false);
  });

  test("round-trips the heights measured when it was shown", () => {
    const measured = { ...visual, heights: [[400, 610], [680, 420], [1140, 300]] satisfies Array<[number, number]> };
    expect(parseVisualShown(formatVisualShown(measured))).toEqual(measured);
  });

  test("clamps the height it reads", () => {
    expect(parseVisualShown(formatVisualShown({ ...visual, height: 99_999 }))?.height).toBe(VISUAL_MAX_HEIGHT);
    expect(clampVisualHeight(3)).toBe(VISUAL_MIN_HEIGHT);
    expect(clampVisualHeight(Number.NaN)).toBe(VISUAL_MIN_HEIGHT);
  });
});

describe("visualFrameHeight", () => {
  const measured = { ...visual, heights: [[400, 610], [680, 420], [1140, 300]] satisfies Array<[number, number]> };

  test("a reported height wins over anything measured", () => {
    expect(visualFrameHeight(measured, 680, 512)).toBe(512);
    expect(visualFrameHeight(measured, 680, 1)).toBe(VISUAL_MIN_HEIGHT);
  });

  test("reserves the taller of the measured heights either side of the width", () => {
    expect(visualFrameHeight(measured, 680)).toBe(420);
    expect(visualFrameHeight(measured, 500)).toBe(610);
    expect(visualFrameHeight(measured, 900)).toBe(420);
    expect(visualFrameHeight(measured, 300)).toBe(610);
    expect(visualFrameHeight(measured, 1600)).toBe(300);
  });

  test("falls back to the height the agent gave", () => {
    expect(visualFrameHeight(visual, 680)).toBe(420);
  });
});

describe("placing a visual in the reply", () => {
  const id = "att_0f3c-11aa";
  const fence = visualEmbed(id);

  test("splits the reply around each placed visual", () => {
    expect(splitVisualEmbeds(`Before.\n\n${fence}\n\nAfter.`)).toEqual([
      { kind: "text", text: "Before.\n\n" },
      { kind: "visual", attachmentId: id },
      { kind: "text", text: "\nAfter." },
    ]);
    expect(placedVisualIds(`${fence}\ntext\n${visualEmbed("att_beef-01")}`)).toEqual([id, "att_beef-01"]);
  });

  test("leaves a fence that names no attachment as the code it is", () => {
    const text = "```kone-visual\nnot an id\n```";
    expect(splitVisualEmbeds(text)).toEqual([{ kind: "text", text }]);
  });

  test("holds back a placement still arriving", () => {
    expect(splitVisualEmbeds("Look:\n```kone-visual\natt_0f")).toEqual([{ kind: "text", text: "Look:" }]);
    expect(splitVisualEmbeds("Look:\n```kone-vi", { streaming: true })).toEqual([{ kind: "text", text: "Look:" }]);
    expect(splitVisualEmbeds("Look:\n```ts", { streaming: true })).toEqual([{ kind: "text", text: "Look:\n```ts" }]);
  });

  test("strips placements where no visual can be drawn", () => {
    expect(stripVisualEmbeds(`Before.\n\n${fence}\n\nAfter.`)).toBe("Before.\n\nAfter.");
    expect(stripVisualEmbeds("Plain.")).toBe("Plain.");
  });

  test("leaves an example nested in a longer fence as the code it is", () => {
    const text = `An example:\n\n\`\`\`\`markdown\n${fence}\n\`\`\`\`\n\nDone.`;
    expect(splitVisualEmbeds(text)).toEqual([{ kind: "text", text }]);
    expect(placedVisualIds(text)).toEqual([]);
    expect(stripVisualEmbeds(text)).toBe(text);
  });

  test("leaves an example a list item or blockquote opens as the code it is", () => {
    const listed = `- \`\`\`\`markdown\n  \`\`\`kone-visual\n  ${id}\n  \`\`\`\n  \`\`\`\``;
    const quoted = `> \`\`\`\`markdown\n> \`\`\`kone-visual\n> ${id}\n> \`\`\`\n> \`\`\`\``;
    expect(placedVisualIds(listed)).toEqual([]);
    expect(stripVisualEmbeds(listed)).toBe(listed);
    expect(placedVisualIds(quoted)).toEqual([]);
  });

  test("closes a list item's fence on its indented continuation, and reads on past it", () => {
    const text = `10. \`\`\`\`markdown\n    \`\`\`kone-visual\n    att_beef\n    \`\`\`\n    \`\`\`\`\n\n${visualEmbed("att_cafe")}`;
    expect(placedVisualIds(text)).toEqual(["att_cafe"]);
    expect(splitVisualEmbeds(text).some((part) => part.kind === "text" && part.text.includes("att_beef"))).toBe(true);
    expect(stripVisualEmbeds(text)).not.toContain("att_cafe");
  });

  test("a plain opener is not closed by a list or quote line inside its body", () => {
    const text = `\`\`\`markdown\n- \`\`\`\n> \`\`\`\n${fence}\n\`\`\``;
    expect(placedVisualIds(text)).toEqual([]);
    expect(splitVisualEmbeds(text)).toEqual([{ kind: "text", text }]);
  });

  test("closes only on the same fence character at least as long", () => {
    expect(placedVisualIds("~~~kone-visual\natt_beef-01\n~~~")).toEqual(["att_beef-01"]);
    expect(placedVisualIds("```kone-visual\natt_beef-01\n~~~")).toEqual([]);
    expect(placedVisualIds("````kone-visual\natt_beef-01\n```")).toEqual([]);
    expect(placedVisualIds("```kone-visual\natt_beef-01\n`````")).toEqual(["att_beef-01"]);
  });

  test("holds back a placement still arriving, and an opener that may yet become one", () => {
    expect(splitVisualEmbeds("Look:\n```kone-vi", { streaming: true })).toEqual([{ kind: "text", text: "Look:" }]);
    expect(splitVisualEmbeds("Look:\n```", { streaming: true })).toEqual([{ kind: "text", text: "Look:" }]);
    expect(splitVisualEmbeds("Look:\n```ts", { streaming: true })).toEqual([{ kind: "text", text: "Look:\n```ts" }]);
    // A partial opener inside an enclosing fence is code still arriving, not a
    // placement to hold back.
    expect(splitVisualEmbeds("Example:\n````markdown\n```kone-vi", { streaming: true })).toEqual([
      { kind: "text", text: "Example:\n````markdown\n```kone-vi" },
    ]);
  });
});

describe("injectVisualBootstrap", () => {
  const marker = '<style id="kone-visual-theme">';

  test("goes straight after the head tag, ahead of the visual's own scripts", () => {
    const html = "<!doctype html><html lang=en><head><script>window.x=1</script></head><body></body></html>";
    const out = injectVisualBootstrap(html);
    expect(out.startsWith(`<!doctype html><html lang=en><head>${marker}`)).toBe(true);
    expect(out.indexOf(marker)).toBeLessThan(out.indexOf("window.x=1"));
  });

  test("goes first in a fragment with no head", () => {
    expect(injectVisualBootstrap("<div>hi</div>").startsWith(marker)).toBe(true);
  });

  test("skips leading comments and a doctype without a head", () => {
    const out = injectVisualBootstrap("<!-- chart --><!DOCTYPE html><body><p>x</p></body>");
    expect(out.startsWith(`<!-- chart --><!DOCTYPE html>${marker}`)).toBe(true);
  });

  test("leaves the visual's own markup intact", () => {
    const html = "<head><title>t</title></head><body><p>x</p></body>";
    expect(injectVisualBootstrap(html).replace(/<style id="kone-visual-theme"><\/style><script>[\s\S]*?<\/script>/, "")).toBe(
      html,
    );
  });
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

describe("the frame's messages", () => {
  const read = (data: z.input<typeof VisualFrameMessageSchema> | Record<string, JsonValue>) => {
    const parsed = VisualFrameMessageSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  };

  test("an Escape the visual left unhandled reaches the app", () => {
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

  test("a chord the visual passed on carries its keys", () => {
    const press = { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(read({ jsonrpc: "2.0", method: "kone/key-pressed", params: press })).toEqual({ kind: "key", press });
  });

  test("an image opens only from the web or inlined data", () => {
    const ask = (src: string) => read({ jsonrpc: "2.0", method: "kone/open-image", params: { src, alt: " Chart " } });
    expect(ask("data:image/png;base64,AAAA")).toEqual({ kind: "image", src: "data:image/png;base64,AAAA", alt: "Chart" });
    expect(ask("https://example.com/a.png")).toEqual({ kind: "image", src: "https://example.com/a.png", alt: "Chart" });
    expect(ask("data:text/html,<script>")).toEqual({ kind: "image", src: null, alt: "Chart" });
  });

  test("the stand-in for a missing visual says it is gone", () => {
    expect(read({ jsonrpc: "2.0", method: "kone/visual-unavailable" })).toEqual({ kind: "unavailable" });
    expect(VISUAL_UNAVAILABLE_HTML).toContain('"kone/visual-unavailable"');
  });

  test("a link request opens only http(s)", () => {
    const ask = (url: string | number) => read({ jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url } });
    expect(ask("https://example.com/a")).toEqual({ kind: "link", url: "https://example.com/a" });
    expect(ask("javascript:alert(1)")).toEqual({ kind: "link", url: null });
    expect(ask("file:///etc/passwd")).toEqual({ kind: "link", url: null });
    expect(ask(42)).toBeNull();
  });

  test("a theme carries the chart series and drops what a stylesheet cannot hold", () => {
    const message = visualThemeMessage({
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
    const fragment = visualThemeFragment({ appearance: "dark", variables: { "--ground": "#000" } });
    const decoded = JSON.parse(decodeURIComponent(fragment.slice("#kone-theme=".length)));
    expect(decoded.appearance).toBe("dark");
    expect(decoded.variables["--ground"]).toBe("#000");
  });
});
