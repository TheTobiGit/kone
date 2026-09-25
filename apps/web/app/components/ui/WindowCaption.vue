<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

// Renderer-drawn window caption for frameless shells (see utils/desktopShell;
// macOS keeps native traffic lights, the browser keeps its own chrome).
// Windows: a cluster fixed top-right over the content. Linux: a slim bar
// across the top that the app sits below (`--titlebar-h`), holding the drag
// surface and the same buttons. Above every surface so the controls stay
// reachable with any portal open. Mount once via Teleport to body —
// the stage transform would otherwise re-anchor `fixed` when the settings
// drawer slides it.

// The boot-time chrome decision (plugins/frameless), not a re-derivation.
const chrome = useNuxtApp().$shellChrome;
const maximized = ref(false);
let detachState: (() => void) | null = null;

function bridge() {
  if (!import.meta.client) return undefined;
  return window.koneDesktop?.window;
}

function refresh(state: { isMaximized: boolean }): void {
  maximized.value = state.isMaximized;
}

onMounted(() => {
  const api = bridge();
  if (!api || chrome === "native") return;
  void api.getState().then(refresh, () => {});
  detachState = api.onState(refresh);
});

onBeforeUnmount(() => {
  detachState?.();
  detachState = null;
});

function onMinimize(): void {
  void bridge()?.minimize();
}

function onToggle(): void {
  const api = bridge();
  if (!api) return;
  void api.toggleMaximize().then(refresh, () => {});
}

function onClose(): void {
  void bridge()?.close();
}
</script>

<template>
  <div
    v-if="chrome !== 'native'"
    class="caption"
    :class="{ 'caption--bar': chrome === 'titlebar' }"
    role="toolbar"
    aria-label="Window controls"
    @dblclick.self="onToggle"
  >
    <button
      type="button"
      class="cap-btn"
      aria-label="Minimize"
      title="Minimize"
      @click="onMinimize"
    >
      <span class="glyph glyph--min" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="cap-btn"
      :aria-label="maximized ? 'Restore' : 'Maximize'"
      :title="maximized ? 'Restore' : 'Maximize'"
      @click="onToggle"
    >
      <span
        :class="maximized ? 'glyph glyph--restore' : 'glyph glyph--max'"
        aria-hidden="true"
      />
    </button>
    <button
      type="button"
      class="cap-btn cap-btn--close"
      aria-label="Close"
      title="Close"
      @click="onClose"
    >
      <span class="glyph glyph--close" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
/* Fixed, never inside a surface, so no surface layout has to host it. Windows
   (overlay): a cluster top-right over the content, which surfaces clear (the
   `[data-chrome="overlay"]` rules in ProjectView, HomeHeader, HomeEmpty,
   AttentionGlobalBots). Linux (titlebar): a full-width bar, below. Explicit no-drag: the band underneath may be a drag
   region in frameless mode, and controls must never start a move. */
.caption {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 90;
  display: flex;
  align-items: stretch;
  height: 46px;
  -webkit-app-region: no-drag;
}
/* Linux: the whole top strip is the bar. It is the window's drag surface
   (double-click toggles maximize), with the buttons at its trailing end. */
.caption--bar {
  left: 0;
  justify-content: flex-end;
  height: var(--titlebar-h);
  /* Clear, not ground: the bar's lower edge overlaps the app's own top
     padding (`--titlebar-overlap`), so it must not paint over it. */
  background-color: transparent;
  -webkit-app-region: drag;
}
.caption--bar .cap-btn {
  width: 32px;
}
.caption--bar .glyph {
  width: 9px;
  height: 9px;
}
.caption--bar .glyph--close::before,
.caption--bar .glyph--close::after {
  left: 4px;
  height: 9px;
}
.caption--bar .glyph--restore::before,
.caption--bar .glyph--restore::after {
  width: 6px;
  height: 6px;
}
.cap-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.cap-btn:hover {
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
}
.cap-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.cap-btn--close:hover {
  background-color: #c42b1c;
  color: #fff;
}
/* Windows-convention glyphs, drawn in CSS so no icon dependency decides
   their weight. All 11px on a 1.5px stroke. */
.glyph {
  position: relative;
  display: block;
  width: 11px;
  height: 11px;
}
.glyph--min::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1.5px;
  background: currentColor;
}
.glyph--max::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 1.5px solid currentColor;
  border-radius: 1px;
}
.glyph--restore::before,
.glyph--restore::after {
  content: "";
  position: absolute;
  border: 1.5px solid currentColor;
  border-radius: 1px;
  background: transparent;
}
.glyph--restore::before {
  top: 0;
  right: 0;
  width: 8px;
  height: 8px;
  border-left: none;
  border-bottom: none;
}
.glyph--restore::after {
  bottom: 0;
  left: 0;
  width: 8px;
  height: 8px;
}
.glyph--close::before,
.glyph--close::after {
  content: "";
  position: absolute;
  left: 5px;
  top: 0;
  width: 1.5px;
  height: 11px;
  background: currentColor;
}
.glyph--close::before {
  transform: rotate(45deg);
}
.glyph--close::after {
  transform: rotate(-45deg);
}
</style>
