import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

// The settings pages carry no visible scrollbar — instead a scroll region's top
// and bottom edges smoke out over whatever content runs past the cutout, and the
// fade only appears on an edge that actually has more content beyond it (crisp at
// the very top, crisp at the very bottom). The shade ramps over the first ~28px of
// scroll so it eases in rather than snapping on.
//
// This was copied verbatim into every data pane; it lives here now so every
// settings scroll region — the shell's built-in scroller and the two bespoke
// pages' own scrollers — smokes identically. Point it at the scrolling element,
// bind `maskStyle` to that element and `measure` to its scroll event.

const RAMP = 28;

export function useEdgeFade(scroll: Ref<HTMLElement | undefined>) {
  const fadeTop = ref(0);
  const fadeBot = ref(0);
  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;

  function measure(): void {
    const el = scroll.value;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    fadeTop.value = Math.min(el.scrollTop, RAMP);
    fadeBot.value = Math.min(Math.max(max - el.scrollTop, 0), RAMP);
  }

  // Opaque through the middle, ramping to transparent over whichever edge has
  // content beyond it. A crisp edge (nothing past it) resolves to 0px, so no fade.
  const maskStyle = computed(() => {
    const grad = `linear-gradient(to bottom, transparent 0, #000 ${fadeTop.value}px, #000 calc(100% - ${fadeBot.value}px), transparent 100%)`;
    return { maskImage: grad, WebkitMaskImage: grad } as const;
  });

  // The content resolves async and grows (cards, charts, SmoothResize), and the
  // drawer can resize — so both the content height and the viewport height change
  // after mount. Re-measure whenever either box does. The scrolling element can
  // itself be replaced (Providers keys its panel per provider), so re-attach when
  // the ref changes rather than observing once.
  function attach(): void {
    ro?.disconnect();
    ro = null;
    mo?.disconnect();
    mo = null;
    const el = scroll.value;
    if (!el) return;
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
    let inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    mo = new MutationObserver(() => {
      const nextInner = el.firstElementChild;
      if (nextInner !== inner) {
        if (inner) ro?.unobserve(inner);
        inner = nextInner;
        if (inner) ro?.observe(inner);
      }
      measure();
    });
    mo.observe(el, { childList: true });
    measure();
  }

  onMounted(attach);
  watch(scroll, attach, { flush: "post" });

  onBeforeUnmount(() => {
    ro?.disconnect();
    ro = null;
    mo?.disconnect();
    mo = null;
  });

  return { fadeTop, fadeBot, measure, maskStyle };
}

