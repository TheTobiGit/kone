<script setup lang="ts">
import { ref, type ComponentPublicInstance } from "vue";
import ConversationGlyph from "~/components/settings/ConversationGlyph.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import {
  RESPONSE_OPTIONS,
  type ChoiceOption,
  type ConversationSurface,
  type ResponseChoice,
  type ResponseDisplay,
} from "~/utils/responseDisplay";

// The Conversation page's choices: every choice a row of tiles, each tile a
// thumbnail of what it does (ConversationGlyph) and a word — no prose; the
// tile's sentence rides its tooltip and accessible name. Pointing at or
// focusing a tile probes it, so the stage can play that choice before it's
// made.

const props = defineProps<{
  open: boolean;
  /** Which surface is being set — the rows swap as one when it changes. */
  surface: ConversationSurface;
  /** The surface's choices as they're set. */
  display: ResponseDisplay;
  /** The tile being pointed at or focused, if any. */
  probe: ChoiceOption | null;
  /** The half of the turn the stage is playing, which lights its half here. */
  playing: "live" | "done";
}>();

const emit = defineEmits<{
  choose: [option: ChoiceOption];
  probe: [option: ChoiceOption | null];
}>();

type Row = { choice: ResponseChoice; title: string; options: readonly ChoiceOption[] };

const PHASES: { id: "live" | "done"; title: string; rows: Row[] }[] = [
  {
    id: "live",
    title: "While it works",
    rows: [
      { choice: "liveTools", title: "Tool calls", options: RESPONSE_OPTIONS.liveTools },
      { choice: "liveUpdates", title: "Updates", options: RESPONSE_OPTIONS.liveUpdates },
      { choice: "liveText", title: "Text", options: RESPONSE_OPTIONS.liveText },
    ],
  },
  {
    id: "done",
    title: "When it's done",
    rows: [
      { choice: "doneTools", title: "Tool calls", options: RESPONSE_OPTIONS.doneTools },
      { choice: "doneUpdates", title: "Updates", options: RESPONSE_OPTIONS.doneUpdates },
    ],
  },
];

const isSet = (opt: ChoiceOption) => props.display[opt.choice] === opt.id;

function choose(opt: ChoiceOption): void {
  if (!isSet(opt)) emit("choose", opt);
}
function leave(opt: ChoiceOption): void {
  if (props.probe === opt) emit("probe", null);
}

// The choices scroll on their own, under the same smoke as every settings page.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

// ── roving radios ─────────────────────────────────────────────────────────────
// Arrows move the selection and the focus together within a row, the way a
// native radiogroup does. Modified arrows and any key while the drawer is shut
// pass straight through — a focused radio mustn't swallow the app's shortcuts.
const tileEls = new Map<ChoiceOption, HTMLElement>();
function setTileEl(el: Element | ComponentPublicInstance | null, opt: ChoiceOption) {
  if (el instanceof HTMLElement) tileEls.set(opt, el);
  else tileEls.delete(opt);
}

function onKeydown(e: KeyboardEvent, row: Row, i: number) {
  if (!props.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
  const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
  if (!forward && !back) return;
  e.preventDefault();
  const n = row.options.length;
  const next = row.options[(i + (forward ? 1 : -1) + n) % n];
  if (!next) return;
  choose(next);
  tileEls.get(next)?.focus();
}
</script>

<template>
  <div ref="scroller" class="cv__choices" :style="maskStyle" @scroll.passive="measure">
    <Transition name="cv-swap" mode="out-in">
      <div :key="surface" class="cv__phases">
        <section
          v-for="(phase, pi) in PHASES"
          :key="phase.id"
          class="cv__phase"
          :class="{ 'cv__phase--now': playing === phase.id }"
          :style="{ '--i': pi }"
        >
          <h2 class="cv__phase-title">
            <i class="cv__beacon" aria-hidden="true" />
            {{ phase.title }}
          </h2>

          <div v-for="row in phase.rows" :key="row.choice" class="cv__row">
            <span :id="`cv-${row.choice}`" class="cv__row-title">{{ row.title }}</span>
            <div class="cv__tiles" role="radiogroup" :aria-labelledby="`cv-${row.choice}`">
              <button
                v-for="(opt, i) in row.options"
                :key="opt.id"
                :ref="(el) => setTileEl(el, opt)"
                type="button"
                role="radio"
                class="cv__tile"
                :class="{ 'cv__tile--on': isSet(opt) }"
                :aria-checked="isSet(opt)"
                :aria-label="`${opt.label} — ${opt.description}`"
                :title="opt.description"
                :tabindex="open && isSet(opt) ? 0 : -1"
                @click="choose(opt)"
                @keydown="onKeydown($event, row, i)"
                @pointerenter="emit('probe', opt)"
                @pointerleave="leave(opt)"
                @focus="emit('probe', opt)"
                @blur="leave(opt)"
              >
                <ConversationGlyph :kind="opt.glyph" :on="isSet(opt)" :live="probe ? probe === opt : isSet(opt)" />
                <span class="cv__tile-label">{{ opt.label }}</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
@keyframes cv-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* ── the choices ──────────────────────────────────────────────────────────── */
.cv__choices {
  min-height: 0;
  overflow-y: auto;
  overflow-x: clip;
  padding-block: 0.25rem 1.5rem;
  scrollbar-width: none;
}
.cv__choices::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.cv__phases {
  display: flex;
  flex-direction: column;
  gap: 30px;
}
.cv__phase {
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: cv-in var(--cv-t-enter) var(--cv-ease) backwards;
  animation-delay: calc(var(--i) * 70ms);
}
.cv__phase-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding-inline: 0.25rem;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  transition: color var(--cv-t-small) ease;
}
/* The beacon lights on the half of the turn the stage is playing — the
   settings acting right now. */
.cv__beacon {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  transition:
    background-color var(--cv-t-small) ease,
    box-shadow var(--cv-t-small) ease;
}
.cv__phase--now .cv__phase-title {
  color: var(--ink-soft);
}
.cv__phase--now .cv__beacon {
  background-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

/* A choice is a line: its name, then its tiles, which share one four-column
   grid so every row's tiles line up under the row above. */
.cv__row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}
.cv__row-title {
  padding: 20px 0 0 0.25rem;
  font-size: 13px;
  line-height: 1.2;
  color: var(--ink-soft);
}
.cv__tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.cv__tile {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  min-width: 0;
  padding: 5px 5px 7px;
  border-radius: 13px;
  text-align: center;
  cursor: pointer;
  transition: background-color var(--cv-t-micro) ease;
}
.cv__tile:hover {
  background-color: var(--hover);
}
.cv__tile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* One weight in the face, so the set tile is marked by colour — the label's
   ink, the glyph's accent — never by a heavier label. */
.cv__tile-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
  transition: color var(--cv-t-micro) ease;
}
.cv__tile:hover .cv__tile-label {
  color: var(--ink-soft);
}
.cv__tile--on .cv__tile-label {
  color: var(--ink);
}

.cv-swap-enter-active,
.cv-swap-leave-active {
  transition:
    opacity var(--cv-t-small) ease,
    transform var(--cv-t-small) var(--cv-ease);
}
.cv-swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.cv-swap-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .cv__phase {
    animation: none;
  }
}
</style>
