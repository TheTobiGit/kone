// Dynamic visuals — what an agent shows inside its reply — as gateway tools.
//
// When a chart, a table, a diagram or a mockup says more than prose would, the
// agent writes it as one self-contained HTML document. `visual_preview` renders
// the document off screen and hands back a screenshot, the height it needs and
// what it logged, so the agent can see its work before anyone else does;
// `visual_show` stores it as one of the thread's attachments and answers with
// the record the renderer draws the visual from (@kone/protocol/visual-render).
// Where the host can render off screen, showing also measures the visual at the
// widths it is drawn at, so the thread reserves the right height before the
// visual has loaded instead of jumping when it does.
//
// A visual is stored as written plus its local images, embedded: an agent points
// at a screenshot it just took by path, and the visual must keep showing it after
// the file moves or the scratch directory is cleaned. Everything else a visual
// loads, it loads from the network when it is drawn. As an attachment the visual
// belongs to its thread, and goes when the thread does.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  formatVisualShown,
  VISUAL_COLUMN_WIDTH,
  VISUAL_FORMS_GUIDE,
  VISUAL_LAYOUT_GUIDE,
  VISUAL_MAX_IMAGE_BYTES,
  VISUAL_MAX_PER_TURN,
  VISUAL_MEASURE_WIDTHS,
  VISUAL_MAX_STORED_BYTES,
  VISUAL_PREVIEW_TOOL_NAME,
  VISUAL_SHOW_TOOL_NAME,
  VISUAL_THEME_GUIDE,
  type VisualAppearance,
  type VisualRef,
} from "@kone/protocol/visual-render";
import type { ChatAttachment, EmitEvent, UploadAttachmentInput } from "../../types.js";
import {
  GatewayToolError,
  VISUAL_PREVIEW_JSON_SCHEMA,
  VISUAL_SHOW_JSON_SCHEMA,
  VisualPreviewInputSchema,
  VisualShowInputSchema,
  type VisualPreviewInput,
  type VisualShowInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

/** One line a previewed visual logged, uncaught errors included. */
export interface VisualConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}

/** What one off-screen render of a visual saw. */
export interface VisualPreview {
  /** Base64 PNG of the visual, as tall as it is up to the frame's limit. */
  png: string;
  width: number;
  /** The appearance it was rendered in. */
  appearance: VisualAppearance;
  /** The height the visual needs at this width. */
  contentHeight: number;
  /** The height the screenshot covers. */
  capturedHeight: number;
  consoleMessages: VisualConsoleMessage[];
}

/** Renders a visual off screen. The host owns the browser; without one,
 *  `visual_preview` says previews are unavailable and `visual_show` still works. */
export type VisualPreviewer = (
  /** No appearance means the one on the user's screen. */
  input: { html: string; width: number; appearance?: VisualAppearance },
  signal?: AbortSignal,
) => Promise<VisualPreview>;

/** Measures the height a visual needs at each width, in the user's theme:
 *  [width, height] pairs. The host owns the browser; without one, a visual is
 *  shown with only the height the agent gave. */
export type VisualMeasurer = (
  input: { html: string; widths: readonly number[] },
  signal?: AbortSignal,
) => Promise<Array<[number, number]>>;

export interface VisualToolOptions {
  /** Keeps a shown visual among the thread's attachments. */
  saveAttachment: (input: UploadAttachmentInput) => Promise<ChatAttachment>;
  /** Puts the shown visual in the calling turn. */
  emit: EmitEvent;
  preview?: VisualPreviewer;
  measure?: VisualMeasurer;
  /** How long showing waits for the measurement before going ahead without
   *  it: a visual on screen a moment sooner beats one reserved exactly. */
  measureBudgetMs?: number;
}

export const MEASURE_BUDGET_MS = 6_000;
/** Turns whose visuals are remembered, for the per-turn cap and for answering
 *  a retried call with the visual it already showed. Oldest go first. */
const TRACKED_TURNS = 256;

// ── local images ─────────────────────────────────────────────────────────────

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const IMAGE_EXT = "png|jpe?g|gif|webp|avif|svg|bmp|ico";
// POSIX `/…` (never a protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE = String.raw`(?:/(?!/)|[A-Za-z]:[\\/])`;
// A whole quoted string that is an absolute image path: an attribute value, a
// quoted CSS url(), or a JS string. A URL, a data: URI or a relative path
// never starts the way ABSOLUTE does.
const QUOTED_IMAGE_PATH = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE}[^"'\x60\n<>]*?\.(?:${IMAGE_EXT}))\1`,
  "gi",
);
// An unquoted CSS url(…).
const CSS_URL_IMAGE_PATH = new RegExp(
  String.raw`url\(\s*(${ABSOLUTE}[^)'"\s]*?\.(?:${IMAGE_EXT}))\s*\)`,
  "gi",
);

/** A path as written to the file it names. Inside a JS string a Windows
 *  path's backslashes are escaped, so they are unescaped first. */
function fileOf(written: string): string {
  return /^[A-Za-z]:/.test(written) ? written.replace(/\\\\/g, "\\") : written;
}

export interface InlinedVisual {
  html: string;
  /** Paths the visual names that hold no readable file. */
  missing: string[];
}

/** One local image the visual names, read from disk, or null when nothing
 *  readable is there. */
async function readImage(written: string): Promise<{ uri: string } | null> {
  const file = fileOf(written);
  const mime = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) return null;
  // The size is asked first so an oversized file is refused without being read
  // into memory.
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > VISUAL_MAX_IMAGE_BYTES) {
    throw new GatewayToolError(
      "invalid_input",
      `${written} is ${Math.ceil(info.size / (1024 * 1024))} MB; an embedded image can be at most ${VISUAL_MAX_IMAGE_BYTES / (1024 * 1024)} MB. Scale it down or crop it first.`,
    );
  }
  const data = await readFile(file).catch(() => null);
  return data ? { uri: `data:${mime};base64,${data.toString("base64")}` } : null;
}

/** The visual with every local image it names embedded as a data: URI: the one
 *  preparation both tools run, so what is previewed is what would be shown.
 *  A path that names nothing is left as written and reported. An image over
 *  the size limit is refused outright: dropping it silently would publish a
 *  visual that looks finished and is not. So is a visual that would outgrow the
 *  stored limit once embedded, counted per occurrence before anything is
 *  built, since one image named twenty times is embedded twenty times. */
export async function inlineLocalImages(html: string): Promise<InlinedVisual> {
  const occurrences = new Map<string, number>();
  const count = (written: string): void => void occurrences.set(written, (occurrences.get(written) ?? 0) + 1);
  for (const match of html.matchAll(QUOTED_IMAGE_PATH)) count(match[2]!);
  for (const match of html.matchAll(CSS_URL_IMAGE_PATH)) count(match[1]!);
  if (occurrences.size === 0) return { html, missing: [] };

  const written = [...occurrences.keys()];
  const read = await Promise.all(written.map(readImage));
  const dataUris = new Map<string, string>();
  const missing: string[] = [];
  let bytes = Buffer.byteLength(html, "utf8");
  written.forEach((each, index) => {
    const image = read[index];
    if (!image) {
      missing.push(each);
      return;
    }
    dataUris.set(each, image.uri);
    bytes += (image.uri.length - Buffer.byteLength(each, "utf8")) * occurrences.get(each)!;
  });
  if (bytes > VISUAL_MAX_STORED_BYTES) {
    throw new GatewayToolError(
      "invalid_input",
      `With its images embedded the visual would be ${Math.ceil(bytes / (1024 * 1024))} MB; a visual can be at most ${VISUAL_MAX_STORED_BYTES / (1024 * 1024)} MB. Use fewer or smaller images, or name each one once.`,
    );
  }

  const out = html
    .replace(QUOTED_IMAGE_PATH, (whole, quote: string, each: string) => {
      const uri = dataUris.get(each);
      return uri ? `${quote}${uri}${quote}` : whole;
    })
    .replace(CSS_URL_IMAGE_PATH, (whole, each: string) => {
      const uri = dataUris.get(each);
      return uri ? `url(${uri})` : whole;
    });
  return { html: out, missing };
}

// ── tools ────────────────────────────────────────────────────────────────────

/** A file name a visual can be saved under: its title, with nothing a file
 *  system would refuse. */
export function visualFileName(title: string): string {
  const stem = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${stem || "visual"}.html`;
}

function previewText(preview: VisualPreview, missing: string[]): string {
  const lines = [
    `Rendered at ${preview.width}px in ${preview.appearance}: the visual needs ${preview.contentHeight}px` +
      (preview.capturedHeight < preview.contentHeight
        ? `; the screenshot shows the first ${preview.capturedHeight}px.`
        : "."),
  ];
  if (missing.length) lines.push(`No file at: ${missing.join(", ")}. Those images will not show.`);
  if (preview.consoleMessages.length) {
    lines.push("Console:");
    for (const message of preview.consoleMessages) lines.push(`[${message.level}] ${message.text}`);
  } else {
    lines.push("Console: nothing logged.");
  }
  return lines.join("\n");
}

/** The measurement, or nothing when it fails or outlasts the budget: showing
 *  never fails because the visual could not be measured. */
export async function measureWithin(
  measure: VisualMeasurer | undefined,
  html: string,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<Array<[number, number]> | undefined> {
  if (!measure) return undefined;
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve(undefined);
    }, budgetMs);
  });
  try {
    const measured = measure({ html, widths: VISUAL_MEASURE_WIDTHS }, abort.signal).catch(() => undefined);
    const heights = await Promise.race([measured, timeout]);
    return heights?.length ? heights : undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

export function createVisualTools(options: VisualToolOptions): ToolEntry[] {
  const preview = options.preview;
  // Per running turn: one promise per distinct visual, resolving to the record
  // the renderer draws it from. A call the provider repeats, or sends twice at
  // once, joins the promise already there rather than storing and drawing a
  // second copy, and a visual still being stored counts against the turn's cap
  // like any other. In memory only — a restart forgets it, which costs nothing
  // more than a looping agent getting a fresh allowance.
  const shownByTurn = new Map<string, Map<string, Promise<string>>>();
  const turnShown = (key: string): Map<string, Promise<string>> => {
    let shown = shownByTurn.get(key);
    if (!shown) {
      while (shownByTurn.size >= TRACKED_TURNS) shownByTurn.delete(shownByTurn.keys().next().value!);
      shown = new Map();
      shownByTurn.set(key, shown);
    }
    return shown;
  };

  async function previewHandler(ctx: GatewayToolContext, input: VisualPreviewInput): Promise<GatewayToolResult> {
    if (!preview) {
      throw new GatewayToolError(
        "provider_unavailable",
        "This kone cannot render previews. Show the visual with visual_show and keep its layout simple.",
      );
    }
    const { html, missing } = await inlineLocalImages(input.html);
    const result = await preview(
      input.appearance
        ? { html, width: input.width ?? VISUAL_COLUMN_WIDTH, appearance: input.appearance }
        : { html, width: input.width ?? VISUAL_COLUMN_WIDTH },
      ctx.signal,
    );
    return {
      content: [
        { type: "image", data: result.png, mimeType: "image/png" },
        { type: "text", text: previewText(result, missing) },
      ],
    };
  }

  /** Measures, stores and reports one visual, and puts it in the calling turn.
   *  Resolves to the record the renderer draws it from. */
  async function showVisual(ctx: GatewayToolContext, input: VisualShowInput, html: string): Promise<string> {
    const heights = await measureWithin(options.measure, html, options.measureBudgetMs ?? MEASURE_BUDGET_MS, ctx.signal);
    const saved = await options.saveAttachment({
      threadId: ctx.threadId,
      name: visualFileName(input.title),
      mimeType: "text/html",
      data: Buffer.from(html, "utf8").toString("base64"),
    });
    // Stopped while the visual was measured or written: a stopped turn gains
    // nothing. The file left behind belongs to no item, so the attachment
    // sweep takes it.
    if (ctx.signal?.aborted) {
      throw new GatewayToolError("cancelled", "The turn was stopped before the visual could be shown.");
    }
    const visual: VisualRef = { attachmentId: saved.id, title: input.title, height: input.height };
    if (heights) visual.heights = heights;
    const record = formatVisualShown(visual);
    // The visual goes into the turn as an item of its own rather than relying on
    // the provider to report this call. Codex calls kone's tools from inside
    // its own script tool, so the thread only ever sees that script, named for
    // the script and with this record buried in its output; and its adapter
    // reports even a direct MCP call by a generic name. Claude reports the call
    // as visual_show with this same record, so the thread shows each visual once,
    // keyed by its attachment.
    if (ctx.turnId) {
      options.emit({
        type: "item.completed",
        threadId: ctx.threadId,
        provider: ctx.provider,
        at: Date.now(),
        source: "kone.store",
        turnId: ctx.turnId,
        item: {
          itemId: `visual:${saved.id}`,
          kind: "tool_call",
          status: "completed",
          name: VISUAL_SHOW_TOOL_NAME,
          text: input.title,
          detail: record,
        },
      });
    }
    return record;
  }

  async function showHandler(ctx: GatewayToolContext, input: VisualShowInput): Promise<GatewayToolResult> {
    const { html, missing } = await inlineLocalImages(input.html);
    if (missing.length) {
      throw new GatewayToolError(
        "invalid_input",
        `No file at: ${missing.join(", ")}. Fix or remove those image paths, then show the visual again.`,
      );
    }
    const shown = turnShown(`${ctx.threadId}\u0000${ctx.turnId ?? ""}`);
    const digest = createHash("sha256").update(`${input.title}\u0000${input.height}\u0000${html}`, "utf8").digest("hex");
    // A provider that retries a call it never heard back from sends the same
    // visual twice, and may send it again while the first is still being shown:
    // the call already reserved under this digest is the one that answers.
    const already = shown.get(digest);
    if (already) return { content: [{ type: "text", text: await already }] };
    if (shown.size >= VISUAL_MAX_PER_TURN) {
      throw new GatewayToolError(
        "invalid_input",
        `This turn already shows ${VISUAL_MAX_PER_TURN} visuals. Combine what is left into one visual instead.`,
      );
    }
    // Reserve the digest before the first await, so a call that arrives while
    // this one is being stored joins it instead of storing a second copy, and
    // so a visual still being stored counts against the cap.
    const reserved = showVisual(ctx, input, html);
    shown.set(digest, reserved);
    try {
      // Text only: a structured copy would be the half some providers read
      // instead.
      return { content: [{ type: "text", text: await reserved }] };
    } catch (error) {
      // Nothing was shown, so the reservation is not a showing: let the same
      // call be tried again. Only this reservation is dropped, never one a
      // later call made under the same digest.
      if (shown.get(digest) === reserved) shown.delete(digest);
      throw error;
    }
  }

  return [
    {
      name: VISUAL_PREVIEW_TOOL_NAME,
      description: `Render an HTML visual off screen and get back a PNG screenshot, contentHeight (the height the visual needs at this width), and what it logged to the console, uncaught errors included; console.log is a fine way to report your own checks. Use it to check and fix a visual before visual_show. The visual gets the theme variables and layout described on visual_show; choose its form from the vocabulary there.`,
      inputSchema: VisualPreviewInputSchema,
      jsonSchema: VISUAL_PREVIEW_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "Screenshot an HTML visual off screen, to check it before showing it.",
      handler: previewHandler,
    },
    {
      name: VISUAL_SHOW_TOOL_NAME,
      description: `Show the user anything they should see rather than read about (a UI component, a screen or layout, design options side by side, a chart, table, diagram or flow, an interactive explainer) as a dynamic visual: one finished HTML document, drawn inside your reply in this thread. Call it before writing that reply. The result gives a short fenced block naming the visual: write it in your reply on its own lines where the visual belongs, like a paragraph, with your text before and after it; a visual you don't place stands above your reply. The reader sees the visual, so the reply should not announce it, say where it is or restate it: add only what the visual doesn't say. At most ${VISUAL_MAX_PER_TURN} visuals a turn. Check it with visual_preview first. Scripts run inside the visual, sandboxed away from kone; links the reader clicks open in their browser. ${VISUAL_FORMS_GUIDE} ${VISUAL_LAYOUT_GUIDE} ${VISUAL_THEME_GUIDE}`,
      inputSchema: VisualShowInputSchema,
      jsonSchema: VISUAL_SHOW_JSON_SCHEMA,
      permission: "allow",
      // The visual is stored in the caller's thread as part of the turn it
      // answers, so it needs that turn running.
      requiresActiveTurn: true,
      promptSnippet:
        "Show the user something inside your reply (a component, a screen, a chart, a diagram): the only way a visual reaches them.",
      promptGuidelines: [
        "Whenever there is something to show — the user asks you to show, visualize, preview, mock up, chart or draw it, or seeing it would say more than prose — the answer is a visual: a UI component, a screen or layout, design options side by side, a palette or type scale, an animation, an interactive explainer, a chart, table, diagram or flow. Build it as one self-contained HTML document, check it with visual_preview, then show it with visual_show before your final reply.",
        "Choose each visual's form for the shape of the data or idea from the vocabulary on visual_show, for explainers, flows, states and comparisons as much as for data. Plain bar, line or pie charts and rectangle-button layouts only when they truly fit best; mash forms up and be inventive, never at the cost of accuracy or readability.",
        "To show a component or screen from the user's project, rebuild it in the visual with plain HTML, CSS and JS in the project's own colours, type, spacing and copy, so it looks like theirs rather than like kone; put its states or variants side by side when that is the question.",
        "Never answer with matplotlib, an image file or a markdown image instead: the thread cannot display a file from disk, so the user gets a broken image. Draw in the visual with HTML, inline SVG, a canvas or a library from a CDN; an image that already exists on disk, a screenshot included, goes into a visual by its absolute path.",
        "Place each visual where it belongs in your reply by writing the fenced block visual_show returns on its own lines, the key finding stated in words around it. The user sees the visual, so don't announce or restate it; add only what it doesn't say.",
      ],
      handler: showHandler,
    },
  ];
}
