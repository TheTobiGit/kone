// The scratchpad's document is rich HTML — the pane formats as you type, so what
// it stores is what you see. Markdown is the interchange format at both ends:
// snippets captured from a thread (and anything pasted) arrive as Markdown and
// are rendered in, and Copy / Export write Markdown back out.
//
// These are the two converters. They're deliberately small — the pad only ever
// holds the handful of constructs its own editor can produce (headings, lists,
// task lists, quotes, code, rules, and the inline marks) — and they run in the
// renderer, so DOM parsing is fair game.

/** Zero-width space. Typing an inline mark leaves one behind as the caret's
 *  perch just outside the new element; it must never reach the markdown. */
const ZWSP = "\u200B";

/** The non-breaking space Chromium leaves behind at element boundaries. */
const NBSP = "\u00A0";

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "HR",
]);

function isHighlightSpan(el: HTMLElement): boolean {
  const bg = el.style.backgroundColor;
  return Boolean(bg) && bg !== "transparent" && bg !== "initial";
}

/** Blocks that must never sit inside a `<p>` — Chromium puts new lists there. */
const NESTED_BLOCK_SELECTOR = "ul,ol,blockquote,pre,hr,h1,h2,h3,h4,h5,h6,p,div,table";

/** Re-apply a delimiter without swallowing the padding spaces around the text. */
function wrapMark(delimiter: string, body: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(body);
  if (!m || !m[2]) return body;
  return `${m[1]}${delimiter}${m[2]}${delimiter}${m[3]}`;
}

/** Text as Markdown sees it: no caret perches, and the non-breaking spaces the
 *  browser leaves at element boundaries relaxed back into ordinary ones. */
function inlineText(node: Node): string {
  return (node.textContent ?? "").replaceAll(ZWSP, "").replaceAll(NBSP, " ");
}

function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return inlineText(node);
  if (!(node instanceof HTMLElement)) return "";
  const children = () => Array.from(node.childNodes).map(inlineToMarkdown).join("");
  switch (node.tagName) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      return wrapMark("**", children());
    case "EM":
    case "I":
      return wrapMark("*", children());
    case "DEL":
    case "S":
    case "STRIKE":
      return wrapMark("~~", children());
    case "MARK":
      return wrapMark("==", children());
    case "CODE":
      return wrapMark("`", inlineText(node));
    case "A": {
      const href = node.getAttribute("href");
      const label = children();
      return href ? `[${label}](${href})` : label;
    }
    case "SPAN":
      // A coloured run (`data-tc`) has no Markdown, so it degrades to its text.
      // `isHighlightSpan` catches pads written before highlights were named
      // marks — an inline background still means `==…==`.
      return isHighlightSpan(node) ? wrapMark("==", children()) : children();
    default:
      return children();
  }
}

function inlineChildren(el: HTMLElement): string {
  return Array.from(el.childNodes).map(inlineToMarkdown).join("").trim();
}

/** A task item's state, or null when the list item isn't a task. */
function taskState(el: HTMLElement): boolean | null {
  const checked = el.dataset.checked;
  if (checked === undefined) return null;
  return checked === "true";
}

function listToMarkdown(list: HTMLElement, indent: string, out: string[]): void {
  const ordered = list.tagName === "OL";
  let n = Number(list.getAttribute("start") ?? 1);
  for (const li of Array.from(list.children)) {
    if (!(li instanceof HTMLElement) || li.tagName !== "LI") continue;
    const nested = Array.from(li.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && (c.tagName === "UL" || c.tagName === "OL"),
    );
    const own = document.createElement("div");
    for (const child of Array.from(li.childNodes)) {
      if (child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL")) continue;
      own.append(child.cloneNode(true));
    }
    const task = taskState(li);
    const body = inlineChildren(own);
    const bullet = ordered ? `${n}.` : "-";
    const box = task === null ? "" : task ? "[x] " : "[ ] ";
    out.push(`${indent}${bullet} ${box}${body}`.trimEnd());
    n += 1;
    for (const sub of nested) listToMarkdown(sub, `${indent}  `, out);
  }
}

function blockToMarkdown(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = inlineText(node).trim();
    if (text) out.push(text, "");
    return;
  }
  if (!(node instanceof HTMLElement)) return;

  switch (node.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const hashes = "#".repeat(Number(node.tagName[1]));
      out.push(`${hashes} ${inlineChildren(node)}`, "");
      return;
    }
    case "UL":
    case "OL": {
      const lines: string[] = [];
      listToMarkdown(node, "", lines);
      out.push(...lines, "");
      return;
    }
    case "BLOCKQUOTE": {
      const inner: string[] = [];
      for (const child of Array.from(node.childNodes)) blockToMarkdown(child, inner);
      const body = inner.join("\n").trim();
      out.push(
        body
          .split("\n")
          .map((l) => (l ? `> ${l}` : ">"))
          .join("\n"),
        "",
      );
      return;
    }
    case "PRE": {
      const code = node.querySelector("code");
      const lang = code?.className.match(/language-([\w+-]+)/)?.[1] ?? "";
      out.push("```" + lang, inlineText(node).replace(/\n$/, ""), "```", "");
      return;
    }
    case "HR":
      out.push("---", "");
      return;
    case "BR":
      return;
    case "DIV": {
      // A bare <div> is either a block wrapper (walk it) or a soft paragraph.
      const hasBlockChild = Array.from(node.children).some((c) => BLOCK_TAGS.has(c.tagName));
      if (hasBlockChild) {
        for (const child of Array.from(node.childNodes)) blockToMarkdown(child, out);
        return;
      }
      const body = inlineChildren(node);
      out.push(body, "");
      return;
    }
    default: {
      const body = inlineChildren(node);
      if (body) out.push(body, "");
    }
  }
}

/** The pad document as Markdown — what Copy and Export hand over. */
export function padHtmlToMarkdown(html: string): string {
  if (!html.trim() || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const out: string[] = [];
  for (const child of Array.from(doc.body.childNodes)) blockToMarkdown(child, out);
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text of the pad document — the word count reads this. */
export function padHtmlToText(html: string): string {
  if (!html.trim() || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return (doc.body.textContent ?? "").replaceAll(ZWSP, "");
}

/**
 * The document on its way out of the editor — what gets stored, reopened, and
 * serialized. Two bits of the browser's own bookkeeping are cleaned off here:
 *
 * - `insertUnorderedList` and friends leave the new list inside the paragraph it
 *   grew out of (`<p><ul>…</ul></p>`). That's invalid, so the next parse of the
 *   saved HTML re-shapes it — the document would quietly change on reopen.
 * - Chromium keeps a "typing style" alive across an inserted inline element and
 *   writes it out as `style="color: …"` / an opaque `background-color` on
 *   everything typed after a highlight. Both are whichever scheme was active at
 *   the time, so they'd turn into near-black text and a pale slab on the dark
 *   ground. The pad names its colours instead (`data-hl` / `data-tc`), so any
 *   inline colour reaching here is residue.
 *
 * This deliberately works on a *parsed copy* rather than the live editor DOM.
 * Tidying under the caret is what made Chromium re-enter a highlight and start
 * typing inside it: unwrap the span it just put the caret in, and the next
 * keystroke lands in the mark next door. None of this residue is visible — an
 * invisible slab, a nested list that renders the same — so the editor is left
 * holding it and the document that leaves is clean.
 */
export function cleanPadHtml(html: string): string {
  if (!html.trim() || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const root = doc.body;

  // Caret perches are for the caret, and the stored document doesn't have one.
  // Left in, they accumulate: every typed `==mark==` adds another, they survive
  // the reload, and the next one lands beside them.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const perches: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.textContent ?? "").includes(ZWSP)) perches.push(node as Text);
  }
  for (const node of perches) {
    const text = (node.textContent ?? "").replaceAll(ZWSP, "");
    if (text) node.textContent = text;
    else node.remove();
  }

  // Lift blocks out of the paragraphs that swallowed them. Parsing has already
  // done most of this (an invalid nesting can't survive a round trip) — what's
  // left is the empty husk of the paragraph, and any `<div>` wrapper.
  for (const p of Array.from(root.querySelectorAll("p,div"))) {
    const blocks = Array.from(p.children).filter((c) => c.matches(NESTED_BLOCK_SELECTOR));
    const loose = Array.from(p.childNodes)
      .filter((n) => !(n instanceof Element && blocks.includes(n)))
      .map((n) => n.textContent ?? "")
      .join("")
      .replaceAll(ZWSP, "")
      .trim();
    if (blocks.length && !loose) {
      // Nothing but a wrapper, so unwrapping can't reorder any text.
      p.replaceWith(...Array.from(p.childNodes));
    } else if (p.tagName === "P" && !p.childNodes.length) {
      // `<p></p>` — the husk. A blank line is `<p><br></p>` and stays.
      p.remove();
    }
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    if (el.style.color) el.style.removeProperty("color");
    if (isResidualBackground(el)) el.style.removeProperty("background-color");
    if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
    if (el.tagName === "SPAN" && el.attributes.length === 0) {
      el.replaceWith(...Array.from(el.childNodes));
    }
  }

  return root.innerHTML;
}

/**
 * Is this inline background the browser's, or the pad's own?
 *
 * Opacity is the tell. The pad's highlights were only ever translucent washes,
 * so an opaque background is always residue — while a translucent one is a real
 * highlight from a pad saved before highlights became named marks, and is kept.
 */
function isResidualBackground(el: HTMLElement): boolean {
  const bg = el.style.backgroundColor;
  if (!bg || bg === "transparent" || bg === "initial") return Boolean(bg);
  const alpha = /^rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(bg)?.[1];
  return alpha === undefined || Number(alpha) >= 1;
}

/**
 * markdown-it renders GFM task items as literal `[ ]` text (no task plugin), and
 * the pad draws its own checkboxes off `data-checked`. Fold one into the other so
 * a captured checklist arrives as a real checklist.
 */
export function normalizeTaskLists(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const li of Array.from(doc.body.querySelectorAll("li"))) {
    const first = li.firstChild;
    if (!first || first.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\s*\[( |x|X)\]\s*/.exec(first.textContent ?? "");
    if (!m) continue;
    first.textContent = (first.textContent ?? "").slice(m[0].length);
    li.dataset.checked = m[1] === " " ? "false" : "true";
    li.closest("ul")?.classList.add("pad-tasks");
  }
  return doc.body.innerHTML;
}

export { ZWSP };
