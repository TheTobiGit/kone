import { computed, h, nextTick, render, type Ref } from "vue";
import MentionChip from "~/components/composer/MentionChip.vue";
import {
  buildMentionItems,
  formatFileMention,
  splitComposerMentionSegments,
  type MentionItem,
  type MentionKind,
  type MentionProject,
} from "~/utils/composerMentions";
import { useProjectFiles } from "./useProjectFiles";
import type { TokenInsertion } from "./useComposerTrigger";

/** How many project rows one @ query may offer. The list is recents, already
 *  short and already ordered, so this only trims a long tail. */
const MAX_PROJECT_MENTIONS = 6;

/** The composer's @ half: the contenteditable editor (chips, serialization)
 *  plus the mention row source. Trigger state — the token, the index, the
 *  keyboard — lives in the shared trigger machine; the query arrives as a
 *  getter so the file search follows the one live token. */
export function useComposerMentions(deps: {
  field: Ref<HTMLElement | null>;
  text: Ref<string>;
  /** The live @ query, or "" when @ isn't the open marker. */
  query: () => string;
  projectPath: () => string;
  onSync: () => void;
  /** Projects the @ picker offers above files. Empty everywhere except the
   *  global assistant, which has no project of its own. */
  projects?: () => MentionProject[];
  /** File search needs a real project on disk; the assistant modal has none. */
  fileMentionsEnabled?: () => boolean;
  /** Which kind a restored @path chip is. Drafts persist as text, so a path
   *  re-entering the field would otherwise always come back a file chip —
   *  the assistant answers "project" for paths it offered as projects. */
  resolveMentionKind?: (path: string) => MentionKind;
  /** Place the caret — the trigger machine owns the caret helper. */
  placeCaret: (node: Node, offset: number) => void;
}) {
  const { field, text, projectPath, onSync, placeCaret } = deps;

  const projectFiles = useProjectFiles(
    () => projectPath(),
    () => deps.query(),
    () => deps.fileMentionsEnabled?.() ?? true,
  );
  const mentionFiles = computed(() => projectFiles.entries.value);
  const mentionPending = computed(() => projectFiles.pending.value);
  const mentionError = computed(() => projectFiles.error.value);

  // Projects whose name or path contains the query, recents order kept. An
  // empty query offers the head of recents, so a bare @ already names
  // somewhere to point the turn at. Substring, not prefix (the deliberate
  // split from slash rows): project paths are an unbounded set, so `/m`
  // narrowing to one verb would be wrong here.
  function mentionProjectsFor(query: string): MentionProject[] {
    const all = deps.projects?.() ?? [];
    if (all.length === 0) return [];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, MAX_PROJECT_MENTIONS);
    return all
      .filter(
        (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
      )
      .slice(0, MAX_PROJECT_MENTIONS);
  }

  /** One keyboard list across both sections, built once — the menu renders it
   *  verbatim so no offset arithmetic lives here or in the template. */
  function mentionItemsFor(query: string): MentionItem[] {
    return buildMentionItems(mentionProjectsFor(query), mentionFiles.value);
  }

  const chipHosts = new Set<HTMLElement>();

  function makeChipEl(path: string, kind: MentionKind = "file"): HTMLElement {
    const host = document.createElement("div");
    render(h(MentionChip, { path, kind }), host);
    const mounted = host.firstElementChild;
    const chip = mounted instanceof HTMLElement ? mounted : null;
    if (!chip) {
      render(null, host);
      const span = document.createElement("span");
      span.textContent = path;
      span.setAttribute("contenteditable", "false");
      span.dataset.mentionPath = path;
      span.dataset.mentionKind = kind;
      return span;
    }
    chip.setAttribute("contenteditable", "false");
    chip.dataset.mentionPath = path;
    chip.dataset.mentionKind = kind;
    chipHosts.add(host);
    return chip;
  }

  function disposeChips(): void {
    for (const host of chipHosts) render(null, host);
    chipHosts.clear();
  }

  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    const el = node instanceof HTMLElement ? node : null;
    if (!el) return "";
    if (el.dataset.mentionPath !== undefined) return formatFileMention(el.dataset.mentionPath);
    if (el.tagName === "BR") return "\n";
    let inner = "";
    for (const child of Array.from(el.childNodes)) inner += serializeNode(child);
    return /^(DIV|P)$/.test(el.tagName) ? `\n${inner}` : inner;
  }

  function serializeEditor(): string {
    const el = field.value;
    if (!el) return "";
    let out = "";
    for (const child of Array.from(el.childNodes)) out += serializeNode(child);
    return out.replace(/^\n/, "");
  }

  /** Re-serialize the DOM into the sendable text. The trigger refresh rides
   *  alongside in the composer's input handler, not in here. */
  function syncEditorText(): void {
    text.value = serializeEditor();
    void nextTick(onSync);
  }

  /** Drop a picked mention where the token was, then a trailing space so the
   *  caret lands outside the chip and typing continues as prose. */
  function applyMention(item: MentionItem, insertion: TokenInsertion | null): void {
    const root = field.value;
    if (!insertion || !root) return;
    const { parent, after } = insertion;

    const chip = makeChipEl(item.path, item.kind);
    parent.insertBefore(chip, after);

    let caretNode: Node;
    let caretOffset: number;
    if (after.data.startsWith(" ")) {
      caretNode = after;
      caretOffset = 1;
    } else {
      const space = document.createTextNode(" ");
      parent.insertBefore(space, after);
      caretNode = space;
      caretOffset = 1;
    }

    root.focus();
    placeCaret(caretNode, caretOffset);
    syncEditorText();
  }

  function setEditorFromText(value: string): void {
    const el = field.value;
    if (!el) return;
    el.replaceChildren();
    disposeChips();
    for (const segment of splitComposerMentionSegments(value)) {
      if (segment.type === "mention") {
        el.appendChild(makeChipEl(segment.path, deps.resolveMentionKind?.(segment.path) ?? "file"));
      } else if (segment.text) el.appendChild(document.createTextNode(segment.text));
    }
    text.value = serializeEditor();
  }

  function clearEditor(): void {
    field.value?.replaceChildren();
    disposeChips();
    text.value = "";
  }

  function focusEditorEnd(): void {
    const el = field.value;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertTextAtCaret(value: string): void {
    const el = field.value;
    if (!el) return;
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  return {
    mentionPending,
    mentionError,
    projectFiles,
    mentionFiles,
    mentionProjectsFor,
    mentionItemsFor,
    makeChipEl,
    disposeChips,
    serializeNode,
    serializeEditor,
    syncEditorText,
    applyMention,
    setEditorFromText,
    clearEditor,
    focusEditorEnd,
    insertTextAtCaret,
  };
}
