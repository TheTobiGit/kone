import { ref } from "vue";

/**
 * How long the card's exit animation runs. The caller is handed back control only
 * once it has finished, so a modal is never unmounted mid-flight — which would cut
 * the animation to a hard pop. Changing this without changing the exit transition
 * to match reintroduces exactly that pop.
 */
const EXIT_MS = 240;

/**
 * Drives a modal's show/exit lifecycle: bind `shown` to the card's animated state,
 * mount with `shown.value = true`, and route every dismissal through `close`.
 */
export function useModalExit() {
  const shown = ref(false);
  const closing = ref(false);

  /**
   * Plays the exit, then hands control back to the caller. Calls made while an exit
   * is already running are ignored, so a key that schedules a close and a second key
   * landing inside the same window cannot both fire — only the first close wins.
   */
  function close(done: () => void): void {
    if (closing.value) return;
    closing.value = true;
    shown.value = false;
    window.setTimeout(done, EXIT_MS);
  }

  return { shown, closing, close };
}
