// The copy affordance every command row in direction C shares: copy, then flash
// the chip. Nothing leaves the renderer and nothing fails loudly — the string is
// already on screen, so a denied clipboard needs no error state.

import { onBeforeUnmount, ref } from "vue";

export function usePcCopy() {
  const copied = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(text: string) {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // A denied clipboard is not worth an error state — the text is on screen.
    }
    copied.value = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = null;
    }, 1600);
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
  });

  return { copied, copy };
}
