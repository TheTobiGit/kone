import {
  computed,
  h,
  nextTick,
  ref,
  render,
  type ComputedRef,
  type Ref,
} from "vue";
import MentionChip from "~/components/MentionChip.vue";
import type { GitProjectFile } from "~/types/desktop";
import {
  detectFileMentionTrigger,
  formatFileMention,
  splitComposerMentionSegments,
  type FileMentionTrigger,
} from "~/utils/composerMentions";
import { useProjectFiles } from "./useProjectFiles";

export type DomTrigger = { node: Text; start: number; end: number };

export function useComposerMentions(deps: {
  field: Ref<HTMLElement | null>;
  text: Ref<string>;
  projectPath: () => string;
  isOpen: () => boolean;
  isBusy: () => boolean;
  onSync: () => void;
  onSubmitOrQueue: () => void;
}) {
  const { field, text, projectPath, isOpen, isBusy, onSync, onSubmitOrQueue } = deps;

  const mentionTrigger = ref<FileMentionTrigger | null>(null);
  const mentionActiveIndex = ref(0);
  let domTrigger: DomTrigger | null = null;

  const mentionQuery = computed(() => mentionTrigger.value?.query ?? "");
  const mentionOpen = computed(() => isOpen() && mentionTrigger.value !== null && !isBusy());

  const projectFiles = useProjectFiles(
    () => projectPath(),
    () => mentionQuery.value,
  );
  const mentionFiles = computed(() => projectFiles.entries.value);
  const mentionPending = computed(() => projectFiles.pending.value);
  const mentionError = computed(() => projectFiles.error.value);

  const chipHosts = new Set<HTMLElement>();

  function makeChipEl(path: string): HTMLElement {
    const host = document.createElement("div");
    render(h(MentionChip, { path }), host);
    const chip = host.firstElementChild as HTMLElement | null;
    if (!chip) {
      render(null, host);
      const span = document.createElement("span");
      span.textContent = path;
      span.setAttribute("contenteditable", "false");
      span.dataset.mentionPath = path;
      return span;
    }
    chip.setAttribute("contenteditable", "false");
    chip.dataset.mentionPath = path;
    chipHosts.add(host);
    return chip;
  }

  function disposeChips(): void {
    for (const host of chipHosts) render(null, host);
    chipHosts.clear();
  }

  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
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

  function onEditorChanged(): void {
    text.value = serializeEditor();
    refreshTrigger();
    void nextTick(onSync);
  }

  function readDomTrigger(): { trigger: FileMentionTrigger; dom: DomTrigger } | null {
    const root = field.value;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
    const textNode = node as Text;
    const trigger = detectFileMentionTrigger(textNode.data, range.startOffset);
    if (!trigger) return null;
    return { trigger, dom: { node: textNode, start: trigger.rangeStart, end: range.startOffset } };
  }

  function refreshTrigger(): void {
    const found = readDomTrigger();
    domTrigger = found?.dom ?? null;
    mentionTrigger.value = found?.trigger ?? null;
  }

  function placeCaret(node: Node, offset: number): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function selectMention(file: GitProjectFile): void {
    const trig = domTrigger;
    const root = field.value;
    if (!trig || !root) return;

    const after = trig.node.splitText(trig.end);
    trig.node.splitText(trig.start);
    const parent = trig.node.parentNode;
    const queryNode = trig.node.nextSibling;
    if (!parent || !queryNode) return;
    parent.removeChild(queryNode);

    const chip = makeChipEl(file.path);
    parent.insertBefore(chip, after);

    let caretNode: Node;
    let caretOffset: number;
    if (after.nodeType === Node.TEXT_NODE && (after as Text).data.startsWith(" ")) {
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
    mentionActiveIndex.value = 0;
    onEditorChanged();
  }

  function onFieldInput(): void {
    onEditorChanged();
  }

  function onFieldClick(): void {
    refreshTrigger();
  }

  function onFieldKeyup(): void {
    refreshTrigger();
  }

  function onFieldKeydown(e: KeyboardEvent): void {
    if (mentionOpen.value) {
      const count = projectFiles.entries.value.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (count) mentionActiveIndex.value = (mentionActiveIndex.value + 1) % count;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (count) mentionActiveIndex.value = (mentionActiveIndex.value - 1 + count) % count;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const file = projectFiles.entries.value[mentionActiveIndex.value];
        if (file) {
          e.preventDefault();
          selectMention(file);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mentionTrigger.value = null;
        domTrigger = null;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmitOrQueue();
    }
  }

  function setEditorFromText(value: string): void {
    const el = field.value;
    if (!el) return;
    el.replaceChildren();
    disposeChips();
    for (const segment of splitComposerMentionSegments(value)) {
      if (segment.type === "mention") el.appendChild(makeChipEl(segment.path));
      else if (segment.text) el.appendChild(document.createTextNode(segment.text));
    }
    text.value = serializeEditor();
  }

  function clearEditor(): void {
    field.value?.replaceChildren();
    disposeChips();
    text.value = "";
    mentionTrigger.value = null;
    domTrigger = null;
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
    mentionTrigger,
    mentionActiveIndex,
    mentionQuery,
    mentionOpen,
    projectFiles,
    mentionFiles,
    mentionPending,
    mentionError,
    makeChipEl,
    disposeChips,
    serializeNode,
    serializeEditor,
    onEditorChanged,
    refreshTrigger,
    selectMention,
    onFieldInput,
    onFieldClick,
    onFieldKeyup,
    onFieldKeydown,
    setEditorFromText,
    clearEditor,
    focusEditorEnd,
    insertTextAtCaret,
  };
}
