import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { useResizeObserver } from "@vueuse/core";
import { useSound } from "~/composables/useSound";
import { EDGE_REACH, edgeFades, sectionAt, type ColumnSpan } from "~/utils/spaceSections";

// The Space board's camera: a track of columns that pans sideways, the nav
// highlight that follows it, and the edge fades where the track cuts into a
// column. The board says which columns there are and which section each belongs
// to (see ~/utils/spaceBoard); this keeps everything that depends on where the
// camera is.

/** How long the section the camera was sent to keeps its landing wash. */
const LANDED_MS = 1200;

export function useSpaceCamera<S extends string, C extends string>(options: {
  /** The columns left to right, and the section each belongs to. */
  columns: ReadonlyArray<{ id: C; section: S }>;
  /** How far a column's content sits in from its edges at the tightest, so the
   *  edge fades stay off the gap between one column's content and the next. */
  inset: number;
  /** The tab is on screen. The track is re-measured when it comes back. */
  visible: () => boolean;
}) {
  const { columns: layout, inset } = options;
  const { cue } = useSound();

  const trackEl = ref<HTMLElement | null>(null);
  const fadeLeft = ref<HTMLElement | null>(null);
  const fadeRight = ref<HTMLElement | null>(null);
  const columns = new Map<C, HTMLElement>();

  const activeSection = ref<S>(layout[0]!.section);
  /** The section the camera was just sent to, for the landing wash. */
  const landed = ref<S | null>(null);
  let landedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Bound as a function ref on each column. */
  function setColumnRef(id: C, el: Element | ComponentPublicInstance | null): void {
    const node = el instanceof Element ? el : (el?.$el ?? null);
    if (node instanceof HTMLElement) columns.set(id, node);
    else columns.delete(id);
  }

  let spans: ColumnSpan<S>[] = [];

  /** Where each column sits in the track. Their widths come from CSS against the
   *  track, so this only changes when the track is resized. */
  function measure(): void {
    spans = layout.flatMap(({ id, section }) => {
      const el = columns.get(id);
      return el ? [{ section, left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth }] : [];
    });
    syncCamera();
  }

  /** The camera's position, read once and applied twice: to the nav's highlight
   *  and to the edge fades. The fades are sized on their elements directly, since
   *  going through state would re-render the board on every frame of a pan. */
  function syncCamera(): void {
    const track = trackEl.value;
    if (!track) return;
    const at = sectionAt(spans, track.scrollLeft);
    if (at) activeSection.value = at;

    const fades = edgeFades(spans, track.scrollLeft, track.clientWidth, inset);
    if (fadeLeft.value) fadeLeft.value.style.transform = `scaleX(${fades.left / EDGE_REACH})`;
    if (fadeRight.value) fadeRight.value.style.transform = `scaleX(${fades.right / EDGE_REACH})`;
  }

  // One read of the scroll position a frame, however many scroll events there were.
  let frame = 0;
  function onTrackScroll(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncCamera();
    });
  }

  useResizeObserver(trackEl, measure);

  /** Send the camera to a section's first column and wash the section. */
  function scrollToSection(id: S): void {
    if (activeSection.value !== id) cue("toggle");
    landed.value = id;
    if (landedTimer) clearTimeout(landedTimer);
    landedTimer = setTimeout(() => {
      landed.value = null;
    }, LANDED_MS);

    const track = trackEl.value;
    const headId = layout.find((c) => c.section === id)?.id;
    const head = headId === undefined ? undefined : columns.get(headId);
    if (!head || !track) return;
    // offsetLeft is track-relative because the track is positioned, and the pane
    // lies outside the track, so this lands the column's leading edge exactly on
    // the pane's edge. The highlight is left to follow the camera there: setting
    // it here would have it jump ahead and then fall back as the camera set off.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    track.scrollTo({
      left: head.offsetLeft,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }

  watch(options.visible, (vis) => {
    if (vis) void nextTick(measure);
  });
  onMounted(() => void nextTick(measure));
  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame);
    if (landedTimer) clearTimeout(landedTimer);
  });

  return { trackEl, fadeLeft, fadeRight, activeSection, landed, setColumnRef, onTrackScroll, scrollToSection };
}
