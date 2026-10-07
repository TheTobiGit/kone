import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parsePageShown } from "@kone/protocol/page-render";
import type { ChatAttachment, RuntimeEvent, UploadAttachmentInput } from "../../types.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import { createPageTools, type PagePreviewer } from "./page.js";

const ctx: GatewayToolContext = {
  threadId: "thread-1",
  turnId: "turn-1",
  provider: "claudeAgent",
  cwd: "/tmp/proj",
  requestId: 1,
};

// One transparent pixel.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let dir: string;
let shot: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kone-page-"));
  shot = path.join(dir, "shot.png");
  await writeFile(shot, PNG);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(preview?: PagePreviewer) {
  const saved: UploadAttachmentInput[] = [];
  const saveAttachment = async (input: UploadAttachmentInput): Promise<ChatAttachment> => {
    saved.push(input);
    return { type: "file", id: "att_0001-aaaa", name: input.name, mimeType: input.mimeType, sizeBytes: 1 };
  };
  const emitted: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent): void => void emitted.push(event);
  const registry = createRegistry(createPageTools(preview ? { saveAttachment, emit, preview } : { saveAttachment, emit }));
  return {
    saved,
    emitted,
    call: (name: string, args: Record<string, string | number>) => registry.call(ctx, name, args),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

describe("page_show", () => {
  test("stores the page in the caller's thread and answers with the record the renderer reads", async () => {
    const { saved, call } = setup();
    const result = await call("page_show", { html: "<p>hi</p>", title: "Latency: by region", height: 5000 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.threadId).toBe("thread-1");
    expect(saved[0]!.mimeType).toBe("text/html");
    expect(saved[0]!.name).toBe("Latency by region.html");
    expect(Buffer.from(saved[0]!.data, "base64").toString("utf8")).toBe("<p>hi</p>");
    expect(parsePageShown(textOf(result))).toEqual({
      attachmentId: "att_0001-aaaa",
      title: "Latency: by region",
      height: 2000,
    });
  });

  test("puts the page in the calling turn itself, whatever the provider reports of the call", async () => {
    const { emitted, call } = setup();
    const result = await call("page_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    if (event.type !== "item.completed") throw new Error(`expected item.completed, got ${event.type}`);
    expect(event.threadId).toBe("thread-1");
    expect(event.turnId).toBe("turn-1");
    expect(event.item).toEqual({
      itemId: "page:att_0001-aaaa",
      kind: "tool_call",
      status: "completed",
      name: "page_show",
      text: "Chart",
      detail: textOf(result),
    });
  });

  test("embeds local images named by path, wherever the page names them", async () => {
    const { saved, call } = setup();
    const html = `<img src="${shot}"><div style="background:url(${shot})"></div><script>const s='${shot}'</script>`;
    await call("page_show", { html, title: "Shots", height: 300 });
    const stored = Buffer.from(saved[0]!.data, "base64").toString("utf8");
    expect(stored).not.toContain(shot);
    expect(stored.match(/data:image\/png;base64,/g)).toHaveLength(3);
  });

  test("leaves URLs and relative paths alone", async () => {
    const { saved, call } = setup();
    const html = `<img src="https://example.com/a.png"><img src="//cdn.example.com/b.png"><img src="c.png">`;
    await call("page_show", { html, title: "Remote", height: 300 });
    expect(Buffer.from(saved[0]!.data, "base64").toString("utf8")).toBe(html);
  });

  test("refuses a page naming an image that is not there, and stores nothing", async () => {
    const { saved, emitted, call } = setup();
    const result = await call("page_show", { html: `<img src="${dir}/gone.png">`, title: "Gone", height: 300 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${dir}/gone.png`);
    expect(saved).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  test("counts every place an image is named against the page's size, before building it", async () => {
    const big = path.join(dir, "big.png");
    await writeFile(big, Buffer.alloc(1024 * 1024, 1));
    const html = Array.from({ length: 20 }, () => `<img src="${big}">`).join("");
    const { saved, call } = setup();
    const result = await call("page_show", { html, title: "Many", height: 300 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("name each one once");
    expect(saved).toHaveLength(0);
  });
});

describe("page_preview", () => {
  test("hands back the screenshot as an image, and the measurements and console as text", async () => {
    let asked: Parameters<PagePreviewer>[0] | null = null;
    const { call } = setup(async (input) => {
      asked = input;
      return {
        png: "cG5n",
        width: input.width,
        appearance: "dark",
        contentHeight: 2400,
        capturedHeight: 2000,
        consoleMessages: [{ level: "error", text: "Uncaught ReferenceError: Chart is not defined" }],
      };
    });
    const result = await call("page_preview", { html: `<img src="${shot}">` });
    expect(asked!.width).toBe(680);
    expect(asked!.appearance).toBeUndefined();
    expect(asked!.html).toContain("data:image/png;base64,");
    expect(result.content[0]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
    const text = textOf(result);
    expect(text).toContain("needs 2400px");
    expect(text).toContain("first 2000px");
    expect(text).toContain("[error] Uncaught ReferenceError");
  });

  test("holds a preview to the same size limit as a shown page", async () => {
    const big = path.join(dir, "big-preview.png");
    await writeFile(big, Buffer.alloc(1024 * 1024, 1));
    let rendered = false;
    const { call } = setup(async () => {
      rendered = true;
      return { png: "", width: 680, appearance: "dark", contentHeight: 1, capturedHeight: 1, consoleMessages: [] };
    });
    const html = Array.from({ length: 20 }, () => `<img src="${big}">`).join("");
    const result = await call("page_preview", { html });
    expect(result.isError).toBe(true);
    expect(rendered).toBe(false);
  });

  test("says so when this kone has no browser to render with", async () => {
    const { call } = setup();
    const result = await call("page_preview", { html: "<p>x</p>" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("page_show");
  });
});
