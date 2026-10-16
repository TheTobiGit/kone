// Dynamic visuals: what an agent shows inside its reply, written and read in
// one place.
//
// An agent that has something to show — a component, a screen, a chart, a
// diagram — writes it as one self-contained HTML document and hands it to the
// gateway's `visual_show` tool. The gateway stores the document as one of the
// thread's attachments and answers with a small record; the provider stores
// that answer against the call's item, and the renderer reads the record back
// to draw the visual in the turn, in a sandboxed frame on its own scheme. Three
// parties, so the record and the frame's protocol live here where none of them
// can change it alone.
//
// The frame and the app speak JSON-RPC over postMessage, in the method names
// of the MCP Apps extension, so a host for third-party MCP app views can reuse
// the frame as it is.

import { z } from "zod";

export const VISUAL_SHOW_TOOL_NAME = "visual_show";
export const VISUAL_PREVIEW_TOOL_NAME = "visual_preview";
/** What the show tool was called before visuals had their name. Threads
 *  recorded then still hold calls under it, and they still draw. */
const LEGACY_SHOW_TOOL_NAME = "page_show";

/** Whether a tool call by this name shows a visual. */
export function isVisualShowToolName(name: string): boolean {
  return name === VISUAL_SHOW_TOOL_NAME || name === LEGACY_SHOW_TOOL_NAME;
}

/** A turn that keeps showing visuals is almost certainly looping: past this
 *  many, the agent is told to combine them. */
export const VISUAL_MAX_PER_TURN = 6;

/** The scheme visuals are served on. Its own scheme, so a visual never shares an
 *  origin with the app or with the attachments the user uploaded. */
export const VISUAL_SCHEME = "kone-visual";

export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 2000;
export const VISUAL_MAX_TITLE_LENGTH = 200;
/** The document as the agent wrote it, before local images are inlined. */
export const VISUAL_MAX_HTML_LENGTH = 512_000;
/** The stored visual, inlined images included. */
export const VISUAL_MAX_STORED_BYTES = 16 * 1024 * 1024;
/** One inlined image. */
export const VISUAL_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The reply column's width at the default measure — what an agent previews at
 *  unless it asks for another. */
export const VISUAL_COLUMN_WIDTH = 680;
/** The narrowest a visual is shown at: the assistant panel, or a thread squeezed
 *  beside other panes. */
export const VISUAL_NARROWEST_WIDTH = 400;
/** About the widest a visual is shown at: the full-size view's card. */
export const VISUAL_VIEWER_WIDTH = 1140;
export const VISUAL_PREVIEW_MIN_WIDTH = 240;
export const VISUAL_PREVIEW_MAX_WIDTH = 1600;
/** The widths a visual is measured at when it is shown: the narrowest it is
 *  drawn, the reply column, and the full-size card. Between them the frame
 *  takes the taller of its neighbours, since a breakpoint anywhere in between
 *  can make the visual as tall as either. */
export const VISUAL_MEASURE_WIDTHS = [VISUAL_NARROWEST_WIDTH, VISUAL_COLUMN_WIDTH, VISUAL_VIEWER_WIDTH] as const;

export function clampVisualHeight(height: number): number {
  if (!Number.isFinite(height)) return VISUAL_MIN_HEIGHT;
  return Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(height)));
}

// ── the record a shown visual leaves behind ──────────────────────────────────

/** [width, height] as measured when the visual was shown, ascending by width. */
const MeasuredHeightsSchema = z
  .array(z.tuple([z.number().int().min(1).max(10_000), z.number().finite()]))
  .min(1)
  .max(8)
  .transform((heights) =>
    heights
      .map(([width, height]): [number, number] => [width, clampVisualHeight(height)])
      .sort((left, right) => left[0] - right[0]),
  );

const VisualRefSchema = z.object({
  attachmentId: z.string().regex(/^att_[0-9a-f-]+$/),
  title: z.string().min(1).max(VISUAL_MAX_TITLE_LENGTH),
  /** The frame's height before the visual has reported its own. */
  height: z.number(),
  /** The heights the visual needed at VISUAL_MEASURE_WIDTHS. Absent when the
   *  host could not render it off screen, or it took too long to. */
  heights: MeasuredHeightsSchema.optional(),
});

export type VisualRef = z.infer<typeof VisualRefSchema>;

const VisualShownSchema = z.union([
  z.object({
    visual: VisualRefSchema,
    /** What the model reading the result should do next. Never shown. */
    note: z.string(),
  }),
  // The record as it was written before visuals had their name.
  z.object({ page: VisualRefSchema, note: z.string() }).transform(({ page, note }) => ({ visual: page, note })),
]);

export type VisualShown = z.output<typeof VisualShownSchema>;

/** What the agent is told once its visual is up: where it can place it, and
 *  that the reader sees it, so a reply describing it says everything twice. */
export function visualShownNote(attachmentId: string): string {
  return (
    `Shown to the reader in this turn. To place it inside your reply, write this block on its own lines where it belongs, with your text before and after it:\n${visualEmbed(attachmentId)}\n` +
    "A visual you don't place stands above your reply. Don't announce, locate or restate the visual; reply with only what it doesn't already say."
  );
}

/** Encode a shown visual as the tool result text the item stores. */
export function formatVisualShown(visual: VisualRef): string {
  return JSON.stringify({ visual, note: visualShownNote(visual.attachmentId) } satisfies VisualShown);
}

/** The visual a result text records, or null for anything else — a failed
 *  call's error, a cancel, an in-progress input dump. */
export function parseVisualShown(text: string | null | undefined): VisualRef | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields whatever the text held; the zod schema below
    // is the only gate before the value is trusted.
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const result = VisualShownSchema.safeParse(parsed);
  if (!result.success) return null;
  return { ...result.data.visual, height: clampVisualHeight(result.data.visual.height) };
}

/** The taller of the heights measured at the nearest widths either side. */
function measuredHeightAt(heights: ReadonlyArray<readonly [number, number]>, width: number): number {
  const above = heights.findIndex(([measured]) => measured >= width);
  // Past the widest width measured, a visual only gets shorter.
  if (above === -1) return heights[heights.length - 1]![1];
  const high = above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/** The frame's height for a visual at a frame width: the height the visual
 *  reported once it has, else what it measured near this width when shown,
 *  else the height the agent gave. A visual even a few pixels taller than its
 *  frame scrolls inside the thread and takes the reader's scroll, so a
 *  reported height always wins. */
export function visualFrameHeight(visual: VisualRef, width: number, reported?: number): number {
  if (reported !== undefined) return clampVisualHeight(reported);
  if (visual.heights?.length) return clampVisualHeight(measuredHeightAt(visual.heights, width));
  return clampVisualHeight(visual.height);
}

/** Where the renderer loads a shown visual from. */
export function visualUrl(attachmentId: string): string {
  return `${VISUAL_SCHEME}://${attachmentId}/`;
}

// ── the theme a visual wears ───────────────────────────────────────────────────

/** The app's own variables, handed to the visual under the same names so a
 *  value written over another (`color-mix(… var(--ink) …)`) resolves inside
 *  the visual exactly as it does in the app. */
export const VISUAL_THEME_VARIABLES = [
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
  // Not the app's own variables: the reply's text size and leading, so a
  // visual's text sits at the size of the words around it.
  "--font-size",
  "--line-height",
] as const;

/** A chart needs more distinct series colours than the app has jobs for. These
 *  are drawn from the voices a theme already chose to set apart from each other,
 *  so a chart never introduces a hue the theme did not pick. */
export const VISUAL_CHART_VARIABLES: Readonly<Record<string, string>> = {
  "--chart-1": "var(--accent)",
  "--chart-2": "var(--accent-2)",
  "--chart-3": "var(--highlight)",
  "--chart-4": "var(--ok)",
  "--chart-5": "var(--danger)",
  "--chart-6": "var(--file)",
};

export type VisualAppearance = "light" | "dark";

export interface VisualTheme {
  appearance: VisualAppearance;
  variables: Record<string, string>;
}

/** What the agent is told about the variables, in the tool descriptions. */
export const VISUAL_THEME_GUIDE = [
  "kone sets its live theme on :root as CSS custom properties, and they follow the user's theme and light/dark switch while the visual is open:",
  "--ground (the exact surface the visual sits on, so a visual on it is seamless), --ink (text), --ink-soft, --muted, --faint (quieter text),",
  "--sunken, --raised, --raised-high (surfaces below and above the ground; the ground may itself be raised, so separate regions with --line rather than a fill), --line, --line-soft (hairlines),",
  "--accent with --accent-ink on it and --accent-wash under it, --accent-2 (a second voice), --highlight,",
  "--ok, --warn, --danger, --diff-add, --diff-del, --code-bg,",
  "--chart-1 … --chart-6 (series colours for charts), --font-sans, --font-serif, --font-mono, --font-size and --line-height (the reply's own text).",
  "A base stylesheet sets the html background, colour, font and size from these, zeroes the body margin and hides the visual's scrollbar.",
  "It also styles plain elements to match the reply: h1-h4, p, small, hr, tables, and buttons, inputs, selects, checkboxes and ranges with a visible focus ring. Helpers: class num right-aligns a number; muted is quieter text; button.primary is the one solid button; a .segmented group of buttons with aria-pressed is a segmented control; .tag with data-tone accent, ok, warn or danger is a status pill.",
  "Every base rule has no specificity, so your own CSS always wins. Respect prefers-reduced-motion; the base stylesheet stops animations for readers who ask.",
  "They are for what belongs to the conversation (charts, diagrams, explainers); a mockup of the user's own product keeps that product's styles, inside a container of its own.",
].join(" ");

/** What the agent is told about where the visual sits. */
export const VISUAL_LAYOUT_GUIDE = [
  `The visual sits borderless in the reply column, its left edge on your reply's: about ${VISUAL_COLUMN_WIDTH}px wide by default, but as narrow as about ${VISUAL_NARROWEST_WIDTH}px in the assistant panel or a narrow thread, and up to about ${VISUAL_VIEWER_WIDTH}px when the reader opens it full size.`,
  "The same visual is shown at every one of those widths, so it must hold at all of them: preview at the default and at the narrowest before showing it.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border or banner title: the visual is part of your reply. A mocked-up screen or component may sit in a frame of its own (a window, a device, a canvas), since that frame is part of what you are showing.",
  "Leave the html and body backgrounds to the base stylesheet; never paint the visual's own background.",
  "A chart drawn to scale (bars or lines sized from values) gets a fixed pixel plot height rather than one that scales with width.",
  "Anything that stacks or wraps (tiles, cards, rows, labels) sets its own height: never put it in a fixed-height box, since a narrower visual wraps it taller and it spills over what sits below.",
  "A chart with one series uses one colour (--chart-1); give colours meaning, not one per bar. A zero or missing value draws no bar, only its label.",
  "Let content set the visual's height: avoid 100vh and height:100% on html or body, since the frame grows to fit the visual and a visual sized by its frame never stops growing.",
].join(" ");

/** What the agent is told about choosing a form, in the tool descriptions: a
 *  named vocabulary, grouped by the shape it suits, so a visual is a choice
 *  rather than the bar chart or row of buttons an agent reaches for unasked. */
export const VISUAL_FORMS_GUIDE = [
  "Choose the form; don't default to one. Name the shape of what you show (flow, hierarchy, part-to-whole, distribution, change over time, ranking, correlation, place, process, a single value) and pick the form below that fits it best. Plain bar, line and pie charts and rows of rectangle buttons are for when they truly fit best, never the fallback.",
  "The vocabulary is for everything you show, not only data: an explainer can be an exploded view or step-by-step illustration, a flow a swimlane or transit map, a status a bullet graph or target diagram, a comparison a dumbbell, slope or butterfly chart.",
  "Mash forms up when it helps: a beeswarm on a timeline, a sankey feeding a treemap, a radial heat map ringed with sparklines. Be inventive in form, never in fact: marks stay to scale, labelled and readable at the narrowest width.",
  "Forms by shape.",
  "Flow and connection: Sankey Diagram, Alluvial Diagram, Parallel Sets, Chord Diagram, Non-ribbon Chord Diagram, Arc Diagram, Hive Plot, Network Visualisation, Sociogram, Clustered Force Layout, Radial Convergences, Matrix Diagram (plain, Roof Shaped, Y-Shaped).",
  "Hierarchy and part-to-whole: Treemap, Convex Treemap, Sunburst Diagram, Icicle Diagram, Dendrogram, Hyperbolic Tree, Organisational Chart, Fan Chart (Genealogy), Packed Circle Chart, Nested Proportional Area Chart, Proportional Area Chart (Square, Circle, Half Circle, Icon), Marimekko Chart, Waffle Chart, Stacked Bar Chart, Donut Chart, Semi Circle Donut Chart, Multi-level Donut Chart, Pie Chart, Multi-level Pie Chart, Compound Bubble and Pie Chart, Polar Area Chart, Venn Diagram, Euler Diagram, Funnel Chart, Pyramid Chart, Waterfall Chart.",
  "Distribution: Histogram, Radial Histogram, Spiral Histogram, Boxplot, Bagplot, Violin Plot, Beeswarm Plot, Strip Plot, Jitter Plot, Dot Plot, Counts Plot, Hanging Rootogram, Population Pyramid, Hexagonal Binning, Contour Plot, Ternary Contour Plot, Error Bars, Control Chart, Tally Chart.",
  "Change over time: Line Graph, Spline Graph, Stepped Line Graph, Trendline, Area Chart, Stacked Area Chart, Stacked Ordered Area Chart, Layered Area Chart, Range Area Chart, Stream Graph, Sorted Stream Graph, 3D Stream Graph, Radial Line Graph, Radial Area Chart, Timeline, Scaled Timeline, Bubble Timeline, Gantt Chart, Candlestick Chart, Kagi Chart, Renko Chart, Fan Chart (Time Series), Bump Chart, Slope Chart, Connected Scatter Plot, Circular Heat Map, Spiral Heat Map, Sparkline, Column Sparkline, Win-loss Sparkline, Waterfall Plot.",
  "Comparison and ranking: Bar Chart (Vertical, Horizontal), Grouped Bar Chart, Radial Bar Chart, Curved Bar Chart, Triangle Bar Chart, Multiple Series 3D Bar Chart, Lollipop Chart, Dot Chart, Dumbbell Plot, Column Range, Span Chart, Butterfly Chart, Opposite Diagram, Pareto Chart, Bullet Graph, Radar Diagram, Polar Chart, Parallel Coordinates, Comparison Chart, Table Chart, Heat Map, Bubble-based Heat Map, Chernoff Faces.",
  "Correlation: Scatter Plot, 3D Scatter Plot, Bubble Chart, Circular Bubble Chart, Cluster Analysis, Ternary Plot, Taylor Diagram, Phase Diagram, Nomogram.",
  "Place: Choropleth Map, Cartogram, Dot Density Map, Bubble Map, Pin Map, Bar Chart on a Map, Pie Chart on a Map, Flow Map, Connection Map, Route Map, Transit Map, Isoline Map, Topographic Map, Profile Map.",
  "Process and concept: Flow Chart, Swimlane Flow Chart, Process Diagram, Linear Process Diagram, Cycle Diagram, Mind Map, Fishbone Diagram, Development and Causes, SWOT Analysis, Pyramid Diagram, Target Diagram, Exploded View Drawing, Illustration Diagram, Step by Step Illustration, Word Cloud.",
  "Single values: Scaled-up Number, Icon and Number, Icon Count, Progress Bar, Angular Gauge, Solid Gauge Chart, Pictorial Percentage Chart, Pictorial Fraction Chart, Pictorial Unit Chart, Pictorial Stacked Chart, Pictorial Bar Chart.",
].join(" ");

// ── where a visual stands in the reply ───────────────────────────────────────

/** The info string of the fenced block an agent writes in its reply to put a
 *  visual there, naming it by its attachment id. */
export const VISUAL_EMBED_FENCE = "kone-visual";

/** The block an agent writes to place a visual. */
export function visualEmbed(attachmentId: string): string {
  return "```" + VISUAL_EMBED_FENCE + "\n" + attachmentId + "\n```";
}

/** A reply's text as it reads around the visuals it places. */
export type VisualTextPart = { kind: "text"; text: string } | { kind: "visual"; attachmentId: string };

const EMBED_ID = /^att_[0-9a-f-]+$/;

/** A run of fence characters that opens or closes a fenced code block: up to
 *  three spaces of indent, three or more matching backticks or tildes, then
 *  the info string. A backtick fence's info string may not itself hold a
 *  backtick, per Markdown, so such a line is ordinary text. */
interface FenceLine {
  char: "`" | "~";
  length: number;
  info: string;
}

function readFenceAt(rest: string): FenceLine | null {
  let indent = 0;
  while (indent < 3 && rest[indent] === " ") indent++;
  const char = rest[indent];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (rest[indent + length] === char) length++;
  if (length < 3) return null;
  const info = rest.slice(indent + length);
  if (char === "`" && info.includes("`")) return null;
  return { char, length, info };
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (line[count] === " ") count++;
  return count;
}

interface ContainerSplit {
  prefix: string;
  rest: string;
}

/** The line with any blockquote markers and one list marker in front taken
 *  off, so the code block a list item or quote opens is seen as such. */
function splitContainers(line: string): ContainerSplit {
  let rest = line;
  let prefix = "";
  for (;;) {
    const quote = /^ {0,3}>[ \t]?/.exec(rest);
    let next = quote ? rest.slice(quote[0].length) : rest;
    const list = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(next);
    if (list) next = next.slice(list[0].length);
    if (next === rest) return { prefix, rest };
    prefix += rest.slice(0, rest.length - next.length);
    rest = next;
  }
}

/** A fence a line opens, with the container prefix it sits in — null when the
 *  fence opens at the line's own start. */
interface OpenedFence {
  fence: FenceLine;
  prefix: string | null;
}

function openedFence(line: string): OpenedFence | null {
  const plain = readFenceAt(line);
  if (plain) return { fence: plain, prefix: null };
  const { prefix, rest } = splitContainers(line);
  if (!prefix) return null;
  const fence = readFenceAt(rest);
  return fence ? { fence, prefix } : null;
}

/** The fence a line closes `opener` with, or null. A fence opened at its own
 *  start closes only on one at its own start, so a blockquote or list line
 *  inside a top-level code block never ends it early. A fence opened inside a
 *  container closes on the same prefix, or — for a list, whose continuation
 *  lines drop the marker — on a fence indented to the container's width. */
function closingFence(line: string, opener: OpenedFence): FenceLine | null {
  if (opener.prefix === null) return readFenceAt(line);
  const { prefix, rest } = splitContainers(line);
  if (prefix === opener.prefix) return readFenceAt(rest);
  if (opener.prefix.includes(">")) return null;
  // A list's continuation lines drop the marker, so the closer is indented to
  // the container's width. Strip that indentation first: past three spaces a
  // fence is no longer read at the line's own start, but it is still the
  // closer of a fence the list opened.
  const indent = opener.prefix.length;
  return leadingSpaces(line) >= indent ? readFenceAt(line.slice(indent)) : null;
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

/** The text's lines, each with where it starts and where it ends (after its
 *  line break). A trailing line break adds no empty line. */
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    const body = text.slice(start, i);
    lines.push({ text: body.endsWith("\r") ? body.slice(0, -1) : body, start, end: i + 1 });
    start = i + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), start, end: text.length });
  return lines;
}

/** The index of the first line at or after `from` that closes `opener`: the
 *  same fence character, at least as long, and empty but for spaces or tabs. */
function closingFenceIndex(lines: ReadonlyArray<SourceLine>, from: number, opener: OpenedFence): number | null {
  for (let i = from; i < lines.length; i++) {
    const fence = closingFence(lines[i]!.text, opener);
    if (!fence || fence.char !== opener.fence.char || fence.length < opener.fence.length) continue;
    if (fence.info.trim() !== "") continue;
    return i;
  }
  return null;
}

/** Where the text before a held-back opener ends: the line's start, with the
 *  line break in front dropped too, so the kept prefix reads with no trailing
 *  blank line. */
function endBeforeFence(text: string, start: number): number {
  return start > 0 && text[start - 1] === "\n" ? start - 1 : start;
}

/** A reply split around the visuals it places. A fence whose body is not one
 *  attachment id stays in the text as the code block it is, and a fence inside
 *  an enclosing code block — an example in a longer fence, or one a list item
 *  or blockquote opens — is code, never a placement. An opener with no closer
 *  yet is held back, so a reply still arriving never shows the block as code
 *  before it becomes a visual; `streaming` also holds back a fence whose info
 *  string is still only the start of the visual fence. A placement is only
 *  read from a fence the line opens at its own start, so the standalone block
 *  the agent is told to write is the only shape that places a visual. */
export function splitVisualEmbeds(text: string, options: { streaming?: boolean } = {}): VisualTextPart[] {
  const parts: VisualTextPart[] = [];
  const lines = sourceLines(text);
  let cursor = 0;
  const flush = (end: number): void => {
    const before = text.slice(cursor, end);
    if (before.trim()) parts.push({ kind: "text", text: before });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const opened = openedFence(line.text);
    if (!opened) continue;
    const closing = closingFenceIndex(lines, index + 1, opened);
    if (closing !== null) {
      if (opened.prefix === null && opened.fence.info.trim() === VISUAL_EMBED_FENCE) {
        const id = text.slice(line.end, lines[closing]!.start).trim();
        if (EMBED_ID.test(id)) {
          flush(line.start);
          parts.push({ kind: "visual", attachmentId: id });
          cursor = lines[closing]!.end;
        }
      }
      index = closing;
      continue;
    }
    const info = opened.prefix === null ? opened.fence.info.trim() : null;
    const held =
      info !== null && (info === VISUAL_EMBED_FENCE || (options.streaming === true && VISUAL_EMBED_FENCE.startsWith(info)));
    if (held) {
      flush(endBeforeFence(text, line.start));
      cursor = text.length;
    }
    break;
  }
  const rest = text.slice(cursor);
  if (rest.trim()) parts.push({ kind: "text", text: rest });
  return parts;
}

/** The ids of the visuals a reply places, in order. */
export function placedVisualIds(text: string): string[] {
  return splitVisualEmbeds(text).flatMap((part) => (part.kind === "visual" ? [part.attachmentId] : []));
}

/** A reply's text without the blocks that place visuals: what it reads as
 *  where no visual can be drawn — a copy, an export, a one-line preview. */
export function stripVisualEmbeds(text: string): string {
  return splitVisualEmbeds(text)
    .flatMap((part) => (part.kind === "text" ? [part.text.trim()] : []))
    .join("\n\n");
}

// ── the frame's protocol ─────────────────────────────────────────────────────

const HOST_CONTEXT_CHANGED = "ui/notifications/host-context-changed";
const SIZE_CHANGED = "ui/notifications/size-changed";
const OPEN_LINK = "ui/open-link";
// Not MCP Apps methods. A key the visual left unhandled, for the app to act on
// as though it had landed on the app's own window: a key pressed inside the
// frame never reaches it otherwise. Escape is passed on alone; every other key
// only with Cmd or Ctrl held, since a plain key belongs to whatever the reader
// is typing into.
const ESCAPE_PRESSED = "kone/escape-pressed";
const KEY_PRESSED = "kone/key-pressed";
// An image the reader clicked, for the app's own viewer.
const OPEN_IMAGE = "kone/open-image";
// Sent by the stand-in served when the stored visual is gone.
const UNAVAILABLE = "kone/visual-unavailable";
const THEME_FRAGMENT_KEY = "kone-theme";
const MAX_LINK_LENGTH = 2048;

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

function withChartVariables(theme: VisualTheme): VisualTheme {
  return {
    appearance: theme.appearance,
    variables: cleanVariables({ ...VISUAL_CHART_VARIABLES, ...theme.variables }),
  };
}

/** The fragment a frame's first load carries, so the visual paints in the
 *  reader's theme rather than flashing a default before the first message. */
export function visualThemeFragment(theme: VisualTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(withChartVariables(theme)))}`;
}

/** The message that re-themes an open visual. */
export function visualThemeMessage(theme: VisualTheme) {
  const { appearance, variables } = withChartVariables(theme);
  return {
    jsonrpc: "2.0" as const,
    method: HOST_CONTEXT_CHANGED,
    params: { theme: appearance, styles: { variables } },
  };
}

/** An http(s) URL, normalised, or null for anything a browser should not be
 *  handed from a visual. */
function webUrl(raw: string): string | null {
  if (raw.length > MAX_LINK_LENGTH) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** An image source the app's viewer may draw: http(s), or an image inlined as
 *  a data: URI, which is how a visual carries the local images it named. */
function imageSource(raw: string): string | null {
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(raw) ? raw : webUrl(raw);
}

const VisualSizeMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(SIZE_CHANGED),
  params: z.object({ height: z.number().positive().finite() }),
});

const VisualLinkMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(OPEN_LINK),
  params: z.object({ url: z.string() }),
});

const VisualEscapeMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(ESCAPE_PRESSED),
});

const VisualKeyMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(KEY_PRESSED),
  params: z.object({
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    metaKey: z.boolean(),
    ctrlKey: z.boolean(),
    altKey: z.boolean(),
    shiftKey: z.boolean(),
  }),
});

const VisualImageMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(OPEN_IMAGE),
  params: z.object({ src: z.string(), alt: z.string().optional() }),
});

const VisualUnavailableMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(UNAVAILABLE),
});

/** What a visual's chord looks like to the app: the keys and the modifiers. */
export type VisualKeyPress = z.output<typeof VisualKeyMessageSchema>["params"];

/** What a visual can say to the app: its height changed, it wants a link or
 *  an image opened, the reader pressed a key the visual did nothing with, or
 *  the stored visual is gone. Anything else a visual posts parses as none of
 *  these and is ignored. */
export const VisualFrameMessageSchema = z.union([
  VisualSizeMessageSchema.transform((message) => ({ kind: "size" as const, height: message.params.height })),
  VisualLinkMessageSchema.transform((message) => ({ kind: "link" as const, url: webUrl(message.params.url) })),
  VisualEscapeMessageSchema.transform(() => ({ kind: "escape" as const })),
  VisualKeyMessageSchema.transform((message) => ({ kind: "key" as const, press: message.params })),
  VisualImageMessageSchema.transform((message) => ({
    kind: "image" as const,
    src: imageSource(message.params.src),
    alt: (message.params.alt ?? "").trim().slice(0, VISUAL_MAX_TITLE_LENGTH),
  })),
  VisualUnavailableMessageSchema.transform(() => ({ kind: "unavailable" as const })),
]);

export type VisualFrameMessage = z.output<typeof VisualFrameMessageSchema>;

// Sits under the visual's own styles: it comes first in the head, and every
// rule past the root ones is wrapped in :where(), which has no specificity, so
// anything the visual sets wins. Plain elements look like the reply around the
// frame, so a visual reads as part of it without a design system of its own.
const BASE_CSS =
  "html{background:var(--ground);color:var(--ink);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-size,14px);line-height:var(--line-height,1.6);" +
  "-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}:where(code,kbd,pre,samp){font-family:var(--font-mono,ui-monospace,monospace)}" +
  ":where(h1,h2,h3,h4){margin:0 0 .5em;font-weight:600;line-height:1.3}:where(h1){font-size:1.29em}:where(h2){font-size:1.14em}:where(h3){font-size:1.04em}:where(h4){font-size:.96em;color:var(--ink-soft)}" +
  ":where(p){margin:0 0 .75em}:where(p:last-child){margin-bottom:0}:where(small){font-size:.86em}:where(small,.muted){color:var(--muted)}:where(hr){border:0;border-top:1px solid var(--line-soft);margin:1em 0}" +
  ":where(table){border-collapse:collapse;font-variant-numeric:tabular-nums}:where(th){font-size:.86em;font-weight:500;color:var(--muted);text-align:left}" +
  ":where(th,td){padding:.45em 1.25em .45em 0;border-bottom:1px solid var(--line-soft)}:where(th:last-child,td:last-child){padding-right:0}:where(tbody tr:last-child>td){border-bottom:0}" +
  // After the table rules, so a numeric header lines up with its column.
  ":where(.num){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
  ":where(button,input,select,textarea){font:inherit;color:inherit}" +
  ":where(button,select,input:not([type=checkbox],[type=radio],[type=range],[type=color])){box-sizing:border-box;min-height:2.15em;padding:0 .75em;border:1px solid var(--line);border-radius:8px;background:transparent}" +
  ":where(button){display:inline-flex;align-items:center;justify-content:center;gap:.4em;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s}:where(button:hover){background:var(--hover)}" +
  ":where(button[aria-pressed=true]){background:var(--selected)}:where(button.primary){background:var(--accent);color:var(--accent-ink);border-color:transparent}" +
  ":where(button,input,select,textarea):where(:disabled){opacity:.5;cursor:default}:where(input[type=checkbox],input[type=radio],input[type=range],progress){accent-color:var(--accent)}:where(label){display:inline-flex;align-items:center;gap:.5em}" +
  ":where(.segmented){display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--chip)}:where(.segmented>button){min-height:calc(2.15em - 4px);border-color:transparent;background:transparent;color:var(--muted)}" +
  ":where(.segmented>button[aria-pressed=true]){background:var(--raised-high);color:var(--ink);border-color:var(--line-soft)}" +
  ":where(.tag){display:inline-flex;align-items:center;gap:.3em;padding:.05em .6em;border-radius:999px;font-size:.86em;font-weight:500;white-space:nowrap;background:var(--chip);color:var(--ink-soft)}" +
  ":where(.tag[data-tone=accent]){background:color-mix(in srgb,var(--accent) 14%,transparent);color:color-mix(in srgb,var(--accent) 80%,var(--ink))}" +
  ":where(.tag[data-tone=ok]){background:color-mix(in srgb,var(--ok) 14%,transparent);color:color-mix(in srgb,var(--ok) 72%,var(--ink))}" +
  ":where(.tag[data-tone=warn]){background:color-mix(in srgb,var(--warn) 16%,transparent);color:color-mix(in srgb,var(--warn) 64%,var(--ink))}" +
  ":where(.tag[data-tone=danger]){background:color-mix(in srgb,var(--danger) 14%,transparent);color:color-mix(in srgb,var(--danger) 76%,var(--ink))}" +
  // Inset, so the frame's edge never clips the ring of a control against it.
  ":where(:focus-visible){outline:2px solid var(--focus);outline-offset:-2px}" +
  // An image outside a link or button opens in the app's viewer.
  ":where(img:not(a[href] img,button img)){cursor:zoom-in}" +
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}";

// Runs before anything the visual wrote. It themes the visual from the URL
// fragment and re-themes it on the app's message; stands in an in-memory
// storage where the opaque origin refuses the real one, so a script (or a
// chart library) that reaches for localStorage keeps running instead of
// throwing; hands http(s) links to the app (a sandboxed frame cannot open a
// window of its own) and a clicked image to the app's viewer; reports the
// visual's height whenever it changes; and passes on Escape, and Cmd/Ctrl
// chords, the visual left unhandled, since a key pressed inside the frame never
// reaches the app's window. The click and key listeners sit on the window in
// the bubbling phase, so the visual's own handlers run first and can keep a
// key or click for themselves. ES5 on purpose: it is the one script in the
// visual the agent did not write and cannot fix.
const BOOTSTRAP_SCRIPT = `(function(){
var style=document.getElementById("kone-visual-theme"),base=${JSON.stringify(BASE_CSS)},seq=0,last=-1;
if(!style)return;
function apply(t){
if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;
var css=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";
for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))css+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}
style.textContent=css+"}"+base;
}
style.textContent=base;
try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){apply(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}
function memory(){var items={};return{get length(){return Object.keys(items).length;},key:function(i){var k=Object.keys(items);return i>=0&&i<k.length?k[i]:null;},getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(items,k)?items[k]:null;},setItem:function(k,v){items[String(k)]=String(v);},removeItem:function(k){delete items[String(k)];},clear:function(){items={};}};}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("");}catch(e){try{Object.defineProperty(window,n,{value:memory(),configurable:true});}catch(x){}}});
if(window.parent===window)return;
function post(msg){window.parent.postMessage(msg,"*");}
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
post({jsonrpc:"2.0",id:"kone-link-"+(++seq),method:${JSON.stringify(OPEN_LINK)},params:{url:u.href}});
},true);
window.addEventListener("click",function(e){
if(!e.isTrusted||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var t=e.target;
if(!t||t.tagName!=="IMG"||(t.closest&&t.closest("a[href],button")))return;
var src=t.currentSrc||t.src;
if(src)post({jsonrpc:"2.0",method:${JSON.stringify(OPEN_IMAGE)},params:{src:src,alt:t.alt||""}});
});
window.addEventListener("keydown",function(e){
if(!e.isTrusted||e.defaultPrevented||e.isComposing)return;
if(e.key==="Escape"){post({jsonrpc:"2.0",method:${JSON.stringify(ESCAPE_PRESSED)}});return;}
if(!e.metaKey&&!e.ctrlKey)return;
if(e.key==="Meta"||e.key==="Control"||e.key==="Alt"||e.key==="Shift")return;
post({jsonrpc:"2.0",method:${JSON.stringify(KEY_PRESSED)},params:{key:String(e.key).slice(0,32),code:String(e.code).slice(0,32),metaKey:e.metaKey,ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey}});
});
function report(){
var r=document.documentElement,h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);
if(h===last)return;
last=h;
post({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED)},params:{height:h}});
}
var ro=window.ResizeObserver?new ResizeObserver(report):null;
if(ro)ro.observe(document.documentElement);
document.addEventListener("DOMContentLoaded",function(){if(ro&&document.body)ro.observe(document.body);report();});
window.addEventListener("load",report);
})();`;

const BOOTSTRAP_MARKUP = `<style id="kone-visual-theme"></style><script>${BOOTSTRAP_SCRIPT}</script>`;

// Whatever may legally come before the visual's first element of its own: a
// doctype, comments, and the html and head start tags. The bootstrap goes in
// straight after, ahead of anything the visual itself runs or styles.
const DOCUMENT_PROLOGUE =
  /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<html\b[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<head\b[^>]*>)?/i;

/** The visual as served: the agent's document with the bootstrap in front of
 *  everything it runs. A visual with no head gets one implied around the
 *  bootstrap by the parser, as for any style before the body. */
export function injectVisualBootstrap(html: string): string {
  const prologue = DOCUMENT_PROLOGUE.exec(html)?.[0] ?? "";
  return prologue + BOOTSTRAP_MARKUP + html.slice(prologue.length);
}

/** Served in place of a visual whose stored document is gone, so the frame
 *  showing it can say so in the app's own words instead of drawing a bare
 *  "Not found". */
export const VISUAL_UNAVAILABLE_HTML = `<!doctype html><script>window.parent!==window&&window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(UNAVAILABLE)}},"*")</script>`;

/** The policy a visual is served under. `sandbox` puts it in an opaque origin
 *  even if it is ever loaded outside its frame, so it can reach neither the
 *  app nor another visual. Remote scripts, styles and images load — a chart
 *  library from a CDN is the common case — but nothing local does. */
export const VISUAL_CONTENT_SECURITY_POLICY = [
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
