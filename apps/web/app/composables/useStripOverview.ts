import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  type Ref,
} from "vue";

export const OVERVIEW_MIN_K = 0.44;
export const OVERVIEW_MAX_K = 0.58;
export const OVERVIEW_GUTTER = 48;
export const OVERVIEW_ANIM_MS = 420;
export const OVERVIEW_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const OVERVIEW_LIFT_PX = 14;

export function useStripOverview(deps: {
  rail: Ref<HTMLElement | null>;
  railWidth?: Ref<number>;
  reducedMotionOn: () => boolean;
}) {
  const { rail, reducedMotionOn } = deps;

  const overview = ref(false);
  const plane = ref<HTMLElement | null>(null);
  const naturalWidth = ref(0);

  const k = computed(() => {
    if (!overview.value) return 1;
    const railH = rail.value?.clientHeight;
    const naturalH = plane.value?.clientHeight || 720;
    if (railH && naturalH) {
      const fitHeight = (railH - 36) / naturalH;
      return Math.max(OVERVIEW_MIN_K, Math.min(OVERVIEW_MAX_K, fitHeight));
    }
    return 0.52;
  });

  const centerShift = computed(() => {
    if (!overview.value) return 0;
    return OVERVIEW_GUTTER;
  });

  function planeTransform(scale: number, shiftX: number): string {
    if (scale === 1 && shiftX === 0) return "none";
    return `translateX(${shiftX}px) translateY(${-OVERVIEW_LIFT_PX}px) scale(${scale})`;
  }

  const scalerStyle = computed(() =>
    overview.value && naturalWidth.value
      ? { width: `${naturalWidth.value * k.value + OVERVIEW_GUTTER * 2}px`, height: "100%" }
      : { width: "max-content", height: "100%" },
  );

  const planeStyle = computed(() =>
    overview.value && naturalWidth.value
      ? {
          width: `${naturalWidth.value}px`,
          transform: planeTransform(k.value, centerShift.value),
          transformOrigin: "0 50%",
          "--inv-k": 1 / k.value,
        }
      : {},
  );

  const isZooming = ref(false);
  let zoomTimer: ReturnType<typeof setTimeout> | null = null;

  function markZooming(): void {
    if (reducedMotionOn()) return;
    isZooming.value = true;
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      isZooming.value = false;
      zoomTimer = null;
    }, OVERVIEW_ANIM_MS);
  }

  const zoomBusy = ref(false);
  let busyTimer: ReturnType<typeof setTimeout> | null = null;

  function markZoomBusy(): void {
    zoomBusy.value = true;
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = setTimeout(
      () => {
        zoomBusy.value = false;
        busyTimer = null;
      },
      reducedMotionOn() ? 120 : OVERVIEW_ANIM_MS,
    );
  }

  let zoomAnim: Animation | null = null;

  function animateZoom(from: string): void {
    const p = plane.value;
    if (!p || reducedMotionOn()) return;
    markZooming();
    zoomAnim?.cancel();
    zoomAnim = p.animate(
      { transform: [from, planeTransform(k.value, centerShift.value)] },
      { duration: OVERVIEW_ANIM_MS, easing: OVERVIEW_EASE },
    );
  }

  function flipFrom(previous: string, beforeScroll: number, afterScroll: number): string {
    const shift = afterScroll - beforeScroll;
    if (previous === "none") return `translateX(${shift}px) scale(1)`;
    const scale = Number(previous.match(/scale\(([-\d.]+)\)/)?.[1] ?? 1);
    const tx = Number(previous.match(/translateX\(([-\d.]+)px\)/)?.[1] ?? 0);
    return `translateX(${tx + shift}px) translateY(${-OVERVIEW_LIFT_PX}px) scale(${scale})`;
  }

  async function remeasurePlane(): Promise<void> {
    const p = plane.value;
    const r = rail.value;
    if (!overview.value || !p || !r) return;
    const pinned = p.style.width;
    p.style.width = "max-content";
    const measured = p.scrollWidth;
    p.style.width = pinned;
    if (!measured || Math.abs(measured - naturalWidth.value) <= 1) return;
    const fromTransform = planeTransform(k.value, centerShift.value);
    const fromScroll = r.scrollLeft;
    naturalWidth.value = measured;
    await nextTick();
    animateZoom(flipFrom(fromTransform, fromScroll, r.scrollLeft));
  }

  onBeforeUnmount(() => {
    if (zoomTimer) clearTimeout(zoomTimer);
    if (busyTimer) clearTimeout(busyTimer);
    zoomAnim?.cancel();
  });

  return {
    overview,
    plane,
    naturalWidth,
    k,
    centerShift,
    planeTransform,
    scalerStyle,
    planeStyle,
    isZooming,
    zoomBusy,
    markZooming,
    markZoomBusy,
    animateZoom,
    flipFrom,
    remeasurePlane,
  };
}
