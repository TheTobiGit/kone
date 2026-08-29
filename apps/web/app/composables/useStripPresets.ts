import { nextTick, onBeforeUnmount, ref, type Ref } from "vue";
import type { Pane } from "~/types/studio";
import { LADDER_PX } from "~/utils/stripScroll";
import { useSound } from "./useSound";

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
  onZenEmit?: (key: string, zen: boolean) => void;
  onScrollToColumn: (key: string) => void;
}) {
  const {
    panes,
    focusedId,
    railWidth,
    reducedMotionOn,
    onWidthEmit,
    onZenEmit,
    onScrollToColumn,
  } = deps;
  const { cue } = useSound();

  const widthAnim = ref<Record<string, boolean>>({});
  const animTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    return fromEntry !== undefined && fromEntry !== null && Number.isFinite(fromEntry) ? clampPreset(fromEntry) : DEFAULT_PRESET;
  }

  function zenPreset(): Preset {
    const px = railWidth.value || LADDER_PX[0];
    return { id: "zen", label: "max", px, width: `${px}px` };
  }

  function isZen(id: string): boolean {
    const pane = panes().find((p) => p.id === id);
    return Boolean(pane?.entry.zen && id === focusedId());
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
    const pane = panes().find((p) => p.id === key);
    if (pane?.entry.zen) onZenEmit?.(key, false);
    if (next === presetIndexFor(key)) return;
    onWidthEmit(key, next);
    if (reducedMotionOn()) return;
    flagWidthAnim(key);
  }

  function cycleWidth(key: string): void {
    cue("press");
    const next = (presetIndexFor(key) + 1) % PRESETS.length;
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
    const pane = panes().find((p) => p.id === id);
    const next = !pane?.entry.zen;
    onZenEmit?.(id, next);
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
