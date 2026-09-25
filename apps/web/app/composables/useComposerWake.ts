import { nextTick, onMounted, onUnmounted, ref, type Ref } from "vue";

// Whether the composer is the resting orb or the open card, and the morph
// between the two.
//
// Most composers rest as an orb and wake into a card: a click, a keystroke or a
// drop opens them, and clicking away or Escape folds them back. An always-open
// composer is born open and focused — it never shows the orb, so it has nothing
// to wake from and nothing to close to. That difference is decided here once,
// so the rest of the composer asks `open` and calls `wake`/`close` without
// caring which kind it is.

export function useComposerWake(options: {
  alwaysOpen: boolean;
  field: Ref<HTMLElement | null>;
  /** The card's current height; a close holds it for the fade, then rests it. */
  height: Ref<number>;
  /** The orb's height, which the card settles back to once closed. */
  restHeight: number;
  /** Measure the card and apply its height — called once a wake has rendered,
   *  so the orb expands straight into its final shape. */
  resize: () => void;
}) {
  const { alwaysOpen, field, height, restHeight, resize } = options;

  const open = ref(alwaysOpen);
  /** True through the wake's expand, so the resize takes the spring. */
  const opening = ref(false);
  /** Holds every transition off for the first frame of a composer that mounts
   *  open, so the card is simply there at its size rather than morphing out of
   *  an orb it never was. */
  const instant = ref(alwaysOpen);
  /** True through the close's fade, which holds the card at `closingHeight`. */
  const closing = ref(false);
  const closingHeight = ref(restHeight);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  async function wake(): Promise<void> {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    closing.value = false;
    if (open.value) {
      field.value?.focus();
      return;
    }
    open.value = true;
    opening.value = true;
    await nextTick();
    field.value?.focus();
    resize();
    window.setTimeout(() => (opening.value = false), 340);
  }

  /** Fade back to the resting orb with no movement. The draft stays in state,
   *  so waking again restores exactly what was there. */
  function close(): void {
    if (alwaysOpen || !open.value) return;
    if (closeTimer) clearTimeout(closeTimer);
    closingHeight.value = height.value;
    open.value = false;
    closing.value = true;
    closeTimer = setTimeout(() => {
      closing.value = false;
      height.value = restHeight;
      closeTimer = null;
    }, 200);
  }

  onMounted(() => {
    if (!alwaysOpen) return;
    // Focus after the tick, not now: the host's own mount hook runs after ours
    // and may read the element focused before it opened.
    void nextTick(() => field.value?.focus());
    requestAnimationFrame(() => requestAnimationFrame(() => (instant.value = false)));
  });
  onUnmounted(() => {
    if (closeTimer) clearTimeout(closeTimer);
  });

  return { open, opening, instant, closing, closingHeight, wake, close };
}
