import { computed, ref, type Ref } from "vue";
import {
  detectSlashCommandTrigger,
  filterSlashCommandItems,
  type SlashCommandItem,
  type SlashCommandTrigger,
} from "~/utils/composerMentions";

/** The composer's built-in `/` rows. Alphabetical by name — project/user
 *  file commands shadow by name once they exist. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandItem[] = [
  { name: "agent", title: "/agent", description: "Hand the turn to someone else" },
  { name: "branch", title: "/branch", description: "Switch or fork the thread branch" },
  { name: "compact", title: "/compact", description: "Compact the conversation" },
  { name: "model", title: "/model", description: "Open model picker" },
  { name: "new", title: "/new", description: "Start a new thread" },
];

export type DomSlashTrigger = { node: Text; start: number; end: number };

export function useComposerSlash(deps: {
  field: Ref<HTMLElement | null>;
  isOpen: () => boolean;
  /** The row only runs where its surface exists — `/agent` needs a roster. */
  canSwitchAgent: () => boolean;
  /** The row only runs where its surface exists — `/model` needs a picker. */
  canSwitchModel: () => boolean;
  /** The row only runs where compaction exists — `/compact` needs a host. */
  canCompact: () => boolean;
  /** The row only runs where the tray branch can switch — `/branch` needs a host picker. */
  canBranch: () => boolean;
  /** The row only runs where a fresh thread can start — `/new` needs a host. */
  canCreate: () => boolean;
  /** Re-serialize the DOM after a token mutation (the mentions' editor sync). */
  onMutated: () => void;
  onAccept: (item: SlashCommandItem) => void;
}) {
  const { field, isOpen, canSwitchAgent, canSwitchModel, canCompact, canBranch, canCreate, onMutated, onAccept } = deps;

  const slashTrigger = ref<SlashCommandTrigger | null>(null);
  const slashActiveIndex = ref(0);
  let domTrigger: DomSlashTrigger | null = null;

  const slashQuery = computed(() => slashTrigger.value?.query ?? "");
  /** Gated per row, not on busy: opening a picker or compacting is local
   *  ui, never a send, so a running turn must not hide any of them. */
  const slashItems = computed<SlashCommandItem[]>(() => {
    const visible = BUILTIN_SLASH_COMMANDS.filter((item) => {
      if (item.name === "compact") return canCompact();
      if (item.name === "branch") return canBranch();
      if (item.name === "new") return canCreate();
      if (item.name === "agent") return canSwitchAgent();
      return canSwitchModel();
    });
    return filterSlashCommandItems(visible, slashQuery.value);
  });
  const slashCount = computed(() => slashItems.value.length);
  const slashOpen = computed(
    () => isOpen() && slashTrigger.value !== null && slashCount.value > 0,
  );

  function readDomTrigger(): { trigger: SlashCommandTrigger; dom: DomSlashTrigger } | null {
    const root = field.value;
    const sel = "window" in globalThis ? window.getSelection() : null;
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (!(node instanceof Text) || !root.contains(node)) return null;
    const textNode = node;
    const trigger = detectSlashCommandTrigger(textNode.data, range.startOffset);
    if (!trigger) return null;
    return { trigger, dom: { node: textNode, start: trigger.rangeStart, end: range.startOffset } };
  }

  function refreshSlashTrigger(): void {
    const found = readDomTrigger();
    domTrigger = found?.dom ?? null;
    slashTrigger.value = found?.trigger ?? null;
    if (slashTrigger.value === null) slashActiveIndex.value = 0;
  }

  function dismissSlash(): void {
    slashTrigger.value = null;
    domTrigger = null;
    slashActiveIndex.value = 0;
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

  /** Delete the `/...` token under the caret, leaving the caret where the
   *  token started. The row's action (opening the picker) replaces the send. */
  function clearSlashToken(): boolean {
    const trig = domTrigger;
    const root = field.value;
    if (!trig || !root) return false;

    const after = trig.node.splitText(trig.end);
    trig.node.splitText(trig.start);
    const parent = trig.node.parentNode;
    const queryNode = trig.node.nextSibling;
    if (!parent || !queryNode) return false;
    parent.removeChild(queryNode);

    root.focus();
    placeCaret(after, 0);
    dismissSlash();
    onMutated();
    return true;
  }

  function acceptSlashAt(index: number): boolean {
    const item = slashItems.value[index];
    if (!item) return false;
    onAccept(item);
    return true;
  }

  /** Returns true when the keystroke was consumed by the slash menu. The host
   *  falls through to the mention handler otherwise — one token lives under
   *  the caret, so both menus can never be open at once. */
  function onSlashKeydown(e: KeyboardEvent): boolean {
    if (!slashOpen.value) return false;
    const count = slashCount.value;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (count) slashActiveIndex.value = (slashActiveIndex.value + 1) % count;
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count) slashActiveIndex.value = (slashActiveIndex.value - 1 + count) % count;
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (acceptSlashAt(slashActiveIndex.value)) {
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissSlash();
      return true;
    }
    return false;
  }

  return {
    slashTrigger,
    slashActiveIndex,
    slashQuery,
    slashOpen,
    slashCount,
    slashItems,
    refreshSlashTrigger,
    dismissSlash,
    clearSlashToken,
    acceptSlashAt,
    onSlashKeydown,
  };
}
