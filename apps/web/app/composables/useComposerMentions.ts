import { computed, h, nextTick, render, type Ref } from "vue";
import MentionChip from "~/components/composer/MentionChip.vue";
import SkillChip from "~/components/composer/SkillChip.vue";
import type { SkillReference } from "~/types/desktop";
import {
  buildMentionItems,
  formatFileMention,
  type MentionItem,
  type MentionKind,
  type MentionProject,
} from "~/utils/composerMentions";
import {
  splitComposerDraftSegments,
  type ComposerDraftPart,
} from "~/utils/composerSkills";
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
  /** Skills a restored `/name` may turn back into a chip. */
  skills?: () => readonly SkillReference[];
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

  /** A skill chip: rendered like a mention chip, read back through its
   *  `data-skill-*` pair rather than `data-mention-path`, so nothing that
   *  collects mentions ever mistakes an invocation for context. */
  function makeSkillChipEl(skill: SkillReference): HTMLElement {
    const host = document.createElement("div");
    render(h(SkillChip, { name: skill.name, path: skill.path }), host);
    const mounted = host.firstElementChild;
    const chip = mounted instanceof HTMLElement ? mounted : null;
    if (!chip) {
      render(null, host);
      const span = document.createElement("span");
      span.textContent = skill.name;
      span.setAttribute("contenteditable", "false");
      span.dataset.skillName = skill.name;
      span.dataset.skillPath = skill.path;
      return span;
    }
    chipHosts.add(host);
    return chip;
  }

  function skillOf(el: HTMLElement): SkillReference | null {
    const name = el.dataset.skillName;
    return name === undefined ? null : { name, path: el.dataset.skillPath ?? "" };
  }

  function disposeChips(): void {
    for (const host of chipHosts) render(null, host);
    chipHosts.clear();
  }

  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    const el = node instanceof HTMLElement ? node : null;
    if (!el) return "";
    // The draft text a skill chip leaves is `/name`, so a saved draft can
    // re-chip it. It never reaches a turn: the send reads draftParts().
    const skill = skillOf(el);
    if (skill) return `/${skill.name}`;
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

  /** The field as prose and skill chips, in order — what a send splits into
   *  turn text and `skills[]`. Walks the same shape serializeNode does, so the
   *  two can only differ at the chips. */
  function draftParts(): ComposerDraftPart[] {
    const parts: ComposerDraftPart[] = [];
    let pending = "";
    const flush = () => {
      if (pending) parts.push({ type: "text", text: pending });
      pending = "";
    };
    const walk = (node: Node, root: boolean): void => {
      const el = node instanceof HTMLElement ? node : null;
      const skill = el ? skillOf(el) : null;
      if (skill) {
        flush();
        parts.push({ type: "skill", skill });
        return;
      }
      if (!el || el.dataset.mentionPath !== undefined || el.tagName === "BR") {
        pending += serializeNode(node);
        return;
      }
      if (!root && /^(DIV|P)$/.test(el.tagName)) pending += "\n";
      for (const child of Array.from(el.childNodes)) walk(child, false);
    };
    const el = field.value;
    if (el) walk(el, true);
    flush();
    const head = parts[0];
    if (head?.type === "text") head.text = head.text.replace(/^\n/, "");
    return parts;
  }

  /** Strike through the chips the conversation can't invoke any more (and
   *  clear the mark on ones it can again). Toggled in place — re-rendering
   *  the field would throw the caret away mid-sentence. */
  function markSkillChips(isAvailable: (skill: SkillReference) => boolean): void {
    const chips = field.value?.querySelectorAll<HTMLElement>("[data-skill-name]") ?? [];
    for (const chip of Array.from(chips)) {
      const skill = skillOf(chip);
      if (skill) chip.classList.toggle("mchip--unavailable", !isAvailable(skill));
    }
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
    insertChip(makeChipEl(item.path, item.kind), insertion, root);
  }

  /** Drop a picked skill where its `/` token was — the same landing as a
   *  mention, so the two chips edit alike. */
  function applySkill(skill: SkillReference, insertion: TokenInsertion | null): void {
    const root = field.value;
    if (!insertion || !root) return;
    insertChip(makeSkillChipEl(skill), insertion, root);
  }

  function insertChip(chip: HTMLElement, insertion: TokenInsertion, root: HTMLElement): void {
    const { parent, after } = insertion;
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

  function setEditorFromText(value: string, savedSkills?: readonly SkillReference[]): void {
    const el = field.value;
    if (!el) return;
    el.replaceChildren();
    disposeChips();
    // A restore re-chips from the draft's own saved skills, so the chips come
    // back in one pass without waiting for the live list to answer.
    const known = savedSkills ?? deps.skills?.() ?? [];
    for (const segment of splitComposerDraftSegments(value, known)) {
      if (segment.type === "mention") {
        el.appendChild(makeChipEl(segment.path, deps.resolveMentionKind?.(segment.path) ?? "file"));
      } else if (segment.type === "skill") {
        el.appendChild(makeSkillChipEl(segment.skill));
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
    applySkill,
    draftParts,
    markSkillChips,
    setEditorFromText,
    clearEditor,
    focusEditorEnd,
    insertTextAtCaret,
  };
}
