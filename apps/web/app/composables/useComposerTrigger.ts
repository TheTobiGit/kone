import { computed, ref, watch, type Ref } from "vue";
import {
  detectToken,
  type ComposerTrigger,
  type TriggerMarker,
} from "~/utils/composerMentions";

/** One live trigger across every composer marker: which marker opened it, the
 *  query since, and the range it covers. A single word carries a single first
 *  character, so this is one value — the `@` and `/` menus are mutually
 *  exclusive in state, never by which keystroke handler runs first. */
export type ActiveTrigger = ComposerTrigger & { marker: TriggerMarker };

export type DomTrigger = { node: Text; start: number; end: number };

/** Where a consumed token was: the parent to insert into, ahead of `after`. */
export type TokenInsertion = { parent: Node; after: Text };

/** One trigger state machine over the composer's contenteditable field,
 *  parameterized by marker set, row source, and applier. Both pickers share
 *  the DOM scan, the token consumption, and the keyboard protocol; only the
 *  rows and what a pick does differ. */
export function useComposerTrigger<T>(opts: {
  field: Ref<HTMLElement | null>;
  isOpen: () => boolean;
  markers: readonly TriggerMarker[];
  /** A marker that must stay shut where it is — `@` names files, so it hides
   *  while a turn runs; `/` rows are local UI, so they never do. */
  blocked?: (marker: TriggerMarker) => boolean;
  resolveItems: (trigger: ActiveTrigger) => readonly T[];
  applyItem: (item: T, trigger: ActiveTrigger) => void;
  /** Enter with no menu open — the draft's normal send. */
  onCommit?: () => void;
  /** Re-serialize the field after a token mutation (the editor sync). */
  onMutated?: () => void;
}) {
  const trigger = ref<ActiveTrigger | null>(null);
  const activeIndex = ref(0);
  let domTrigger: DomTrigger | null = null;

  const query = computed(() => trigger.value?.query ?? "");
  const marker = computed<TriggerMarker | null>(() => trigger.value?.marker ?? null);
  const items = computed<readonly T[]>(() =>
    trigger.value ? opts.resolveItems(trigger.value) : [],
  );
  const count = computed(() => items.value.length);
  const open = computed(
    () =>
      opts.isOpen() &&
      trigger.value !== null &&
      count.value > 0 &&
      !(opts.blocked?.(trigger.value.marker) ?? false),
  );

  /** The query for one marker, or "" when it isn't the live one — feeds row
   *  sources (like the file search) that only care about their own marker. */
  function queryFor(wanted: TriggerMarker): string {
    const current = trigger.value;
    return current && current.marker === wanted ? current.query : "";
  }

  function readDomTrigger(): { trigger: ActiveTrigger; dom: DomTrigger } | null {
    const root = opts.field.value;
    const sel = "window" in globalThis ? window.getSelection() : null;
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (!(node instanceof Text) || !root.contains(node)) return null;
    const textNode = node;
    const found = detectToken(textNode.data, range.startOffset, opts.markers);
    if (!found) return null;
    return {
      trigger: found,
      dom: { node: textNode, start: found.rangeStart, end: range.startOffset },
    };
  }

  function refreshTrigger(): void {
    const found = readDomTrigger();
    domTrigger = found?.dom ?? null;
    trigger.value = found?.trigger ?? null;
    if (trigger.value === null) activeIndex.value = 0;
  }

  function dismiss(): void {
    trigger.value = null;
    domTrigger = null;
    activeIndex.value = 0;
  }

  function setActiveIndex(index: number): void {
    activeIndex.value = index;
  }

  // The list refills under the cursor (file results landing, gates flipping),
  // so the keyboard index clamps wherever the count moves — one watch for both
  // markers, since there is only one index.
  watch(count, (next) => {
    activeIndex.value = Math.min(activeIndex.value, Math.max(0, next - 1));
  });

  function placeCaret(node: Node, offset: number): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Delete the live token, leaving the caret where it started. Hands back
   *  where the token was so a pick can insert its replacement (a chip) in the
   *  same spot; a row with nothing to insert ignores the return. */
  function consumeToken(): TokenInsertion | null {
    const trig = domTrigger;
    const root = opts.field.value;
    if (!trig || !root) return null;

    const after = trig.node.splitText(trig.end);
    trig.node.splitText(trig.start);
    const parent = trig.node.parentNode;
    const queryNode = trig.node.nextSibling;
    if (!parent || !queryNode) return null;
    parent.removeChild(queryNode);

    root.focus();
    placeCaret(after, 0);
    dismiss();
    opts.onMutated?.();
    return { parent, after };
  }

  function acceptItem(item: T): boolean {
    const trig = trigger.value;
    if (!trig) return false;
    opts.applyItem(item, trig);
    return true;
  }

  function acceptAt(index: number): boolean {
    const item = items.value[index];
    if (item === undefined) return false;
    return acceptItem(item);
  }

  /** Returns true when the keystroke was consumed by the trigger. With no menu
   *  open a plain Enter commits the draft — the one path both markers shared
   *  once their handlers fell through to each other. */
  function onKeydown(e: KeyboardEvent): boolean {
    if (open.value) {
      const total = count.value;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (total) activeIndex.value = (activeIndex.value + 1) % total;
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (total) activeIndex.value = (activeIndex.value - 1 + total) % total;
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (acceptAt(activeIndex.value)) {
          e.preventDefault();
          return true;
        }
        return false;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return true;
      }
      return false;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      opts.onCommit?.();
      return true;
    }
    return false;
  }

  return {
    trigger,
    activeIndex,
    query,
    marker,
    items,
    count,
    open,
    queryFor,
    refreshTrigger,
    dismiss,
    setActiveIndex,
    placeCaret,
    consumeToken,
    acceptItem,
    acceptAt,
    onKeydown,
  };
}
