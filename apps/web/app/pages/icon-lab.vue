<script setup lang="ts">
import { computed, ref, type Component, type ComponentPublicInstance } from "vue";
import type { AnimatedIconHandle } from "~/components/icons/animated/useIconAnimation";

// Auto-collect every animated icon so the lab stays complete as the set grows.
// SAFETY: a Vite glob over *.vue SFCs yields modules whose default export is
// the component.
const modules = import.meta.glob("~/components/icons/animated/*.vue", {
  eager: true,
}) as Record<string, { default: Component }>;

const icons = computed(() =>
  Object.entries(modules)
    .map(([path, mod]) => ({
      name: path.split("/").pop()!.replace(/\.vue$/, ""),
      component: mod.default,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const size = ref(28);

// One handle per rendered icon, keyed by name, for replay + play-all.
const handles = ref<Record<string, AnimatedIconHandle | null>>({});
function setHandle(name: string, el: AnimatedIconHandle | Element | ComponentPublicInstance | null) {
  // SAFETY: every animated icon defineExpose()s { startAnimation,
  // stopAnimation } (the useIconAnimation contract); el is that exposed
  // instance, or null while unmounting.
  handles.value[name] = (el as AnimatedIconHandle) ?? null;
}
function replay(name: string) {
  handles.value[name]?.startAnimation();
}
function playAll() {
  for (const { name } of icons.value) {
    handles.value[name]?.startAnimation();
  }
}
</script>

<template>
  <main class="lab">
    <header class="lab__head">
      <div>
        <h1 class="lab__title">Animated icons</h1>
        <p class="lab__sub">
          {{ icons.length }} icons · hover to play, click to replay
        </p>
      </div>
      <div class="lab__controls">
        <label class="lab__size">
          <span>{{ size }}px</span>
          <input v-model.number="size" type="range" min="16" max="64" step="2" />
        </label>
        <button class="lab__play" type="button" @click="playAll">Play all</button>
      </div>
    </header>

    <section class="lab__grid">
      <button
        v-for="icon in icons"
        :key="icon.name"
        class="cell"
        type="button"
        :title="icon.name"
        @click="replay(icon.name)"
      >
        <span class="cell__icon">
          <component
            :is="icon.component"
            :ref="(el: any) => setHandle(icon.name, el)"
            :size="size"
          />
        </span>
        <span class="cell__name">{{ icon.name }}</span>
      </button>
    </section>
  </main>
</template>

<style scoped>
.lab {
  min-height: 100vh;
  padding: 48px clamp(20px, 5vw, 72px) 96px;
  color: var(--text, currentColor);
  background: var(--surface, transparent);
}

.lab__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 40px;
}

.lab__title {
  margin: 0;
  font-size: 22px;
  font-weight: 400;
  letter-spacing: -0.01em;
}

.lab__sub {
  margin: 6px 0 0;
  font-size: 13px;
  opacity: 0.55;
}

.lab__controls {
  display: flex;
  align-items: center;
  gap: 20px;
}

.lab__size {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  opacity: 0.7;
}

.lab__size input {
  accent-color: currentColor;
}

.lab__play {
  font: inherit;
  font-size: 13px;
  padding: 7px 16px;
  border: 1px solid color-mix(in oklab, currentColor 22%, transparent);
  border-radius: 999px;
  color: inherit;
  background: color-mix(in oklab, currentColor 6%, transparent);
  cursor: pointer;
  transition: background 0.2s ease;
}
.lab__play:hover {
  background: color-mix(in oklab, currentColor 12%, transparent);
}

.lab__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 28px 12px 18px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.18s ease;
}
.cell:hover {
  background: color-mix(in oklab, currentColor 6%, transparent);
}

.cell__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 64px;
}

.cell__name {
  font-size: 11px;
  opacity: 0.5;
  text-align: center;
  word-break: break-word;
}
</style>
