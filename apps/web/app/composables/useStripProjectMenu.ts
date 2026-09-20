import { onScopeDispose, ref } from "vue";
import { useEventListener } from "@vueuse/core";

// The project label's drop-down — the strip names the project its columns
// belong to, and pointing at that name offers the others.
//
// Hover opens it, but leaving does not close it at once: the pointer has to
// travel off the label and across a gap to reach the first entry, and a list
// that vanished mid-reach could never be clicked. A click latches it open
// instead, which is what keyboards and touch get, since neither ever sends a
// hover — and a latched menu survives a pointer that wanders away.
export function useStripProjectMenu(host: () => HTMLElement | null) {
  const open = ref(false);
  // Opened by a click rather than a hover, so a pointer leaving must not take
  // it away — only another click, Escape, or picking an entry.
  const latched = ref(false);

  // Long enough to cross the gap below the label without hurrying, short
  // enough that a pointer merely passing over the label doesn't leave a list
  // hanging behind it.
  const GRACE_MS = 200;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (closeTimer === null) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  function enter(): void {
    clearTimer();
    open.value = true;
  }

  function leave(): void {
    if (latched.value) return;
    clearTimer();
    closeTimer = setTimeout(() => {
      open.value = false;
      closeTimer = null;
    }, GRACE_MS);
  }

  function close(): void {
    clearTimer();
    open.value = false;
    latched.value = false;
  }

  function toggle(): void {
    if (latched.value) {
      close();
      return;
    }
    clearTimer();
    open.value = true;
    latched.value = true;
  }

  // A latched menu ignores the pointer leaving, so the only way back out with a
  // mouse is to click away from it. Pointerdown rather than click: the press is
  // where the intent is, and waiting for the release leaves the list standing
  // over whatever is being pressed.
  useEventListener(document, "pointerdown", (e: PointerEvent) => {
    if (!latched.value) return;
    const root = host();
    if (root && e.target instanceof Node && root.contains(e.target)) return;
    close();
  });

  onScopeDispose(clearTimer);

  return { open, enter, leave, toggle, close };
}
