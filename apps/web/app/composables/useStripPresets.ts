import { nextTick, onBeforeUnmount, ref, type Ref } from "vue";
import type { Pane, PaneId } from "~/types/board";
import { LADDER_PX } from "~/utils/stripScroll";
import { useSound } from "./useSound";

export const LAST_STEPPED = LADDER_PX.length - 2;
export const DEFAULT_PRESET = 0; // 840px — default and narrowest rung

export interface Preset {
  id: string;
  label: string;
  px: number;
  width: string;
}

export const PRESETS: Preset[] = LADDER_PX.map((px) => ({
  id: `w${px}`,
  label: String(px),
  px,
  width: `min(${px}px, 100vw)`,
}));

export const WIDTH_ANIM_MS = 520;

export function useStripPresets(deps: {
  panes: () => Pane[];
  focusedId: () => string | undefined;
  railWidth: Ref<number>;
  reducedMotionOn: () => boolean;
  onWidthEmit: (key: string, index: number) => void;
  onScrollToColumn: (key: string) => void;
}) {
  const {
    panes,
    focusedId,
    railWidth,
    reducedMotionOn,
    onWidthEmit,
    onScrollToColumn,
  } = deps;
  const { cue } = useSound();

  const widthAnim = ref<Record<string, boolean>>({});
  const animTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const zenIds = ref<Set<PaneId>>(new Set());

  function isSideChatPane(id: string): boolean {
    const c = panes().find((p) => p.id === id);
    return c?.kind === "thread" && !!c.session?.isSideChat.value;
  }

  function clampPreset(index: number): number {
    return Math.min(PRESETS.length - 1, Math.max(0, index));
  }

  function presetIndexFor(key: string): number {
    if (isSideChatPane(key)) return 0;
    const fromEntry = panes().find((c) => c.id === key)?.entry.width;
    return typeof fromEntry === "number" ? clampPreset(fromEntry) : DEFAULT_PRESET;
  }

  function zenPreset(): Preset {
    const px = railWidth.value || LADDER_PX[0];
    return { id: "zen", label: "max", px, width: `${px}px` };
  }

  function isZen(id: string): boolean {
    return zenIds.value.has(id) && id === focusedId();
  }

  function presetFor(key: string): Preset {
    if (isZen(key)) return zenPreset();
    return PRESETS[presetIndexFor(key)] ?? PRESETS[DEFAULT_PRESET]!;
  }

  function flagWidthAnim(key: string): void {
    widthAnim.value = { ...widthAnim.value, [key]: true };
    const prev = animTimers.get(key);
    if (prev) clearTimeout(prev);
    animTimers.set(
      key,
      setTimeout(() => {
        const { [key]: _, ...rest } = widthAnim.value;
        widthAnim.value = rest;
        animTimers.delete(key);
      }, WIDTH_ANIM_MS),
    );
  }

  function setPreset(key: string, index: number): void {
    if (isSideChatPane(key)) return;
    const next = clampPreset(index);
    if (next === presetIndexFor(key)) return;
    onWidthEmit(key, next);
    if (reducedMotionOn()) return;
    flagWidthAnim(key);
  }

  function cycleWidth(key: string): void {
    cue("press");
    const next =
      presetIndexFor(key) >= LAST_STEPPED
        ? 0
        : presetIndexFor(key) + 1 === LAST_STEPPED
          ? PRESETS.length - 1
          : presetIndexFor(key) + 1;
    setPreset(key, next);
    void nextTick(() => onScrollToColumn(key));
  }

  function growWidth(key: string): void {
    cue("press");
    setPreset(key, presetIndexFor(key) + 1);
    void nextTick(() => onScrollToColumn(key));
  }

  function shrinkWidth(key: string): void {
    cue("press");
    setPreset(key, presetIndexFor(key) - 1);
    void nextTick(() => onScrollToColumn(key));
  }

  function toggleZen(): void {
    const currentFocusedId = focusedId();
    if (!currentFocusedId || panes().length === 0 || isSideChatPane(currentFocusedId)) return;
    cue("toggle");
    const id = currentFocusedId;
    const next = new Set(zenIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    zenIds.value = next;
    if (!reducedMotionOn()) flagWidthAnim(id);
    void nextTick(() => onScrollToColumn(id));
  }

  onBeforeUnmount(() => {
    for (const t of animTimers.values()) clearTimeout(t);
    animTimers.clear();
  });

  return {
    PRESETS,
    DEFAULT_PRESET,
    zenIds,
    widthAnim,
    isSideChatPane,
    presetIndexFor,
    clampPreset,
    zenPreset,
    isZen,
    presetFor,
    flagWidthAnim,
    setPreset,
    cycleWidth,
    growWidth,
    shrinkWidth,
    toggleZen,
  };
}
