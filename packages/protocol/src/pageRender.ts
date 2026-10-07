// Pages an agent shows inside its reply, written and read in one place.
//
// An agent that has something to show — a component, a screen, a chart, a
// diagram — writes it as one self-contained HTML document and hands it to the
// gateway's `page_show` tool. The gateway stores the document as one of the
// thread's attachments and answers with a small record; the provider stores
// that answer against the call's item, and the renderer reads the record back
// to draw the page in the turn, in a sandboxed frame on its own scheme. Three
// parties, so the record and the frame's protocol live here where none of them
// can change it alone.
//
// The frame and the app speak JSON-RPC over postMessage, in the method names
// of the MCP Apps extension, so a host for third-party MCP app views can reuse
// the frame as it is.

import { z } from "zod";

export const PAGE_SHOW_TOOL_NAME = "page_show";
export const PAGE_PREVIEW_TOOL_NAME = "page_preview";

/** The scheme pages are served on. Its own scheme, so a page never shares an
 *  origin with the app or with the attachments the user uploaded. */
export const PAGE_SCHEME = "kone-page";

export const PAGE_MIN_HEIGHT = 80;
export const PAGE_MAX_HEIGHT = 2000;
export const PAGE_MAX_TITLE_LENGTH = 200;
/** The document as the agent wrote it, before local images are inlined. */
export const PAGE_MAX_HTML_LENGTH = 512_000;
/** The stored page, inlined images included. */
export const PAGE_MAX_STORED_BYTES = 16 * 1024 * 1024;
/** One inlined image. */
export const PAGE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The reply column's width at the default measure — what an agent previews at
 *  unless it asks for another. */
export const PAGE_COLUMN_WIDTH = 680;
/** The narrowest a page is shown at: the assistant panel, or a thread squeezed
 *  beside other panes. */
export const PAGE_NARROWEST_WIDTH = 400;
/** About the widest a page is shown at: the full-size view's card. */
export const PAGE_VIEWER_WIDTH = 1140;
export const PAGE_PREVIEW_MIN_WIDTH = 240;
export const PAGE_PREVIEW_MAX_WIDTH = 1600;

export function clampPageHeight(height: number): number {
  if (!Number.isFinite(height)) return PAGE_MIN_HEIGHT;
  return Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, Math.round(height)));
}

// ── the record a shown page leaves behind ─────────────────────────────────────

const PageRefSchema = z.object({
  attachmentId: z.string().regex(/^att_[0-9a-f-]+$/),
  title: z.string().min(1).max(PAGE_MAX_TITLE_LENGTH),
  /** The frame's height before the page has reported its own. */
  height: z.number(),
});

export type PageRef = z.infer<typeof PageRefSchema>;

const PageShownSchema = z.object({
  page: PageRefSchema,
  /** What the model reading the result should do next. Never shown. */
  note: z.string(),
});

export type PageShown = z.infer<typeof PageShownSchema>;

/** What the agent is told once its page is up. The reader sees the page before
 *  the reply under it, so a reply that describes the page says everything
 *  twice. */
export const PAGE_SHOWN_NOTE =
  "Shown to the reader in this turn, above your reply. Don't announce, locate or restate the page; reply with only what it doesn't already say.";

/** Encode a shown page as the tool result text the item stores. */
export function formatPageShown(page: PageRef): string {
  return JSON.stringify({ page, note: PAGE_SHOWN_NOTE } satisfies PageShown);
}

/** The page a result text records, or null for anything else — a failed
 *  call's error, a cancel, an in-progress input dump. */
export function parsePageShown(text: string | null | undefined): PageRef | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields whatever the text held; the zod schema below
    // is the only gate before the value is trusted.
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const result = PageShownSchema.safeParse(parsed);
  if (!result.success) return null;
  return { ...result.data.page, height: clampPageHeight(result.data.page.height) };
}

/** Where the renderer loads a shown page from. */
export function pageUrl(attachmentId: string): string {
  return `${PAGE_SCHEME}://${attachmentId}/`;
}

// ── the theme a page wears ───────────────────────────────────────────────────

/** The app's own variables, handed to the page under the same names so a
 *  value written over another (`color-mix(… var(--ink) …)`) resolves inside
 *  the page exactly as it does in the app. */
export const PAGE_THEME_VARIABLES = [
  "--sunken",
  "--ground",
  "--band",
  "--raised",
  "--raised-high",
  "--overlay",
  "--field",
  "--chip",
  "--ink",
  "--ink-soft",
  "--muted",
  "--faint",
  "--placeholder",
  "--line",
  "--line-soft",
  "--hover",
  "--press",
  "--selected",
  "--focus",
  "--accent",
  "--accent-ink",
  "--accent-wash",
  "--accent-2",
  "--accent-2-ink",
  "--accent-2-wash",
  "--highlight",
  "--highlight-wash",
  "--folder",
  "--file",
  "--agent",
  "--ok",
  "--warn",
  "--danger",
  "--diff-add",
  "--diff-del",
  "--code-bg",
  "--font-sans",
  "--font-serif",
  "--font-mono",
] as const;

/** A chart needs more distinct series colours than the app has jobs for. These
 *  are drawn from the voices a theme already chose to set apart from each other,
 *  so a chart never introduces a hue the theme did not pick. */
export const PAGE_CHART_VARIABLES: Readonly<Record<string, string>> = {
  "--chart-1": "var(--accent)",
  "--chart-2": "var(--accent-2)",
  "--chart-3": "var(--highlight)",
  "--chart-4": "var(--ok)",
  "--chart-5": "var(--danger)",
  "--chart-6": "var(--file)",
};

export type PageAppearance = "light" | "dark";

export interface PageTheme {
  appearance: PageAppearance;
  variables: Record<string, string>;
}

/** What the agent is told about the variables, in the tool descriptions. */
export const PAGE_THEME_GUIDE = [
  "kone sets its live theme on :root as CSS custom properties, and they follow the user's theme and light/dark switch while the page is open:",
  "--ground (the exact surface the page sits on, so a page on it is seamless), --ink (text), --ink-soft, --muted, --faint (quieter text),",
  "--sunken, --raised, --raised-high (surfaces below and above the ground; the ground may itself be raised, so separate regions with --line rather than a fill), --line, --line-soft (hairlines),",
  "--accent with --accent-ink on it and --accent-wash under it, --accent-2 (a second voice), --highlight,",
  "--ok, --warn, --danger, --diff-add, --diff-del, --code-bg,",
  "--chart-1 … --chart-6 (series colours for charts), --font-sans, --font-serif, --font-mono.",
  "A base stylesheet sets the html background, colour and font from these, zeroes the body margin and hides the page's scrollbar; your own CSS overrides it.",
  "They are for what belongs to the conversation (charts, diagrams, explainers); a mockup of the user's own product keeps that product's styles, inside a container of its own.",
].join(" ");

/** What the agent is told about where the page sits. */
export const PAGE_LAYOUT_GUIDE = [
  `The page sits borderless in the reply column, its left edge on your reply's: about ${PAGE_COLUMN_WIDTH}px wide by default, but as narrow as about ${PAGE_NARROWEST_WIDTH}px in the assistant panel or a narrow thread, and up to about ${PAGE_VIEWER_WIDTH}px when the reader opens it full size.`,
  "The same page is shown at every one of those widths, so it must hold at all of them: preview at the default and at the narrowest before showing it.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border or banner title: the page is part of your reply. A mocked-up screen or component may sit in a frame of its own (a window, a device, a canvas), since that frame is part of what you are showing.",
  "Leave the html and body backgrounds to the base stylesheet; never paint the page's own background.",
  "A chart drawn to scale (bars or lines sized from values) gets a fixed pixel plot height rather than one that scales with width.",
  "Anything that stacks or wraps (tiles, cards, rows, labels) sets its own height: never put it in a fixed-height box, since a narrower page wraps it taller and it spills over what sits below.",
  "A chart with one series uses one colour (--chart-1); give colours meaning, not one per bar. A zero or missing value draws no bar, only its label.",
  "Let content set the page's height: avoid 100vh and height:100% on html or body, since the frame grows to fit the page and a page sized by its frame never stops growing.",
].join(" ");

// ── the frame's protocol ─────────────────────────────────────────────────────

const HOST_CONTEXT_CHANGED = "ui/notifications/host-context-changed";
const SIZE_CHANGED = "ui/notifications/size-changed";
const OPEN_LINK = "ui/open-link";
// Not an MCP Apps method: a key the page left unhandled, for the app to act on
// as though it had landed on the app's own window.
const ESCAPE_PRESSED = "kone/escape-pressed";
const THEME_FRAGMENT_KEY = "kone-theme";

/** Only names a stylesheet can hold, and only values that cannot close the
 *  rule they are written into. */
function cleanVariables(variables: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (!/^--[a-z0-9-]+$/.test(name)) continue;
    const cleaned = String(value).replace(/[;{}<>]/g, "").trim();
    if (cleaned) out[name] = cleaned;
  }
  return out;
}

function withChartVariables(theme: PageTheme): PageTheme {
  return {
    appearance: theme.appearance,
    variables: cleanVariables({ ...PAGE_CHART_VARIABLES, ...theme.variables }),
  };
}

/** The fragment a frame's first load carries, so the page paints in the
 *  reader's theme rather than flashing a default before the first message. */
export function pageThemeFragment(theme: PageTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(withChartVariables(theme)))}`;
}

/** The message that re-themes an open page. */
export function pageThemeMessage(theme: PageTheme) {
  const { appearance, variables } = withChartVariables(theme);
  return {
    jsonrpc: "2.0" as const,
    method: HOST_CONTEXT_CHANGED,
    params: { theme: appearance, styles: { variables } },
  };
}

/** An http(s) URL, normalised, or null for anything a browser should not be
 *  handed from a page. */
function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const PageSizeMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(SIZE_CHANGED),
  params: z.object({ height: z.number().positive().finite() }),
});

const PageLinkMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(OPEN_LINK),
  params: z.object({ url: z.string() }),
});

const PageEscapeMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(ESCAPE_PRESSED),
});

/** What a page can say to the app: its height changed, it wants a link
 *  opened, or the reader pressed Escape and the page did nothing with it.
 *  Anything else a page posts parses as none of these and is ignored. */
export const PageFrameMessageSchema = z.union([
  PageSizeMessageSchema.transform((message) => ({ kind: "size" as const, height: message.params.height })),
  PageLinkMessageSchema.transform((message) => ({ kind: "link" as const, url: webUrl(message.params.url) })),
  PageEscapeMessageSchema.transform(() => ({ kind: "escape" as const })),
]);

export type PageFrameMessage = z.output<typeof PageFrameMessageSchema>;

// Sits under the page's own styles: it comes first in the head, so anything
// the page sets wins.
const BASE_CSS =
  "html{background:var(--ground);color:var(--ink);font-family:var(--font-sans,system-ui,sans-serif);" +
  "-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}";

// Runs before anything the page wrote. It themes the page from the URL
// fragment, re-themes it on the app's message, hands http(s) links to the app
// (a sandboxed frame cannot open a window of its own), reports the page's
// height whenever it changes, and passes on an Escape the page left unhandled,
// since a key pressed inside the frame never reaches the app's window. ES5 on purpose: it is the one script on the page
// the agent did not write and cannot fix.
const BOOTSTRAP_SCRIPT = `(function(){
var style=document.getElementById("kone-page-theme"),base=${JSON.stringify(BASE_CSS)},seq=0,last=-1;
if(!style)return;
function apply(t){
if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;
var css=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";
for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))css+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}
style.textContent=css+"}"+base;
}
style.textContent=base;
try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){apply(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}
if(window.parent===window)return;
window.addEventListener("message",function(e){
var d=e.data,p=d&&d.params;
if(e.source!==window.parent||!d||d.jsonrpc!=="2.0"||d.method!==${JSON.stringify(HOST_CONTEXT_CHANGED)}||!p||!p.styles)return;
apply({appearance:p.theme,variables:p.styles.variables});
});
document.addEventListener("click",function(e){
if(!e.isTrusted||e.defaultPrevented)return;
var path=e.composedPath(),a=null,u;
for(var i=0;i<path.length;i++){if(path[i]&&path[i].matches&&path[i].matches("a[href]")){a=path[i];break;}}
if(!a)return;
try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}
if(!/^https?:$/.test(u.protocol))return;
e.preventDefault();
window.parent.postMessage({jsonrpc:"2.0",id:"kone-link-"+(++seq),method:${JSON.stringify(OPEN_LINK)},params:{url:u.href}},"*");
},true);
document.addEventListener("keydown",function(e){
if(e.key!=="Escape"||e.defaultPrevented||e.isComposing)return;
window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(ESCAPE_PRESSED)}},"*");
});
function report(){
var r=document.documentElement,h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);
if(h===last)return;
last=h;
window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED)},params:{height:h}},"*");
}
var ro=window.ResizeObserver?new ResizeObserver(report):null;
if(ro)ro.observe(document.documentElement);
document.addEventListener("DOMContentLoaded",function(){if(ro&&document.body)ro.observe(document.body);report();});
window.addEventListener("load",report);
})();`;

const BOOTSTRAP_MARKUP = `<style id="kone-page-theme"></style><script>${BOOTSTRAP_SCRIPT}</script>`;

// Whatever may legally come before the page's first element of its own: a
// doctype, comments, and the html and head start tags. The bootstrap goes in
// straight after, ahead of anything the page itself runs or styles.
const DOCUMENT_PROLOGUE =
  /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<html\b[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<head\b[^>]*>)?/i;

/** The page as served: the agent's document with the bootstrap in front of
 *  everything it runs. A page with no head gets one implied around the
 *  bootstrap by the parser, as for any style before the body. */
export function injectPageBootstrap(html: string): string {
  const prologue = DOCUMENT_PROLOGUE.exec(html)?.[0] ?? "";
  return prologue + BOOTSTRAP_MARKUP + html.slice(prologue.length);
}

/** The policy a page is served under. `sandbox` puts it in an opaque origin
 *  even if it is ever loaded outside its frame, so it can reach neither the
 *  app nor another page. Remote scripts, styles and images load — a chart
 *  library from a CDN is the common case — but nothing local does. */
export const PAGE_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts allow-forms",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https:",
  "worker-src blob:",
  "frame-src https:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
