// Pages an agent shows inside its reply, as gateway tools.
//
// When a chart, a table, a diagram or a mockup says more than prose would, the
// agent writes it as one self-contained HTML document. `page_preview` renders
// the document off screen and hands back a screenshot, the height it needs and
// what it logged, so the agent can see its work before anyone else does;
// `page_show` stores it as one of the thread's attachments and answers with
// the record the renderer draws the page from (@kone/protocol/page-render).
//
// A page is stored as written plus its local images, embedded: an agent points
// at a screenshot it just took by path, and the page must keep showing it after
// the file moves or the scratch directory is cleaned. Everything else a page
// loads, it loads from the network when it is drawn. As an attachment the page
// belongs to its thread, and goes when the thread does.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  formatPageShown,
  PAGE_COLUMN_WIDTH,
  PAGE_LAYOUT_GUIDE,
  PAGE_MAX_IMAGE_BYTES,
  PAGE_MAX_STORED_BYTES,
  PAGE_PREVIEW_TOOL_NAME,
  PAGE_SHOW_TOOL_NAME,
  PAGE_THEME_GUIDE,
  type PageAppearance,
} from "@kone/protocol/page-render";
import type { ChatAttachment, EmitEvent, UploadAttachmentInput } from "../../types.js";
import {
  GatewayToolError,
  PAGE_PREVIEW_JSON_SCHEMA,
  PAGE_SHOW_JSON_SCHEMA,
  PagePreviewInputSchema,
  PageShowInputSchema,
  type PagePreviewInput,
  type PageShowInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

/** One line a previewed page logged, uncaught errors included. */
export interface PageConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}

/** What one off-screen render of a page saw. */
export interface PagePreview {
  /** Base64 PNG of the page, as tall as it is up to the frame's limit. */
  png: string;
  width: number;
  /** The appearance it was rendered in. */
  appearance: PageAppearance;
  /** The height the page needs at this width. */
  contentHeight: number;
  /** The height the screenshot covers. */
  capturedHeight: number;
  consoleMessages: PageConsoleMessage[];
}

/** Renders a page off screen. The host owns the browser; without one,
 *  `page_preview` says previews are unavailable and `page_show` still works. */
export type PagePreviewer = (
  /** No appearance means the one on the user's screen. */
  input: { html: string; width: number; appearance?: PageAppearance },
  signal?: AbortSignal,
) => Promise<PagePreview>;

export interface PageToolOptions {
  /** Keeps a shown page among the thread's attachments. */
  saveAttachment: (input: UploadAttachmentInput) => Promise<ChatAttachment>;
  /** Puts the shown page in the calling turn. */
  emit: EmitEvent;
  preview?: PagePreviewer;
}

// ── local images ─────────────────────────────────────────────────────────────

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
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

interface InlinedPage {
  html: string;
  /** Paths the page names that hold no readable file. */
  missing: string[];
}

/** One local image the page names, read from disk, or null when nothing
 *  readable is there. */
async function readImage(written: string): Promise<{ uri: string } | null> {
  const file = fileOf(written);
  const mime = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) return null;
  // The size is asked first so an oversized file is refused without being read
  // into memory.
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > PAGE_MAX_IMAGE_BYTES) {
    throw new GatewayToolError(
      "invalid_input",
      `${written} is ${Math.ceil(info.size / (1024 * 1024))} MB; an embedded image can be at most ${PAGE_MAX_IMAGE_BYTES / (1024 * 1024)} MB. Scale it down or crop it first.`,
    );
  }
  const data = await readFile(file).catch(() => null);
  return data ? { uri: `data:${mime};base64,${data.toString("base64")}` } : null;
}

/** The page with every local image it names embedded as a data: URI: the one
 *  preparation both tools run, so what is previewed is what would be shown.
 *  A path that names nothing is left as written and reported. An image over
 *  the size limit is refused outright: dropping it silently would publish a
 *  page that looks finished and is not. So is a page that would outgrow the
 *  stored limit once embedded, counted per occurrence before anything is
 *  built, since one image named twenty times is embedded twenty times. */
async function inlineLocalImages(html: string): Promise<InlinedPage> {
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
  if (bytes > PAGE_MAX_STORED_BYTES) {
    throw new GatewayToolError(
      "invalid_input",
      `With its images embedded the page would be ${Math.ceil(bytes / (1024 * 1024))} MB; a page can be at most ${PAGE_MAX_STORED_BYTES / (1024 * 1024)} MB. Use fewer or smaller images, or name each one once.`,
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

/** A file name a page can be saved under: its title, with nothing a file
 *  system would refuse. */
function pageFileName(title: string): string {
  const stem = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${stem || "page"}.html`;
}

function previewText(preview: PagePreview, missing: string[]): string {
  const lines = [
    `Rendered at ${preview.width}px in ${preview.appearance}: the page needs ${preview.contentHeight}px` +
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

export function createPageTools(options: PageToolOptions): ToolEntry[] {
  const preview = options.preview;

  async function previewHandler(ctx: GatewayToolContext, input: PagePreviewInput): Promise<GatewayToolResult> {
    if (!preview) {
      throw new GatewayToolError(
        "provider_unavailable",
        "This kone cannot render previews. Show the page with page_show and keep its layout simple.",
      );
    }
    const { html, missing } = await inlineLocalImages(input.html);
    const result = await preview(
      input.appearance
        ? { html, width: input.width ?? PAGE_COLUMN_WIDTH, appearance: input.appearance }
        : { html, width: input.width ?? PAGE_COLUMN_WIDTH },
      ctx.signal,
    );
    return {
      content: [
        { type: "image", data: result.png, mimeType: "image/png" },
        { type: "text", text: previewText(result, missing) },
      ],
    };
  }

  async function showHandler(ctx: GatewayToolContext, input: PageShowInput): Promise<GatewayToolResult> {
    const { html, missing } = await inlineLocalImages(input.html);
    if (missing.length) {
      throw new GatewayToolError(
        "invalid_input",
        `No file at: ${missing.join(", ")}. Fix or remove those image paths, then show the page again.`,
      );
    }
    const saved = await options.saveAttachment({
      threadId: ctx.threadId,
      name: pageFileName(input.title),
      mimeType: "text/html",
      data: Buffer.from(html, "utf8").toString("base64"),
    });
    const shown = formatPageShown({
      attachmentId: saved.id,
      title: input.title,
      height: input.height,
    });
    // The page goes into the turn as an item of its own rather than relying on
    // the provider to report this call. Codex calls kone's tools from inside
    // its own script tool, so the thread only ever sees that script, named for
    // the script and with this record buried in its output; and its adapter
    // reports even a direct MCP call by a generic name. Claude reports the call
    // as page_show with this same record, so the thread shows each page once,
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
          itemId: `page:${saved.id}`,
          kind: "tool_call",
          status: "completed",
          name: PAGE_SHOW_TOOL_NAME,
          text: input.title,
          detail: shown,
        },
      });
    }
    // Text only: a structured copy would be the half some providers read
    // instead.
    return { content: [{ type: "text", text: shown }] };
  }

  return [
    {
      name: PAGE_PREVIEW_TOOL_NAME,
      description: `Render an HTML page off screen and get back a PNG screenshot, contentHeight (the height the page needs at this width), and what it logged to the console, uncaught errors included; console.log is a fine way to report your own checks. Use it to check and fix a page before page_show. The page gets the theme variables and layout described on page_show.`,
      inputSchema: PagePreviewInputSchema,
      jsonSchema: PAGE_PREVIEW_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: "Screenshot an HTML page off screen, to check it before showing it.",
      handler: previewHandler,
    },
    {
      name: PAGE_SHOW_TOOL_NAME,
      description: `Show the user anything they should see rather than read about (a UI component, a screen or layout, design options side by side, a chart, table, diagram or flow, an interactive explainer) as a finished HTML page, inline in this thread, above your final reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is or restate it: add only what the page doesn't say. Check it with page_preview first. Scripts run inside the page, sandboxed away from kone; links the reader clicks open in their browser. ${PAGE_LAYOUT_GUIDE} ${PAGE_THEME_GUIDE}`,
      inputSchema: PageShowInputSchema,
      jsonSchema: PAGE_SHOW_JSON_SCHEMA,
      permission: "allow",
      // The page is stored in the caller's thread as part of the turn it
      // answers, so it needs that turn running.
      requiresActiveTurn: true,
      promptSnippet:
        "Show the user something inside your reply (a component, a screen, a chart, a diagram): the only way a visual reaches them.",
      promptGuidelines: [
        "Whenever there is something to show — the user asks you to show, visualize, preview, mock up, chart or draw it, or seeing it would say more than prose — the answer is a page: a UI component, a screen or layout, design options side by side, a palette or type scale, an animation, an interactive explainer, a chart, table, diagram or flow. Build it as one self-contained HTML page, check it with page_preview, then show it with page_show before your final reply.",
        "To show a component or screen from the user's project, rebuild it in the page with plain HTML, CSS and JS in the project's own colours, type, spacing and copy, so it looks like theirs rather than like kone; put its states or variants side by side when that is the question.",
        "Never answer with matplotlib, an image file or a markdown image instead: the thread cannot display a file from disk, so the user gets a broken image. Draw in the page with HTML, inline SVG, a canvas or a library from a CDN; an image that already exists on disk, a screenshot included, goes into a page by its absolute path.",
        "The user sees the page above your reply, so don't announce or restate it; add only what it doesn't say.",
      ],
      handler: showHandler,
    },
  ];
}
