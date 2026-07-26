<script setup lang="ts">
import { computed, defineComponent, Fragment, h, ref, watch } from "vue";
import type { VNode } from "vue";
import type Token from "markdown-it/lib/token.mjs";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  InformationCircleIcon,
  Idea01Icon,
  AlertCircleIcon,
  Alert02Icon,
  AlertDiamondIcon,
} from "@hugeicons/core-free-icons";
import CodeBlock from "~/components/CodeBlock.vue";
import MarkdownLink from "~/components/MarkdownLink.vue";
import MarkdownImage from "~/components/MarkdownImage.vue";
import FileChip from "~/components/FileChip.vue";

// The agent's settled reply, rendered as a real component tree rather than a
// v-html string. We parse the Markdown to markdown-it's token stream, fold it
// into a small node tree, and walk that with `h()` — which lets a fenced block
// become a syntax-highlighted <CodeBlock>, a web link wear its favicon, a path
// in backticks turn into a file chip, and an image settle into a framed figure.
// Everything else (headings, lists, tables, quotes, emphasis) renders as plain
// semantic elements styled below via `.md :deep(...)`.

const props = defineProps<{ source: string }>();

const { parse } = useMarkdown();

const tokens = ref<Token[] | null>(null);
let seq = 0;
watch(
  () => props.source,
  async (src) => {
    const mine = ++seq;
    const t = await parse(src);
    if (mine === seq) tokens.value = t;
  },
  { immediate: true },
);

// Every word gets its own stable key (its position in the whole reply), so a
// streamed word mounts as a genuinely new element the instant it arrives —
// the same "resolves from soft focus" reveal HomeGreeting uses for its state
// line, but driven by real arrival time instead of an artificial stagger:
// each word's blur-in fires exactly when it lands, one after another as the
// reply grows. A fully-formed message (history) mounts all its words at once,
// so it just settles as a single soft block instead of a per-word cascade.
// Reset once per full tree render — see `Rendered` below.
let wordSeq = 0;

// ── token stream → node tree ────────────────────────────────────────────────
// markdown-it hands a flat list with nesting encoded as open/close pairs. Fold
// it into a tree; inline tokens carry their own child list, so recurse in.
interface MdNode {
  type: string;
  tag: string;
  attrs: Record<string, string>;
  children: MdNode[];
  content: string;
  info: string;
}
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

const nodes = computed<MdNode[]>(() => (tokens.value ? treeify(tokens.value) : []));

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
function renderChildren(node: MdNode): (VNode | string)[] {
  return node.children.map((c, i) => renderNode(c, i));
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

/** Split a text run into words wrapped in individually-keyed spans (so each
 *  one mounts as its own DOM node and can carry the blur-in reveal), with
 *  whitespace passed through untouched between them. */
function renderWords(content: string, key: number): VNode {
  const parts = content.split(/(\s+)/);
  return h(
    Fragment,
    { key },
    parts.map((part) => (/^\s*$/.test(part) ? part : h("span", { key: `w${wordSeq++}`, class: "stream-word" }, part))),
  );
}

function renderNode(node: MdNode, key: number): VNode | string {
  switch (node.type) {
    case "text":
      return renderWords(node.content, key);
    case "softbreak":
      return " ";
    case "hardbreak":
      return h("br", { key });
    case "fence":
    case "code_block":
      return h(CodeBlock, { key, code: node.content, info: node.info });
    case "code_inline":
      return looksLikePath(node.content)
        ? h(FileChip, { key, path: node.content.trim() })
        : h("code", { key }, node.content);
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
        return h(FileChip, { key, path: label || full.split("/").pop() || full, title: full });
      }
      return h(MarkdownLink, { key, href }, { default: () => renderChildren(node) });
    }
    case "heading":
      return h(node.tag, { key }, renderChildren(node));
    case "paragraph":
      return h("p", { key }, renderChildren(node));
    case "blockquote":
      return renderQuote(node, key);
    case "bullet_list":
      return h("ul", { key }, renderChildren(node));
    case "ordered_list":
      return h("ol", { key, start: node.attrs.start }, renderChildren(node));
    case "list_item":
      return renderListItem(node, key);
    case "table":
      return h("div", { key, class: "md-table" }, [h("table", null, renderChildren(node))]);
    case "th":
      return h("th", { key, style: styleOf(node) }, renderChildren(node));
    case "td":
      return h("td", { key, style: styleOf(node) }, renderChildren(node));
    case "hr":
      return h("hr", { key });
    case "strong":
      return h("strong", { key }, renderChildren(node));
    case "em":
      return h("em", { key }, renderChildren(node));
    case "s":
      return h("s", { key }, renderChildren(node));
    case "html_block":
    case "html_inline":
      return node.content; // html:false — arrives already escaped as text
    default:
      return node.tag ? h(node.tag, { key }, renderChildren(node)) : h(Fragment, { key }, renderChildren(node));
  }
}

function renderQuote(node: MdNode, key: number): VNode {
  const callout = asCallout(node);
  if (!callout) return h("blockquote", { key }, renderChildren(node));
  const meta = CALLOUTS[callout.kind]!;
  return h("div", { key, class: ["callout", `callout--${callout.kind}`] }, [
    h("div", { class: "callout__head" }, [
      h(HugeiconsIcon, { icon: meta.icon, size: 15, strokeWidth: 2, class: "callout__icon" }),
      h("span", { class: "callout__label" }, meta.label),
    ]),
    h("div", { class: "callout__body" }, callout.body.map((c, i) => renderNode(c, i))),
  ]);
}

// Task-list items: a leading `[ ]` / `[x]` in the first paragraph becomes a
// checkbox, and a checked item dims + strikes through.
function renderListItem(node: MdNode, key: number): VNode {
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
        h("p", null, inlines.map((c, i) => renderNode(c, i))),
        ...rest.map((c, i) => renderNode(c, i + 100)),
      ]),
    ]);
  }
  return h("li", { key }, renderChildren(node));
}

const Rendered = defineComponent({
  name: "MarkdownRendered",
  render: () => {
    wordSeq = 0;
    return nodes.value.map((n, i) => renderNode(n, i));
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
  font-size: 16px;
  line-height: 27px;
  color: var(--ink);
}
.md__raw {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Each word resolves from soft focus as it mounts — the same reveal
   HomeGreeting uses for its state line. Streamed words each land at their own
   real moment so this alone reads as one word settling after another; a
   fully-formed message just mounts all its words in the same tick and settles
   as a single soft block. */
.md :deep(.stream-word) {
  display: inline;
  transition:
    opacity 420ms ease,
    filter 420ms ease;
}
@starting-style {
  .md :deep(.stream-word) {
    opacity: 0;
    filter: blur(6px);
  }
}

/* ── blocks ─────────────────────────────────────────────────────────────────── */
.md :deep(p) { margin: 0 0 12px; }
.md :deep(> :last-child) { margin-bottom: 0; }

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 22px 0 9px;
  font-weight: 640;
  line-height: 1.32;
  letter-spacing: -0.012em;
  color: var(--ink);
}
.md :deep(h1) { font-size: 21px; }
.md :deep(h2) { font-size: 18px; }
.md :deep(h3) { font-size: 16px; }
.md :deep(h4) { font-size: 15px; color: var(--ink-soft); }
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
.md :deep(code) {
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
  font-size: 14px;
  line-height: 20px;
}
.md :deep(thead th) {
  padding: 7px 14px;
  text-align: left;
  font-weight: 620;
  font-size: 12px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--hover);
  white-space: nowrap;
}
.md :deep(tbody td) {
  padding: 8px 14px;
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
  .md :deep(.stream-word) { transition: none; }
}
</style>
