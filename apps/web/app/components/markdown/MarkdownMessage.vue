<script setup lang="ts">
import { computed, defineComponent, Fragment, h, onBeforeUnmount, ref, watch } from "vue";
import type { VNode } from "vue";
import type Token from "markdown-it/lib/token.mjs";
import { createStreamGate } from "~/composables/streamGate";
import { stabilizeStreamingMarkdown } from "~/utils/streamingMarkdown";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  InformationCircleIcon,
  Idea01Icon,
  AlertCircleIcon,
  Alert02Icon,
  AlertDiamondIcon,
} from "@hugeicons/core-free-icons";
import CodeBlock from "~/components/markdown/CodeBlock.vue";
import MarkdownLink from "~/components/markdown/MarkdownLink.vue";
import MarkdownImage from "~/components/markdown/MarkdownImage.vue";
import FileChip from "~/components/git-space/FileChip.vue";
import { expandHtmlTables, validatedSpans, type MdNode } from "~/utils/safeHtmlTable";

// The agent's settled reply, rendered as a real component tree rather than a
// v-html string. We parse the Markdown to markdown-it's token stream, fold it
// into a small node tree, and walk that with `h()` — which lets a fenced block
// become a syntax-highlighted <CodeBlock>, a web link wear its favicon, a path
// in backticks turn into a file chip, and an image settle into a framed figure.
// Everything else (headings, lists, tables, quotes, emphasis) renders as plain
// semantic elements styled below via `.md :deep(...)`.

// `historical` marks a reply loaded from storage: it mounts already-complete, so
// it skips the per-word crossfade reveal (and the extra span-per-word
// nodes) and just renders as settled text — no animation replay on reopen.
const props = defineProps<{
  source: string;
  historical?: boolean;
  /** Hold the first words back this long before they start to show. For a
   *  reply that mounts while something above it is still settling — the
   *  batch of steps folding shut as the text takes over — so the words fade
   *  in where they will stay instead of riding the fold up the column. */
  revealDelay?: number;
}>();

const { parse } = useMarkdown();

const tokens = ref<Token[] | null>(null);
let seq = 0;

// Live replies reparse at most once per gate window while chunks stream in;
// the trailing run flushes the exact final source within one window of the
// stream stopping. History and the first paint bypass the gate entirely.
const gate = createStreamGate(45);

// A live reply is parsed as it will read once finished — half-typed block
// markers held back, open inline marks closed — so it doesn't reshape under
// the reader chunk by chunk. History is already finished and parses as-is.
async function updateTokens(src: string): Promise<void> {
  const mine = ++seq;
  const t = await parse(props.historical ? src : stabilizeStreamingMarkdown(src));
  if (mine === seq) tokens.value = t;
}

watch(
  () => props.source,
  (src) => {
    if (props.historical || !tokens.value || !import.meta.client) {
      gate.cancel();
      void updateTokens(src);
      return;
    }
    gate.request(() => void updateTokens(src));
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  // Kill any scheduled parse; bumping seq also strands one already in flight.
  gate.cancel();
  seq++;
});

// Every word gets its own stable key, so a streamed word mounts as a genuinely
// new element the instant it arrives — and resolves into place on mount, driven
// by real arrival time: each word's crossfade fires when it lands, one after
// another as the reply grows, with only the words of a single chunk spread
// out behind each other (see the burst stagger below). A fully-formed message
// (history) renders as plain text and plays nothing.
//
// The key is the word's PATH in the tree (`0.2.1w4`), not its ordinal in a
// running counter. Live Markdown is reparsed from scratch on every chunk, and a
// counter makes every key downstream of a structural change shift by one — so
// the moment `**bo` closed into `**bold**`, or a `|` row snapped into a table,
// the whole rest of the reply was torn down, remounted, and re-revealed. Words
// keyed by path only churn inside the subtree that actually changed.

// ── token stream → node tree ────────────────────────────────────────────────
// markdown-it hands a flat list with nesting encoded as open/close pairs. Fold
// it into a tree; inline tokens carry their own child list, so recurse in. The
// node shape itself lives in safeHtmlTable — that module builds nodes too, and
// a table lifted out of raw text has to be the same thing to the renderer.
function mkNode(tok: Token): MdNode {
  const attrs: Record<string, string> = {};
  for (const [k, v] of tok.attrs ?? []) attrs[k] = v;
  return {
    type: tok.type.replace(/_open$/, ""),
    tag: tok.tag,
    attrs,
    children: [],
    content: tok.content,
    info: tok.info,
  };
}
function treeify(list: Token[]): MdNode[] {
  const root: MdNode = { type: "root", tag: "", attrs: {}, children: [], content: "", info: "" };
  const stack: MdNode[] = [root];
  for (const tok of list) {
    const top = stack[stack.length - 1]!;
    if (tok.type === "inline") {
      top.children.push(...treeify(tok.children ?? []));
      continue;
    }
    if (tok.nesting === 1) {
      const node = mkNode(tok);
      top.children.push(node);
      stack.push(node);
    } else if (tok.nesting === -1) {
      stack.pop();
    } else {
      top.children.push(mkNode(tok));
    }
  }
  return root.children;
}

const nodes = computed<MdNode[]>(() =>
  tokens.value ? expandHtmlTables(treeify(tokens.value)) : [],
);

// ── heuristics ────────────────────────────────────────────────────────────────
// Inline code that names a file → render as a file chip. Needs an extension on
// the tail (or a recognised extensionless name); no whitespace; not a URL.
const KNOWN_FILES = /^(dockerfile|makefile|readme|license|\.env(\.\w+)?|\.gitignore|\.npmrc)$/i;
function looksLikePath(raw: string): boolean {
  const t = raw.trim();
  if (!t || /\s/.test(t) || t.length > 120) return false;
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) return false; // url / scheme
  if (/^(and|or|either|neither)\//i.test(t)) return false; // "and/or"
  const tail = t.split("/").pop()!;
  const hasExt = /\.[a-z][a-z0-9]{0,7}$/i.test(tail);
  return (hasExt && /^[\w@./+-]+$/.test(t)) || KNOWN_FILES.test(tail);
}

// GitHub-style blockquote callouts: `> [!NOTE]` and friends.
const CALLOUTS: Record<string, { label: string; icon: unknown }> = {
  note: { label: "Note", icon: InformationCircleIcon },
  tip: { label: "Tip", icon: Idea01Icon },
  important: { label: "Important", icon: AlertCircleIcon },
  warning: { label: "Warning", icon: Alert02Icon },
  caution: { label: "Caution", icon: AlertDiamondIcon },
};
/** If a blockquote opens with a `[!KIND]` marker, peel it off and return the
 *  callout kind plus the remaining content nodes; otherwise null. */
function asCallout(quote: MdNode): { kind: string; body: MdNode[] } | null {
  const first = quote.children[0];
  if (!first || first.type !== "paragraph") return null;
  const lead = first.children[0];
  if (!lead || lead.type !== "text") return null;
  const m = /^\[!(note|tip|important|warning|caution)\]\s*/i.exec(lead.content);
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  // Rebuild the first paragraph without the marker (and a trailing line break).
  const inlines = first.children.slice();
  const rest = lead.content.slice(m[0].length);
  if (rest) inlines[0] = { ...lead, content: rest };
  else {
    inlines.shift();
    if (inlines[0]?.type === "softbreak" || inlines[0]?.type === "hardbreak") inlines.shift();
  }
  const body = quote.children.slice(1);
  if (inlines.length) body.unshift({ ...first, children: inlines });
  return { kind, body };
}

// ── render ──────────────────────────────────────────────────────────────────
function renderChildren(node: MdNode, path: string): (VNode | string)[] {
  return node.children.map((c, i) => renderNode(c, i, `${path}.${i}`));
}
/** The plain-text run inside an inline subtree (for a link's visible label). */
function textOf(node: MdNode): string {
  return node.children
    .map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : textOf(c)))
    .join("");
}
function styleOf(node: MdNode): Record<string, string> | undefined {
  return node.attrs.style ? { textAlign: /right/.test(node.attrs.style) ? "right" : /center/.test(node.attrs.style) ? "center" : "left" } : undefined;
}
// Only colspan/rowspan survive the table parse, and cells read them back
// through the very validator that wrote them (`validatedSpans`) — anything else
// never becomes a node attr, so there is nothing else to pass on.

// ── the stagger inside a streamed chunk ─────────────────────────────────────
// A stream arrives in bursts, not a word at a time: one chunk can carry a
// dozen words, and mounting them on the same frame makes the reply lurch
// forward a phrase at a time. So the words that arrive together are spread
// out behind one another, `per-word-crossfade` style. The spacing adapts to
// the burst — a few words step at the full interval, a paragraph-sized chunk
// shares a fixed window — so a big chunk never queues up behind itself while
// the next one is already arriving.
const WORD_STAGGER_MS = 22;
const BURST_WINDOW_MS = 280;
/** Each word's delay, kept for as long as the word keeps its key, so a reparse
 *  of the same text hands a word the delay it already played with. */
const wordDelays = new Map<string, number>();
/** Style objects of the words first seen in the current render pass, filled
 *  in once the pass knows how many there are — before the patch reads them. */
let burst: { key: string; style: Record<string, string> }[] = [];

/** When the hold ends — a moment in time rather than a delay on the first
 *  burst, because the next chunks land well inside the hold too, and a word
 *  from the second burst showing before one from the first reads as noise. */
const holdUntil = import.meta.client ? performance.now() + (props.revealDelay ?? 0) : 0;

function settleBurst(): void {
  if (!burst.length) return;
  const step = Math.min(WORD_STAGGER_MS, BURST_WINDOW_MS / burst.length);
  const lead = import.meta.client ? Math.max(0, Math.round(holdUntil - performance.now())) : 0;
  burst.forEach((w, i) => {
    const delay = lead + Math.round(i * step);
    wordDelays.set(w.key, delay);
    w.style.transitionDelay = `${delay}ms`;
  });
  burst = [];
}

// ── words already on screen ─────────────────────────────────────────────────
// A reparse can re-key words that were already showing: `**bo` closing into
// `**bold**` splits one text run into three, a line becoming a list item moves
// it into a new subtree. Those words are new elements to Vue but not new to the
// reader, and fading them in again is what made a streaming reply blink. So the
// reveal is decided by position rather than by mount: each render walks the
// text in reading order, and only words past the furthest point any earlier
// render reached are allowed to play. Everything before it mounts settled.
let revealedTo = 0;
let walked = 0;

function wordStyle(key: string): Record<string, string> {
  const known = wordDelays.get(key);
  if (known !== undefined) return { transitionDelay: `${known}ms` };
  const style: Record<string, string> = {};
  burst.push({ key, style });
  return style;
}

/** Split a text run into words wrapped in individually-keyed spans (so each
 *  one mounts as its own DOM node and can carry the crossfade reveal),
 *  with whitespace passed through untouched between them. */
function renderWords(content: string, key: number, path: string): VNode | string {
  // History: render the run as plain text — no per-word spans, no reveal.
  if (props.historical) return content;
  const parts = content.split(/(\s+)/);
  return h(
    Fragment,
    { key },
    parts.map((part, i) => {
      const start = walked;
      walked += part.length;
      if (/^\s*$/.test(part)) return part;
      const wordKey = `${path}w${i}`;
      if (start < revealedTo && !wordDelays.has(wordKey)) {
        return h("span", { key: wordKey, class: "stream-word stream-word--seen" }, part);
      }
      return h("span", { key: wordKey, class: "stream-word", style: wordStyle(wordKey) }, part);
    }),
  );
}

/** Keep inline atoms separate from the per-word reveal. Markdown is reparsed on
 *  every streamed update, so an atom can be replaced while its surrounding text
 *  grows; replaying `@starting-style` here makes file tags visibly blink. */
function wrapAtom(vnode: VNode, key: number): VNode {
  if (props.historical) return vnode;
  return h("span", { key, class: "stream-atom" }, [vnode]);
}

function renderNode(node: MdNode, key: number, path: string): VNode | string {
  switch (node.type) {
    case "text":
      return renderWords(node.content, key, path);
    case "softbreak":
      return " ";
    case "hardbreak":
      return h("br", { key });
    case "fence":
    case "code_block":
      return h(CodeBlock, { key, code: node.content, info: node.info });
    case "code_inline":
      return wrapAtom(
        looksLikePath(node.content)
          ? h(FileChip, { key, path: node.content.trim() })
          : h("code", { key }, node.content),
        key,
      );
    case "image":
      return h(MarkdownImage, { key, src: node.attrs.src ?? "", alt: node.content || node.attrs.alt });
    case "link": {
      const href = node.attrs.href ?? "#";
      // A local file link (`[README.md](file:///…)`) becomes an inert file chip
      // — a reference, not a navigation — showing the label with its file glyph
      // and the full path on hover. No favicon, no new tab, no dumped URL.
      if (/^file:\/\//i.test(href)) {
        const full = decodeURIComponent(href.replace(/^file:\/\/(localhost)?/i, ""));
        const label = textOf(node).trim();
        return wrapAtom(h(FileChip, { key, path: label || full.split("/").pop() || full, title: full }), key);
      }
      return h(MarkdownLink, { key, href }, { default: () => renderChildren(node, path) });
    }
    case "heading":
      return h(node.tag, { key }, renderChildren(node, path));
    case "paragraph":
      return h("p", { key }, renderChildren(node, path));
    case "blockquote":
      return renderQuote(node, key, path);
    case "bullet_list":
      return h("ul", { key }, renderChildren(node, path));
    case "ordered_list":
      return h("ol", { key, start: node.attrs.start }, renderChildren(node, path));
    case "list_item":
      return renderListItem(node, key, path);
    case "table":
      return h("div", { key, class: "md-table" }, [h("table", null, renderChildren(node, path))]);
    case "th":
      return h("th", { key, style: styleOf(node), ...validatedSpans(node.attrs) }, renderChildren(node, path));
    case "td":
      return h("td", { key, style: styleOf(node), ...validatedSpans(node.attrs) }, renderChildren(node, path));
    case "hr":
      return h("hr", { key });
    case "strong":
      return h("strong", { key }, renderChildren(node, path));
    case "em":
      return h("em", { key }, renderChildren(node, path));
    case "s":
      return h("s", { key }, renderChildren(node, path));
    case "html_block":
    case "html_inline":
      // Raw tables are lifted into real table nodes upstream; whatever HTML
      // reaches here has no table in it and stays inert text.
      return node.content;
    default:
      return node.tag
        ? h(node.tag, { key }, renderChildren(node, path))
        : h(Fragment, { key }, renderChildren(node, path));
  }
}

function renderQuote(node: MdNode, key: number, path: string): VNode {
  const callout = asCallout(node);
  if (!callout) return h("blockquote", { key }, renderChildren(node, path));
  const meta = CALLOUTS[callout.kind]!;
  return h("div", { key, class: ["callout", `callout--${callout.kind}`] }, [
    h("div", { class: "callout__head" }, [
      h(HugeiconsIcon, { icon: meta.icon, size: 15, strokeWidth: 2, class: "callout__icon" }),
      h("span", { class: "callout__label" }, meta.label),
    ]),
    h(
      "div",
      { class: "callout__body" },
      callout.body.map((c, i) => renderNode(c, i, `${path}.q${i}`)),
    ),
  ]);
}

// Task-list items: a leading `[ ]` / `[x]` in the first paragraph becomes a
// checkbox, and a checked item dims + strikes through.
function renderListItem(node: MdNode, key: number, path: string): VNode {
  const para = node.children[0];
  const lead = para?.type === "paragraph" ? para.children[0] : undefined;
  const m = lead?.type === "text" ? /^\[( |x|X)\]\s+/.exec(lead.content) : null;
  if (para && lead && m) {
    const checked = m[1]!.toLowerCase() === "x";
    const inlines = para.children.slice();
    inlines[0] = { ...lead, content: lead.content.slice(m[0].length) };
    const rest = node.children.slice(1);
    return h("li", { key, class: ["md-task", checked && "md-task--done"] }, [
      h("span", { class: ["md-check", checked && "md-check--on"], "aria-hidden": "true" }, checked ? "✓" : ""),
      h("div", { class: "md-task__body" }, [
        h(
          "p",
          null,
          inlines.map((c, i) => renderNode(c, i, `${path}.t${i}`)),
        ),
        ...rest.map((c, i) => renderNode(c, i + 100, `${path}.r${i}`)),
      ]),
    ]);
  }
  return h("li", { key }, renderChildren(node, path));
}

const Rendered = defineComponent({
  name: "MarkdownRendered",
  render: () => {
    burst = [];
    walked = 0;
    const tree = nodes.value.map((n, i) => renderNode(n, i, String(i)));
    settleBurst();
    revealedTo = Math.max(revealedTo, walked);
    return tree;
  },
});
</script>

<template>
  <div class="md">
    <Rendered v-if="tokens" />
    <p v-else class="md__raw">{{ source }}</p>
  </div>
</template>

<style scoped>
.md {
  font-size: 14px;
  line-height: 23px;
  color: var(--ink);
}
.md__raw {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Each word fades up into place as it mounts — a `per-word-crossfade`: 700ms,
   opacity with a short vertical drift. Streamed words each land at their own
   real moment, so the stagger is the stream itself and none is added here; a
   fully-formed message mounts its words in one tick and settles together.
   The 8px drift drops to 2px on 14px copy: a chunk's words rise together, and
   at any more travel the line itself reads as moving under the reader. No overshoot and no
   blur: a spring made a paragraph bounce and a blur smeared it; the text
   should read crisp from its first frame. inline-block is required —
   transforms don't apply to `display: inline`. No will-change: it would pin a
   layer per word long after the word settled. */
.md :deep(.stream-word) {
  display: inline-block;
  transition:
    opacity 700ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 700ms cubic-bezier(0.16, 1, 0.3, 1);
}
/* An atom's wrapper (file chip / inline code) has no box of its own, so the
   line lays out exactly as it will in history, where there is no wrapper. As
   an inline-flex box it stood taller than the 23px line — the code's own
   padding counted — and every line an atom landed on grew by a pixel,
   nudging the text below it. Atoms intentionally do not carry
   `.stream-word`: reparsing a live Markdown message must not replay their
   entrance animation. */
.md :deep(.stream-atom) {
  display: contents;
}
@starting-style {
  .md :deep(.stream-word:not(.stream-word--seen)) {
    opacity: 0;
    transform: translateY(2px);
  }
}

/* ── blocks ─────────────────────────────────────────────────────────────────── */
.md :deep(p) { margin: 0 0 12px; }
.md :deep(> :last-child) { margin-bottom: 0; }

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 18px 0 8px;
  font-weight: 640;
  line-height: 1.32;
  letter-spacing: -0.012em;
  color: var(--ink);
}
.md :deep(h1) { font-size: 18px; }
.md :deep(h2) { font-size: 16px; }
.md :deep(h3) { font-size: 14.5px; }
.md :deep(h4) { font-size: 13.5px; color: var(--ink-soft); }
.md :deep(h1:first-child),
.md :deep(h2:first-child),
.md :deep(h3:first-child) { margin-top: 0; }

.md :deep(strong) { font-weight: 640; color: var(--ink); }
.md :deep(em) { font-style: italic; }
.md :deep(s) { color: var(--muted); }

/* ── lists ──────────────────────────────────────────────────────────────────── */
/* The app reset strips list-style; re-assert markers explicitly. */
.md :deep(ul),
.md :deep(ol) { margin: 0 0 12px; padding-left: 24px; }
.md :deep(ul) { list-style: disc; }
.md :deep(ol) { list-style: decimal; }
.md :deep(ul ul) { list-style: circle; }
.md :deep(ul ul ul) { list-style: square; }
.md :deep(li) { margin: 4px 0; padding-left: 3px; }
.md :deep(li::marker) { color: var(--muted); }
.md :deep(ul ul),
.md :deep(ol ol),
.md :deep(ul ol),
.md :deep(ol ul) { margin: 4px 0 0; }

/* Task lists — checkbox + text, no bullet. */
.md :deep(ul:has(> .md-task)) { list-style: none; padding-left: 2px; }
.md :deep(.md-task) {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 5px 0;
}
.md :deep(.md-task__body) { min-width: 0; }
.md :deep(.md-task__body p) { margin: 0; }
.md :deep(.md-check) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 17px;
  height: 17px;
  margin-top: 4px;
  border-radius: 5px;
  background: var(--hover);
  font-size: 11px;
  line-height: 1;
  color: transparent;
}
.md :deep(.md-check--on) {
  background: color-mix(in oklab, var(--accent) 88%, transparent);
  color: #fff;
}
.md :deep(.md-task--done .md-task__body) { color: var(--muted); text-decoration: line-through; }

/* ── inline code ────────────────────────────────────────────────────────────── */
/* Inline code only: a fenced block's `pre > code` keeps its own reset (no chip
   padding, no tint, full mono size). Without the guard this rule pierces the
   fence and fights that reset depending on bundle order. */
.md :deep(:not(pre) > code) {
  font-family: var(--font-mono);
  font-size: 0.855em;
  padding: 0.1em 0.38em;
  border-radius: 5px;
  background: var(--hover);
  overflow-wrap: anywhere;
}

/* ── blockquote ─────────────────────────────────────────────────────────────── */
.md :deep(blockquote) {
  margin: 0 0 14px;
  padding: 2px 0 2px 15px;
  border-left: 2px solid color-mix(in oklab, var(--accent) 45%, transparent);
  color: var(--ink-soft);
}
.md :deep(blockquote p) { margin: 0 0 6px; }
.md :deep(blockquote > :last-child) { margin-bottom: 0; }

/* ── callouts ───────────────────────────────────────────────────────────────── */
.md :deep(.callout) {
  --c: var(--accent);
  margin: 0 0 14px;
  padding: 11px 15px 12px;
  border-radius: 12px;
  background: color-mix(in oklab, var(--c) 8%, transparent);
}
.md :deep(.callout--note) { --c: #4b8fd6; }
.md :deep(.callout--tip) { --c: var(--diff-add); }
.md :deep(.callout--important) { --c: var(--accent); }
.md :deep(.callout--warning) { --c: #d9a441; }
.md :deep(.callout--caution) { --c: var(--diff-del); }
.md :deep(.callout__head) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  color: var(--c);
  font-size: 13px;
  font-weight: 640;
  letter-spacing: -0.005em;
}
.md :deep(.callout__icon) { flex: none; }
.md :deep(.callout__body > :last-child) { margin-bottom: 0; }
.md :deep(.callout__body p) { margin: 0 0 6px; }

/* ── tables ─────────────────────────────────────────────────────────────────── */
.md :deep(.md-table) {
  margin: 0 0 14px;
  overflow-x: auto;
  border-radius: 10px;
}
.md :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 19px;
}
.md :deep(thead th) {
  padding: 6px 12px;
  text-align: left;
  font-weight: 620;
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--hover);
  white-space: nowrap;
}
.md :deep(tbody td) {
  padding: 7px 12px;
  border-bottom: 1px solid var(--hover);
  color: var(--ink);
  vertical-align: top;
  font-variant-numeric: tabular-nums;
}
.md :deep(tbody tr:last-child td) { border-bottom: 0; }
.md :deep(tbody tr:hover td) { background: var(--hover); }

/* ── rule ───────────────────────────────────────────────────────────────────── */
.md :deep(hr) {
  margin: 20px 0;
  border: 0;
  height: 1px;
  background: var(--hover);
}

@media (prefers-reduced-motion: reduce) {
  .md :deep(.stream-word) { transition: none; transform: none; }
}
</style>
