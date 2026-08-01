import type { Ref } from "vue";
import { cleanPadHtml, ZWSP } from "~/utils/padMarkdown";
import type { PadMarker } from "~/composables/useScratchpad";
import { isHighlightId, isTextColorId } from "~/utils/padColors";

/**
 * The scratchpad's editor — ours, not a framework's.
 *
 * The pad is one `contenteditable` region and this is everything that gives it
 * behaviour: Markdown shorthand that formats itself as you type (`## ` becomes a
 * heading, `- ` a list, `**bold**` bold), the mark commands behind the floating
 * bar and its shortcuts, a highlighter and a text colour, task items you can tick,
 * and paste that arrives as formatted text instead of someone else's markup.
 *
 * It leans on the browser's own editing commands. They're long-deprecated on
 * paper and unfashionable, but they are also what every Chromium build actually
 * implements — and kone ships on exactly one engine — so they buy correct
 * selection, undo and list behaviour that a hand-rolled DOM editor would spend
 * thousands of lines approximating badly.
 */

export type PadMarkKind = "bold" | "italic" | "strike" | "code" | "highlight";

/** The block kinds the format bar can set a line to. */
export type PadBlockKind = "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "task" | "quote";

export type UsePadEditorOptions = {
  host: Ref<HTMLElement | null>;
  /** The pad document (HTML). Written on every edit, read on outside changes. */
  doc: Ref<string>;
  marker: () => PadMarker;
  /** Re-arm a pen after the bar (or a typed `==mark==`) uses it. */
  onMarkerUse?: (patch: Partial<PadMarker>) => void;
};

const BLOCK_SELECTOR = "p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre";
const INLINE_TRIGGERS = new Set(["*", "_", "`", "~", "="]);
/** A highlight run and a coloured run. Named, not styled — see padColors.ts. */
const HIGHLIGHT_SELECTOR = "mark[data-hl]";
const TEXT_COLOR_SELECTOR = "span[data-tc]";
/** The inline wrappers the pad's marks are allowed to sit on top of. */
const WRAPPER_SELECTOR = `${HIGHLIGHT_SELECTOR},${TEXT_COLOR_SELECTOR},b,strong,i,em,s,strike,del,code`;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function usePadEditor(options: UsePadEditorOptions) {
  const { host, doc, marker } = options;
  /** The HTML we last wrote out, so an echo of our own edit isn't reloaded. */
  let emitted = "";

  function exec(command: string, value?: string): boolean {
    return document.execCommand(command, false, value);
  }

  function selection(): Selection | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const node = sel.anchorNode;
    if (!node || !host.value?.contains(node)) return null;
    return sel;
  }

  function elementOf(node: Node | null): HTMLElement | null {
    if (!node) return null;
    return node instanceof HTMLElement ? node : node.parentElement;
  }

  /** The block element the caret sits in, bounded by the editor host. */
  function currentBlock(): HTMLElement | null {
    const sel = selection();
    const el = elementOf(sel?.anchorNode ?? null);
    const block = el?.closest(BLOCK_SELECTOR) as HTMLElement | null;
    if (block && host.value?.contains(block)) return block;
    return host.value;
  }

  function emit(): void {
    const el = host.value;
    if (!el) return;
    // The document that leaves is cleaned of the browser's editing residue; the
    // one under the caret is left exactly as Chromium arranged it. `emitted` is
    // the cleaned text, so the echo back through `doc` still doesn't reload.
    emitted = cleanPadHtml(el.innerHTML);
    doc.value = emitted;
  }

  /** Load a document written from outside (a captured snippet, Clear, a reopen). */
  function syncFromDoc(): void {
    const el = host.value;
    if (!el) return;
    if (doc.value === emitted) return;
    emitted = doc.value;
    el.innerHTML = doc.value || "<p><br></p>";
  }

  function focusEnd(): void {
    const el = host.value;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // ── marks ──────────────────────────────────────────────────────────────────

  /** The nearest enclosing element matching `selector`, bounded by the host. */
  function ancestor(selector: string): HTMLElement | null {
    const el = elementOf(window.getSelection()?.anchorNode ?? null);
    const found = el?.closest(selector) as HTMLElement | null;
    return found && host.value?.contains(found) ? found : null;
  }

  function codeAncestor(): HTMLElement | null {
    return ancestor("code");
  }

  function sameBounds(a: Range, b: Range): boolean {
    return (
      a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
      a.compareBoundaryPoints(Range.END_TO_END, b) === 0
    );
  }

  /** Is this element exactly what the range covers — with or without its tags? */
  function coversExactly(range: Range, el: Element): boolean {
    const inside = document.createRange();
    inside.selectNodeContents(el);
    if (sameBounds(range, inside)) return true;
    const whole = document.createRange();
    whole.selectNode(el);
    return sameBounds(range, whole);
  }

  /**
   * The run of this kind the selection is on — the one a pen should recolour or
   * lift off rather than wrap again.
   *
   * Marks stack, so that run is not always an ancestor: highlight then colour a
   * phrase and the coloured span sits *inside* the mark, so the next click on the
   * highlighter is looking down at it, not up. A contained run only counts when
   * the selection covers it exactly — otherwise selecting a paragraph that
   * happens to hold one marked phrase would recolour the phrase instead of
   * marking the paragraph.
   */
  function markForSelection(selector: string): HTMLElement | null {
    const found = ancestor(selector);
    if (found) return found;
    const sel = selection();
    if (!sel || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const scope = elementOf(range.commonAncestorContainer);
    for (const el of Array.from(scope?.querySelectorAll<HTMLElement>(selector) ?? [])) {
      if (coversExactly(range, el)) return el;
    }
    return null;
  }

  function highlightAncestor(): HTMLElement | null {
    return markForSelection(HIGHLIGHT_SELECTOR);
  }

  /** Lift an inline wrapper off its contents, leaving them selected. */
  function unwrap(el: HTMLElement): void {
    const parent = el.parentNode;
    if (!parent) return;
    const first = el.firstChild;
    const last = el.lastChild;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    if (!first || !last) return;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** Leave the words the mark was just laid on selected. */
  function selectContents(el: HTMLElement): void {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /**
   * The run the selection already covers whole — the thing a second mark should
   * be laid *around* rather than in place of.
   *
   * Marks stack: a highlight can go over a coloured run and vice versa. Building
   * the new element from the selection's contents would empty the run that held
   * them, and Chromium drops empty inline elements — so colouring a highlighted
   * phrase would silently un-highlight it. Climbing to the outermost run that the
   * selection still covers exactly is what makes the two nest instead.
   */
  function stackedRun(range: Range): HTMLElement | null {
    let found: HTMLElement | null = null;
    let inner: Range | null = range;
    for (let guard = 0; guard < 4 && inner; guard += 1) {
      const el = elementOf(inner.commonAncestorContainer)?.closest<HTMLElement>(WRAPPER_SELECTOR);
      if (!el || el === host.value || !host.value?.contains(el)) break;
      if (!coversExactly(inner, el)) break;
      found = el;
      inner = document.createRange();
      inner.selectNode(el);
    }
    return found;
  }

  /**
   * Wrap the selection in an inline element.
   *
   * Fresh text goes through `insertHTML` so the edit lands in the browser's own
   * undo stack — ⌘Z has to walk back through a highlight the same way it walks
   * back through typing — and so the selection's own markup is carried over
   * (a highlight can be laid over text that is already bold).
   *
   * Stacking onto a run that is already marked is a plain wrap, and it is done by
   * hand: `insertHTML` over a whole element is where Chromium gets unreliable —
   * inside a list item, with a caret perch left behind by an earlier mark, it
   * drops the wrapper it was handed and the new colour just doesn't appear.
   *
   * Either way the words stay selected. Left to itself `insertHTML` puts the
   * caret past the end, which closes the bar and means trying a second colour
   * costs another drag — the whole point of a swatch row is shopping around.
   */
  function wrapSelection(tag: "mark" | "span", attr: string, value: string): boolean {
    const sel = selection();
    if (!sel || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);

    const stacked = stackedRun(range);
    if (stacked) {
      const wrapper = document.createElement(tag);
      wrapper.setAttribute(attr, value);
      stacked.replaceWith(wrapper);
      wrapper.append(stacked);
      selectContents(wrapper);
      return true;
    }

    const holder = document.createElement("div");
    holder.append(range.cloneContents());
    const inner = holder.innerHTML;
    if (!inner) return false;
    exec(
      "insertHTML",
      `<${tag} ${attr}="${value}" data-pad-fresh>${inner}</${tag}>${ZWSP}`,
    );
    const fresh = host.value?.querySelector<HTMLElement>("[data-pad-fresh]");
    if (fresh) {
      fresh.removeAttribute("data-pad-fresh");
      selectContents(fresh);
    }
    return true;
  }

  function activeMarks(): Record<PadMarkKind, boolean> {
    if (!import.meta.client) {
      return { bold: false, italic: false, strike: false, code: false, highlight: false };
    }
    const state = (cmd: string) => {
      try {
        return document.queryCommandState(cmd);
      } catch {
        return false;
      }
    };
    return {
      bold: state("bold"),
      italic: state("italic"),
      strike: state("strikeThrough"),
      code: Boolean(codeAncestor()),
      highlight: Boolean(highlightAncestor()),
    };
  }

  /** Wrap the selection in `<code>`, or unwrap it when it's already code. */
  function toggleCode(): void {
    const sel = selection();
    if (!sel) return;
    const existing = codeAncestor();
    if (existing) {
      const text = existing.textContent ?? "";
      existing.replaceWith(document.createTextNode(text));
      emit();
      return;
    }
    const text = sel.toString();
    if (!text) return;
    exec("insertHTML", `<code>${escapeHtml(text)}</code>${ZWSP}`);
    emit();
  }

  function applyMark(kind: PadMarkKind): void {
    host.value?.focus();
    switch (kind) {
      case "bold":
        exec("bold");
        break;
      case "italic":
        exec("italic");
        break;
      case "strike":
        exec("strikeThrough");
        break;
      case "code":
        toggleCode();
        return;
      case "highlight":
        applyHighlight(marker().highlight);
        return;
    }
    emit();
  }

  /**
   * Paint the selection with a highlight.
   *
   * The pen is sticky, so this is also how one gets picked up: with nothing
   * selected it only arms the colour for the next `==…==` or ⌘⇧H. On a run that
   * is already highlighted, the same colour lifts the highlight off and a
   * different colour recolours it — you never have to clear before re-marking.
   */
  function applyHighlight(id: string): void {
    if (!isHighlightId(id)) return;
    host.value?.focus();
    options.onMarkerUse?.({ highlight: id });
    const existing = highlightAncestor();
    if (existing) {
      if (existing.dataset.hl === id) unwrap(existing);
      else existing.dataset.hl = id;
      emit();
      return;
    }
    if (wrapSelection("mark", "data-hl", id)) emit();
  }

  /** The same three moves as the highlighter, in ink. "Default" is the eraser. */
  function applyTextColor(id: string): void {
    if (!isTextColorId(id)) return;
    host.value?.focus();
    options.onMarkerUse?.({ text: id });
    const existing = markForSelection(TEXT_COLOR_SELECTOR);
    if (existing) {
      if (existing.dataset.tc === id || id === "default") unwrap(existing);
      else existing.dataset.tc = id;
      emit();
      return;
    }
    if (id === "default") return;
    if (wrapSelection("span", "data-tc", id)) emit();
  }

  function clearFormat(): void {
    host.value?.focus();
    const sel = selection();
    exec("removeFormat");
    // removeFormat only knows the browser's own marks. Ours — code, highlights,
    // coloured runs — have to be lifted off by hand.
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (range) {
      const ours = `code,${HIGHLIGHT_SELECTOR},${TEXT_COLOR_SELECTOR}`;
      for (const el of Array.from(host.value?.querySelectorAll<HTMLElement>(ours) ?? [])) {
        if (range.intersectsNode(el)) unwrap(el);
      }
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    emit();
  }

  // ── task items ─────────────────────────────────────────────────────────────

  function listItem(): HTMLElement | null {
    const el = elementOf(window.getSelection()?.anchorNode ?? null);
    const li = el?.closest("li") as HTMLElement | null;
    return li && host.value?.contains(li) ? li : null;
  }

  function markAsTask(li: HTMLElement, checked = false): void {
    li.dataset.checked = checked ? "true" : "false";
    li.closest("ul")?.classList.add("pad-tasks");
  }

  /** ⌘⇧K — turn the line into a task, or tick/untick the one it's already in. */
  function toggleTask(): void {
    host.value?.focus();
    const li = listItem();
    if (li) {
      if (li.dataset.checked === undefined) markAsTask(li);
      else {
        li.dataset.checked = li.dataset.checked === "true" ? "false" : "true";
        if (li.dataset.checked === "false") li.closest("ul")?.classList.add("pad-tasks");
      }
      emit();
      return;
    }
    exec("insertUnorderedList");
    const fresh = listItem();
    if (fresh) markAsTask(fresh);
    emit();
  }

  /** Take the checkbox off a task line, and the task styling off its list once
   *  the last one is gone. */
  function unmarkTask(li: HTMLElement): void {
    delete li.dataset.checked;
    const ul = li.closest("ul");
    if (ul && !ul.querySelector("li[data-checked]")) ul.classList.remove("pad-tasks");
  }

  /** Turn the caret's line into a task, making a list for it if there isn't one. */
  function makeTask(): void {
    const li = listItem();
    if (li) {
      if (li.dataset.checked === undefined) markAsTask(li);
      return;
    }
    exec("insertUnorderedList");
    const fresh = listItem();
    if (fresh) markAsTask(fresh);
  }

  // ── block kinds ────────────────────────────────────────────────────────────

  /**
   * What kind of block the caret is in, as the format bar names it.
   *
   * Headings past h3 report as h3: the bar offers three, and a pasted h4 should
   * still read as "heading" rather than falling back to body text.
   */
  function activeBlock(): PadBlockKind {
    if (!import.meta.client) return "p";
    const block = currentBlock();
    if (!block || block === host.value) return "p";
    const li = listItem();
    if (li) {
      if (li.dataset.checked !== undefined) return "task";
      return li.closest("ol") ? "ol" : "ul";
    }
    if (block.closest("blockquote")) return "quote";
    const tag = block.tagName.toLowerCase();
    if (tag === "h1" || tag === "h2" || tag === "h3") return tag;
    if (/^h[4-6]$/.test(tag)) return "h3";
    return "p";
  }

  /** Step out of however many lists the line is nested in. */
  function leaveList(): void {
    let guard = 0;
    while (listItem() && guard++ < 6) exec("outdent");
  }

  /** Drop the line back to body text, whatever it is now. */
  function toParagraph(): void {
    const li = listItem();
    if (li) unmarkTask(li);
    leaveList();
    exec("formatBlock", "p");
    // formatBlock leaves the quote wrapper standing; outdent is what removes it.
    if (currentBlock()?.closest("blockquote")) exec("outdent");
  }

  /**
   * Set the caret's block kind from the format bar.
   *
   * Choosing the kind the line already is undoes it — the same press-again-to-undo
   * the mark buttons have, so no one has to hunt for "body text" to get out of a
   * heading.
   */
  function applyBlock(kind: PadBlockKind): void {
    host.value?.focus();
    const current = activeBlock();
    const target = current === kind ? "p" : kind;
    if (target === "p") {
      toParagraph();
      emit();
      return;
    }
    // A list line has to stop being one before it can be a heading or a quote.
    if (target === "h1" || target === "h2" || target === "h3" || target === "quote") {
      const li = listItem();
      if (li) unmarkTask(li);
      leaveList();
      exec("formatBlock", target === "quote" ? "blockquote" : target);
      emit();
      return;
    }
    if (target === "task") {
      makeTask();
      emit();
      return;
    }
    // ul / ol. Chromium converts one list kind into the other in place, so the
    // only thing to undo by hand is a task line's checkbox.
    const li = listItem();
    if (li && li.dataset.checked !== undefined) unmarkTask(li);
    exec(target === "ol" ? "insertOrderedList" : "insertUnorderedList");
    emit();
  }

  /** A click in a task item's box column ticks it — the box is CSS, not an input,
   *  so the caret never lands inside a widget. */
  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const li = target?.closest("li[data-checked]") as HTMLElement | null;
    if (!li || !host.value?.contains(li)) return;
    if (target !== li) return;
    const box = li.getBoundingClientRect();
    if (e.clientX - box.left > 22) return;
    e.preventDefault();
    li.dataset.checked = li.dataset.checked === "true" ? "false" : "true";
    emit();
  }

  // ── block shorthand ────────────────────────────────────────────────────────

  /** The text from the caret's block start up to the caret. */
  function textBeforeCaret(): { text: string; range: Range } | null {
    const sel = selection();
    if (!sel || !sel.isCollapsed) return null;
    const block = currentBlock();
    if (!block) return null;
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return { text: range.toString(), range };
  }

  /** Delete the shorthand the rule consumed, leaving the caret in its place. */
  function dropPrefix(range: Range): void {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    exec("delete");
  }

  /** `# `, `- `, `1. `, `> `, `[] ` — run on the space that completes them. */
  function applyBlockRule(): boolean {
    const found = textBeforeCaret();
    if (!found) return false;
    const prefix = found.text.replaceAll(ZWSP, "");

    const heading = /^(#{1,6})$/.exec(prefix);
    if (heading) {
      dropPrefix(found.range);
      exec("formatBlock", `h${heading[1]!.length}`);
      return true;
    }
    if (/^[-*+]$/.test(prefix)) {
      dropPrefix(found.range);
      exec("insertUnorderedList");
      return true;
    }
    if (/^\d+\.$/.test(prefix)) {
      dropPrefix(found.range);
      exec("insertOrderedList");
      return true;
    }
    if (/^>$/.test(prefix)) {
      dropPrefix(found.range);
      // A quote is a block of its own, so step out of any list first — otherwise
      // Chromium quotes the whole list and the line keeps its checkbox.
      let guard = 0;
      while (listItem() && guard++ < 6) exec("outdent");
      exec("formatBlock", "blockquote");
      return true;
    }
    if (/^(\[\]|\[ \]|-\[\])$/.test(prefix)) {
      dropPrefix(found.range);
      const li = listItem();
      if (li) markAsTask(li);
      else {
        exec("insertUnorderedList");
        const fresh = listItem();
        if (fresh) markAsTask(fresh);
      }
      return true;
    }
    return false;
  }

  // ── inline shorthand ───────────────────────────────────────────────────────

  type InlineMatch = { start: number; inner: string; kind: PadMarkKind };

  function matchInline(before: string, char: string): InlineMatch | null {
    if (char === "*") {
      const bold = /\*\*([^*\s][^*]*)\*$/.exec(before);
      if (bold) return { start: bold.index, inner: bold[1]!, kind: "bold" };
      const italic = /(?:^|[^*])(\*([^*\s][^*]*))$/.exec(before);
      if (italic) {
        return {
          start: before.length - italic[1]!.length,
          inner: italic[2]!,
          kind: "italic",
        };
      }
      return null;
    }
    if (char === "_") {
      const italic = /(?:^|[^_\w])(_([^_\s][^_]*))$/.exec(before);
      if (!italic) return null;
      return { start: before.length - italic[1]!.length, inner: italic[2]!, kind: "italic" };
    }
    if (char === "`") {
      const code = /`([^`\s][^`]*)$/.exec(before);
      return code ? { start: code.index, inner: code[1]!, kind: "code" } : null;
    }
    if (char === "~") {
      const strike = /~~([^~\s][^~]*)~$/.exec(before);
      return strike ? { start: strike.index, inner: strike[1]!, kind: "strike" } : null;
    }
    if (char === "=") {
      const mark = /==([^=\s][^=]*)=$/.exec(before);
      return mark ? { start: mark.index, inner: mark[1]!, kind: "highlight" } : null;
    }
    return null;
  }

  /** `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `==highlight==` — run on
   *  the delimiter that closes the pair. */
  function applyInlineRule(char: string): boolean {
    const sel = selection();
    if (!sel || !sel.isCollapsed) return false;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const offset = sel.anchorOffset;
    const before = (node.textContent ?? "").slice(0, offset);
    const match = matchInline(before, char);
    if (!match) return false;

    const range = document.createRange();
    range.setStart(node, match.start);
    range.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(range);

    if (match.kind === "code") {
      exec("insertHTML", `<code>${escapeHtml(match.inner)}</code>${ZWSP}`);
      return true;
    }
    if (match.kind === "highlight") {
      const id = marker().highlight;
      const hl = isHighlightId(id) ? id : "copper";
      exec("insertHTML", `<mark data-hl="${hl}">${escapeHtml(match.inner)}</mark>${ZWSP}`);
      return true;
    }

    const command = match.kind === "bold" ? "bold" : match.kind === "italic" ? "italic" : "strikeThrough";
    exec("insertText", match.inner);
    // Re-select what we just typed, mark it, then leave the pen off so the next
    // keystroke is plain again.
    const after = window.getSelection();
    const anchor = after?.anchorNode;
    const end = after?.anchorOffset ?? 0;
    if (anchor && end >= match.inner.length) {
      const back = document.createRange();
      back.setStart(anchor, end - match.inner.length);
      back.setEnd(anchor, end);
      after?.removeAllRanges();
      after?.addRange(back);
      exec(command);
      after?.collapseToEnd();
      exec(command);
    }
    return true;
  }

  // ── event handlers ─────────────────────────────────────────────────────────

  function onBeforeInput(e: InputEvent): void {
    if (e.inputType !== "insertText" || !e.data) return;
    if (e.data === " ") {
      if (applyBlockRule()) e.preventDefault();
      return;
    }
    if (e.data.length === 1 && INLINE_TRIGGERS.has(e.data)) {
      if (applyInlineRule(e.data)) e.preventDefault();
    }
  }

  /** `---` and ``` ``` ``` complete on Enter, not on space. */
  function fenceRuleOnEnter(): boolean {
    const found = textBeforeCaret();
    if (!found) return false;
    const prefix = found.text.replaceAll(ZWSP, "").trim();
    if (/^```(\w*)$/.test(prefix)) {
      dropPrefix(found.range);
      exec("formatBlock", "pre");
      return true;
    }
    if (/^(---|\*\*\*|___)$/.test(prefix)) {
      dropPrefix(found.range);
      exec("insertHTML", "<hr><p><br></p>");
      return true;
    }
    return false;
  }

  function onKeydown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      applyHighlight(marker().highlight);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      toggleTask();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      applyMark("strike");
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      applyMark("code");
      return;
    }
    if (mod && !e.shiftKey && (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "i")) {
      // The browser's own bold/italic bindings already fire here; let them, and
      // just make sure the document is written back out.
      window.setTimeout(emit, 0);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (listItem()) exec(e.shiftKey ? "outdent" : "indent");
      else if (!e.shiftKey) exec("insertText", "  ");
      emit();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !mod) {
      if (fenceRuleOnEnter()) {
        e.preventDefault();
        emit();
      }
    }
  }

  /** After a new paragraph, an empty heading / quote drops back to body text —
   *  Chromium would otherwise carry the block style on forever. */
  function settleAfterParagraph(): void {
    const block = currentBlock();
    if (!block || block === host.value) return;
    const empty = !(block.textContent ?? "").replaceAll(ZWSP, "").trim();
    if (!empty) return;
    if (/^H[1-6]$/.test(block.tagName)) exec("formatBlock", "p");
    else if (block.closest("blockquote")) {
      exec("formatBlock", "p");
      exec("outdent");
    }
  }

  function onInput(e: Event): void {
    const inputType = (e as InputEvent).inputType;
    if (inputType === "insertParagraph") settleAfterParagraph();
    emit();
  }

  async function onPaste(e: ClipboardEvent, renderMarkdown: (src: string) => Promise<string>) {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    // The pad owns its markup: clipboard HTML is ignored and the plain text is
    // read as Markdown, so a pasted answer lands formatted and clean.
    e.preventDefault();
    const looksRich = /\n/.test(text.trim()) || /(^|\s)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)/.test(text);
    if (!looksRich) {
      exec("insertText", text);
      emit();
      return;
    }
    const html = await renderMarkdown(text);
    exec("insertHTML", html);
    emit();
  }

  return {
    syncFromDoc,
    focusEnd,
    onBeforeInput,
    onInput,
    onKeydown,
    onPaste,
    onClick,
    applyMark,
    applyHighlight,
    applyTextColor,
    clearFormat,
    toggleTask,
    activeMarks,
    activeBlock,
    applyBlock,
  };
}
