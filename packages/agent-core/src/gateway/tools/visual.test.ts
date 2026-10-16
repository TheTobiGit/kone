import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { VISUAL_MAX_PER_TURN, VISUAL_MEASURE_WIDTHS, parseVisualShown } from "@kone/protocol/visual-render";
import type { ChatAttachment, RuntimeEvent, UploadAttachmentInput } from "../../types.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import { createVisualTools, type VisualMeasurer, type VisualPreviewer, type VisualToolOptions } from "./visual.js";

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
  dir = await mkdtemp(path.join(tmpdir(), "kone-visual-"));
  shot = path.join(dir, "shot.png");
  await writeFile(shot, PNG);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A promise a test settles by hand, to hold a call inside one of its awaits. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(
  preview?: VisualPreviewer,
  extra: Partial<Pick<VisualToolOptions, "measure" | "measureBudgetMs">> = {},
  saveOverride?: (input: UploadAttachmentInput) => Promise<ChatAttachment>,
) {
  const saved: UploadAttachmentInput[] = [];
  const saveAttachment = async (input: UploadAttachmentInput): Promise<ChatAttachment> => {
    if (saveOverride) return saveOverride(input);
    saved.push(input);
    // The first visual keeps the id the older tests expect; later ones differ.
    const id = saved.length === 1 ? "att_0001-aaaa" : `att_000${saved.length}-aaaa`;
    return { type: "file", id, name: input.name, mimeType: input.mimeType, sizeBytes: 1 };
  };
  const emitted: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent): void => void emitted.push(event);
  const registry = createRegistry(
    createVisualTools(preview ? { saveAttachment, emit, preview, ...extra } : { saveAttachment, emit, ...extra }),
  );
  return {
    saved,
    emitted,
    call: (name: string, args: Record<string, string | number>, context: GatewayToolContext = ctx) =>
      registry.call(context, name, args),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

describe("visual_show", () => {
  test("stores the visual in the caller's thread and answers with the record the renderer reads", async () => {
    const { saved, call } = setup();
    const result = await call("visual_show", { html: "<p>hi</p>", title: "Latency: by region", height: 5000 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.threadId).toBe("thread-1");
    expect(saved[0]!.mimeType).toBe("text/html");
    expect(saved[0]!.name).toBe("Latency by region.html");
    expect(Buffer.from(saved[0]!.data, "base64").toString("utf8")).toBe("<p>hi</p>");
    expect(parseVisualShown(textOf(result))).toEqual({
      attachmentId: "att_0001-aaaa",
      title: "Latency: by region",
      height: 2000,
    });
  });

  test("puts the visual in the calling turn itself, whatever the provider reports of the call", async () => {
    const { emitted, call } = setup();
    const result = await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    if (event.type !== "item.completed") throw new Error(`expected item.completed, got ${event.type}`);
    expect(event.threadId).toBe("thread-1");
    expect(event.turnId).toBe("turn-1");
    expect(event.item).toEqual({
      itemId: "visual:att_0001-aaaa",
      kind: "tool_call",
      status: "completed",
      name: "visual_show",
      text: "Chart",
      detail: textOf(result),
    });
  });

  test("embeds local images named by path, wherever the visual names them", async () => {
    const { saved, call } = setup();
    const html = `<img src="${shot}"><div style="background:url(${shot})"></div><script>const s='${shot}'</script>`;
    await call("visual_show", { html, title: "Shots", height: 300 });
    const stored = Buffer.from(saved[0]!.data, "base64").toString("utf8");
    expect(stored).not.toContain(shot);
    expect(stored.match(/data:image\/png;base64,/g)).toHaveLength(3);
  });

  test("leaves URLs and relative paths alone", async () => {
    const { saved, call } = setup();
    const html = `<img src="https://example.com/a.png"><img src="//cdn.example.com/b.png"><img src="c.png">`;
    await call("visual_show", { html, title: "Remote", height: 300 });
    expect(Buffer.from(saved[0]!.data, "base64").toString("utf8")).toBe(html);
  });

  test("refuses a visual naming an image that is not there, and stores nothing", async () => {
    const { saved, emitted, call } = setup();
    const result = await call("visual_show", { html: `<img src="${dir}/gone.png">`, title: "Gone", height: 300 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${dir}/gone.png`);
    expect(saved).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  test("counts every place an image is named against the visual's size, before building it", async () => {
    const big = path.join(dir, "big.png");
    await writeFile(big, Buffer.alloc(1024 * 1024, 1));
    const html = Array.from({ length: 20 }, () => `<img src="${big}">`).join("");
    const { saved, call } = setup();
    const result = await call("visual_show", { html, title: "Many", height: 300 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("name each one once");
    expect(saved).toHaveLength(0);
  });
});

describe("visual_show within a turn", () => {
  test("answers a retried call with the visual it already showed, storing it once", async () => {
    const { saved, emitted, call } = setup();
    const first = await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    const again = await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    expect(textOf(again)).toBe(textOf(first));
    expect(saved).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  test("shows the same visual again in a later turn", async () => {
    const { saved, call } = setup();
    await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 }, { ...ctx, turnId: "turn-2" });
    expect(saved).toHaveLength(2);
  });

  test("refuses a visual past the turn's cap, and stores nothing for it", async () => {
    const { saved, call } = setup();
    for (let i = 0; i < VISUAL_MAX_PER_TURN; i++) {
      const result = await call("visual_show", { html: `<p>${i}</p>`, title: "Chart", height: 300 });
      expect(result.isError).toBeUndefined();
    }
    const over = await call("visual_show", { html: "<p>one more</p>", title: "Chart", height: 300 });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("Combine");
    expect(saved).toHaveLength(VISUAL_MAX_PER_TURN);
  });

  test("stores one visual when the same call arrives again before the first is stored", async () => {
    const gate = deferred<Array<[number, number]>>();
    let measured = 0;
    const measure: VisualMeasurer = () => {
      measured += 1;
      return gate.promise;
    };
    const { saved, emitted, call } = setup(undefined, { measure });
    const first = call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    const again = call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    gate.resolve([[680, 300]]);
    const [one, two] = await Promise.all([first, again]);
    expect(textOf(two)).toBe(textOf(one));
    expect(saved).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(measured).toBe(1);
  });

  test("counts visuals still being stored against the turn's cap", async () => {
    const gate = deferred<Array<[number, number]>>();
    const measure: VisualMeasurer = () => gate.promise;
    const { saved, call } = setup(undefined, { measure });
    const calls = Array.from({ length: VISUAL_MAX_PER_TURN + 2 }, (_, i) =>
      call("visual_show", { html: `<p>${i}</p>`, title: "Chart", height: 300 }),
    );
    gate.resolve([[680, 300]]);
    const results = await Promise.all(calls);
    const refused = results.filter((result) => result.isError === true);
    expect(refused).toHaveLength(2);
    for (const result of refused) expect(textOf(result)).toContain("Combine");
    expect(saved).toHaveLength(VISUAL_MAX_PER_TURN);
  });

  test("lets a visual whose storing failed be shown again", async () => {
    let attempts = 0;
    const { call } = setup(undefined, {}, async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
      return { type: "file", id: "att_0001-aaaa", name: input.name, mimeType: input.mimeType, sizeBytes: 1 };
    });
    const args = { html: "<p>hi</p>", title: "Chart", height: 300 };
    const failed = await call("visual_show", args);
    expect(failed.isError).toBe(true);
    const again = await call("visual_show", args);
    expect(again.isError).toBeUndefined();
    expect(parseVisualShown(textOf(again))?.attachmentId).toBe("att_0001-aaaa");
    expect(attempts).toBe(2);
  });

  test("records the heights the host measured at each width", async () => {
    let widths: readonly number[] = [];
    const measure: VisualMeasurer = async (input) => {
      widths = input.widths;
      return input.widths.map((width): [number, number] => [width, Math.round(200000 / width)]);
    };
    const { call } = setup(undefined, { measure });
    const result = await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 });
    expect(widths).toEqual([...VISUAL_MEASURE_WIDTHS]);
    expect(parseVisualShown(textOf(result))?.heights).toEqual([
      [400, 500],
      [680, 294],
      [1140, 175],
    ]);
  });

  test("shows the visual without heights when measuring fails or takes too long", async () => {
    const failing = setup(undefined, { measure: async () => Promise.reject(new Error("no window")) });
    const failed = await failing.call("visual_show", { html: "<p>a</p>", title: "A", height: 300 });
    expect(parseVisualShown(textOf(failed))).toEqual({ attachmentId: "att_0001-aaaa", title: "A", height: 300 });

    const slow = setup(undefined, { measure: () => new Promise(() => {}), measureBudgetMs: 10 });
    const late = await slow.call("visual_show", { html: "<p>b</p>", title: "B", height: 300 });
    expect(parseVisualShown(textOf(late))?.heights).toBeUndefined();
  });

  test("puts nothing in a turn that was stopped while the visual was being shown", async () => {
    const abort = new AbortController();
    const measure: VisualMeasurer = async (input) => {
      abort.abort();
      return input.widths.map((width): [number, number] => [width, 300]);
    };
    const { emitted, call } = setup(undefined, { measure });
    const result = await call("visual_show", { html: "<p>hi</p>", title: "Chart", height: 300 }, { ...ctx, signal: abort.signal });
    expect(result.isError).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});

describe("visual_preview", () => {
  test("hands back the screenshot as an image, and the measurements and console as text", async () => {
    let asked: Parameters<VisualPreviewer>[0] | null = null;
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
    const result = await call("visual_preview", { html: `<img src="${shot}">` });
    expect(asked!.width).toBe(680);
    expect(asked!.appearance).toBeUndefined();
    expect(asked!.html).toContain("data:image/png;base64,");
    expect(result.content[0]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
    const text = textOf(result);
    expect(text).toContain("needs 2400px");
    expect(text).toContain("first 2000px");
    expect(text).toContain("[error] Uncaught ReferenceError");
  });

  test("holds a preview to the same size limit as a shown visual", async () => {
    const big = path.join(dir, "big-preview.png");
    await writeFile(big, Buffer.alloc(1024 * 1024, 1));
    let rendered = false;
    const { call } = setup(async () => {
      rendered = true;
      return { png: "", width: 680, appearance: "dark", contentHeight: 1, capturedHeight: 1, consoleMessages: [] };
    });
    const html = Array.from({ length: 20 }, () => `<img src="${big}">`).join("");
    const result = await call("visual_preview", { html });
    expect(result.isError).toBe(true);
    expect(rendered).toBe(false);
  });

  test("says so when this kone has no browser to render with", async () => {
    const { call } = setup();
    const result = await call("visual_preview", { html: "<p>x</p>" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("visual_show");
  });
});
