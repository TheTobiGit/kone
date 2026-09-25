import type { ComponentPublicInstance } from "vue";

// The settings' roving radios — one behaviour shared by the style tiles and the
// choice tiles below them. Arrows move the selection and the focus together
// within a row, the way a native radiogroup does. Modified arrows and any key
// while the drawer is shut pass straight through — a focused radio mustn't
// swallow the app's shortcuts.
//
// `tileEls` keys on the item itself (the style option, the choice option), so
// `setTileEl` takes the item and `onKeydown` takes the row's items plus the
// row's `choose`. Both stay plain lookups — nothing here needs reactivity.

export function useRovingRadios<T>() {
  const tileEls = new Map<T, HTMLElement>();

  function setTileEl(el: Element | ComponentPublicInstance | null, item: T): void {
    if (el instanceof HTMLElement) tileEls.set(item, el);
    else tileEls.delete(item);
  }

  function onKeydown(
    e: KeyboardEvent,
    index: number,
    items: readonly T[],
    choose: (item: T) => void,
    open: boolean,
  ): void {
    if (!open) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
    const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
    if (!forward && !back) return;
    e.preventDefault();
    const n = items.length;
    if (n === 0) return;
    const next = items[(index + (forward ? 1 : -1) + n) % n];
    if (next === undefined) return;
    choose(next);
    tileEls.get(next)?.focus();
  }

  return { tileEls, setTileEl, onKeydown };
}
