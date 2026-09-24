<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { usePreferredReducedMotion } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { BubbleChatIcon, PauseIcon, PlayIcon, ReplayIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import ConversationGlyph from "~/components/settings/ConversationGlyph.vue";
import ConversationThread from "~/components/conversation/ConversationThread.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { PREVIEW_HOLD_MS, useConversationPreview } from "~/composables/useConversationPreview";
import {
  DEFAULT_DISPLAYS,
  DONE_TOOL_OPTIONS,
  LIVE_TOOL_OPTIONS,
  SURFACES,
  TEXT_OPTIONS,
  UPDATES_OPTIONS,
  type ConversationSurface,
  type ResponseDisplay,
  type ResponseOption,
} from "~/utils/responseDisplay";

// How an agent's turns read — the Conversation page.
//
// The reader sets it per surface (the studio, the inbox, the assistant), and for
// each, in the two halves of a turn's life: while it works, and once it's done.
// Every choice is a row of tiles, each tile a thumbnail of what it does
// (ConversationGlyph) and a word — no prose; the tile's sentence rides its
// tooltip and accessible name.
//
// The page's real answer to "what does this mean" is the stage beside the
// choices: a turn playing on the actual thread renderer, under exactly the
// surface's choices. A thin line under it tracks the take through its two
// halves, and the half of the page in effect lights up with it — so as the turn
// finishes, the eye is drawn from "While it works" to "When it's done" and sees
// which settings are acting. Point at a tile and the stage plays that choice
// instead, before it's made, and wears the accent while it does.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const prefs = useResponsePrefs();

// ── the surface being set ─────────────────────────────────────────────────────
const surface = ref<ConversationSurface>("studio");
const surfaceIndex = computed(() => SURFACES.findIndex((s) => s.id === surface.value));

function pickSurface(id: ConversationSurface): void {
  if (surface.value === id) return;
  surface.value = id;
  probe.value = null;
  cue("toggle");
}

const current = computed(() => prefs.displays.value[surface.value]);
const isDefault = computed(
  () => JSON.stringify(current.value) === JSON.stringify(DEFAULT_DISPLAYS[surface.value]),
);

function reset(): void {
  prefs.displays.value = { ...prefs.displays.value, [surface.value]: DEFAULT_DISPLAYS[surface.value] };
  cue("toggle");
}

// ── the choices ───────────────────────────────────────────────────────────────
type Phase = keyof ResponseDisplay;
type Row = { phase: Phase; key: string; title: string; options: readonly ResponseOption<string>[] };

const PHASES: { id: Phase; title: string; rows: Row[] }[] = [
  {
    id: "live",
    title: "While it works",
    rows: [
      { phase: "live", key: "tools", title: "Tool calls", options: LIVE_TOOL_OPTIONS },
      { phase: "live", key: "updates", title: "Updates", options: UPDATES_OPTIONS },
      { phase: "live", key: "text", title: "Text", options: TEXT_OPTIONS },
    ],
  },
  {
    id: "done",
    title: "When it's done",
    rows: [
      { phase: "done", key: "tools", title: "Tool calls", options: DONE_TOOL_OPTIONS },
      { phase: "done", key: "updates", title: "Updates", options: UPDATES_OPTIONS },
    ],
  },
];

function valueOf(row: Row): string {
  return (current.value[row.phase] as Record<string, string>)[row.key] ?? "";
}

function choose(row: Row, id: string): void {
  if (valueOf(row) === id) return;
  // SAFETY: `id` comes from this row's own option list, so it is a value of the
  // choice the row names.
  prefs.set(surface.value, row.phase, row.key as never, id as never);
  cue("toggle");
}

// ── the stage ─────────────────────────────────────────────────────────────────
// What it plays: the surface's choices, or — while a tile is pointed at or
// focused — those choices with that one swapped in.
const probe = ref<{ row: Row; id: string } | null>(null);

const staged = computed<ResponseDisplay>(() => {
  const base: ResponseDisplay = { live: { ...current.value.live }, done: { ...current.value.done } };
  if (probe.value) {
    const { row, id } = probe.value;
    (base[row.phase] as Record<string, string>)[row.key] = id;
  }
  return base;
});

const probing = computed(() => probe.value !== null && valueOf(probe.value.row) !== probe.value.id);

function enter(row: Row, id: string): void {
  probe.value = { row, id };
}
function leave(row: Row, id: string): void {
  if (probe.value?.row === row && probe.value.id === id) probe.value = null;
}

const preview = useConversationPreview();
const reduced = usePreferredReducedMotion();

// A changed read — a surface switched, a tile pointed at, a choice made —
// replays the take from the top, so it's seen doing its thing rather than
// landing mid-sentence.
watch(staged, (next, prev) => {
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  if (preview.playing.value) preview.replay();
});

onMounted(() => {
  // A reduced-motion reader gets the settled turn, still; play is one press away.
  if (reduced.value === "reduce") preview.showSettled();
  else preview.start();
});

// The drawer parks this page offscreen rather than unmounting it; a turn nobody
// can see shouldn't keep playing.
watch(
  () => props.open,
  (open) => {
    if (!open && preview.playing.value) preview.toggle();
  },
);

// The stage follows the turn down as it grows, the way a live thread does.
const stageScroller = ref<HTMLElement>();
const { measure: measureStage, maskStyle: stageMask } = useEdgeFade(stageScroller);
watch(
  () => preview.blocks.value,
  () =>
    void nextTick(() => {
      const el = stageScroller.value;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      measureStage();
    }),
);

// The choices scroll on their own, under the same smoke as every settings page.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

// ── roving radios ─────────────────────────────────────────────────────────────
// Arrows move the selection and the focus together within a row, the way a
// native radiogroup does. Modified arrows and any key while the drawer is shut
// pass straight through — a focused radio mustn't swallow the app's shortcuts.
const tileEls = ref<Record<string, HTMLElement>>({});
function setTileEl(el: Element | ComponentPublicInstance | null, key: string) {
  if (el instanceof HTMLElement) tileEls.value[key] = el;
}
const tileKey = (row: Row, id: string) => `${row.phase}.${row.key}.${id}`;

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
  choose(row, next.id);
  tileEls.value[tileKey(row, next.id)]?.focus();
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Conversation"
    :breadcrumb-icon="BubbleChatIcon"
    label="Conversation settings"
    :scroll="false"
    @back="emit('back')"
  >
    <div class="cv">
      <!-- Which surface is being set. A segmented control whose pill slides to
           the one that's set, so switching reads as one motion. -->
      <div class="cv__top">
        <div class="cv__surfaces" role="tablist" aria-label="Where the conversation is">
          <i class="cv__pill" :style="{ '--n': SURFACES.length, '--i': surfaceIndex }" aria-hidden="true" />
          <button
            v-for="s in SURFACES"
            :key="s.id"
            type="button"
            role="tab"
            class="cv__surface"
            :class="{ 'cv__surface--on': surface === s.id }"
            :aria-selected="surface === s.id"
            :tabindex="open ? 0 : -1"
            @click="pickSurface(s.id)"
          >
            {{ s.label }}
          </button>
        </div>
        <Transition name="cv-fade">
          <button
            v-if="!isDefault"
            type="button"
            class="cv__reset"
            :tabindex="open ? 0 : -1"
            @click="reset"
          >
            Reset
          </button>
        </Transition>
      </div>

      <div class="cv__body">
        <!-- The choices ──────────────────────────────────────────────────── -->
        <div ref="scroller" class="cv__choices" :style="maskStyle" @scroll.passive="measure">
          <Transition name="cv-swap" mode="out-in">
            <div :key="surface" class="cv__phases">
              <section
                v-for="(phase, pi) in PHASES"
                :key="phase.id"
                class="cv__phase"
                :class="{ 'cv__phase--now': preview.phase.value === (phase.id === 'live' ? 'working' : 'done') }"
                :style="{ '--i': pi }"
              >
                <h2 class="cv__phase-title">
                  <i class="cv__beacon" aria-hidden="true" />
                  {{ phase.title }}
                </h2>

                <div v-for="row in phase.rows" :key="row.key" class="cv__row">
                  <span :id="`cv-${row.phase}-${row.key}`" class="cv__row-title">{{ row.title }}</span>
                  <div
                    class="cv__tiles"
                    role="radiogroup"
                    :aria-labelledby="`cv-${row.phase}-${row.key}`"
                  >
                    <button
                      v-for="(opt, i) in row.options"
                      :key="opt.id"
                      :ref="(el) => setTileEl(el, tileKey(row, opt.id))"
                      type="button"
                      role="radio"
                      class="cv__tile"
                      :class="{ 'cv__tile--on': valueOf(row) === opt.id }"
                      :aria-checked="valueOf(row) === opt.id"
                      :aria-label="`${opt.label} — ${opt.description}`"
                      :title="opt.description"
                      :tabindex="open ? (valueOf(row) === opt.id ? 0 : -1) : -1"
                      @click="choose(row, opt.id)"
                      @keydown="onKeydown($event, row, i)"
                      @pointerenter="enter(row, opt.id)"
                      @pointerleave="leave(row, opt.id)"
                      @focus="enter(row, opt.id)"
                      @blur="leave(row, opt.id)"
                    >
                      <ConversationGlyph
                        :kind="opt.glyph"
                        :on="valueOf(row) === opt.id"
                        :live="
                          probe
                            ? probe.row === row && probe.id === opt.id
                            : valueOf(row) === opt.id
                        "
                      />
                      <span class="cv__tile-label">{{ opt.label }}</span>
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </Transition>
        </div>

        <!-- The stage ────────────────────────────────────────────────────── -->
        <aside class="cv__stage" aria-label="Preview">
          <div class="cv__frame" :class="{ 'cv__frame--probe': probing }">
            <!-- A picture of a thread, not a thread: inert, so nothing in it
                 takes focus or a click, and the take plays on undisturbed. -->
            <div
              ref="stageScroller"
              class="cv__screen"
              :style="stageMask"
              inert
              @scroll.passive="measureStage"
            >
              <ConversationThread
                :blocks="preview.blocks.value"
                :now="preview.now.value"
                :display="staged"
                agent-seed="conversation-preview"
                :scratchpad="false"
                hide-empty-art
              />
            </div>

            <!-- The transport rides the frame's corner, out of the thread's way. -->
            <div class="cv__transport">
              <button
                type="button"
                class="cv__btn"
                :tabindex="open ? 0 : -1"
                aria-label="Replay the preview"
                @click="preview.replay()"
              >
                <HugeiconsIcon :icon="ReplayIcon" :size="14" :stroke-width="1.8" />
              </button>
              <button
                type="button"
                class="cv__btn"
                :tabindex="open ? 0 : -1"
                :aria-pressed="preview.playing.value"
                :aria-label="preview.playing.value ? 'Pause the preview' : 'Play the preview'"
                @click="preview.toggle()"
              >
                <HugeiconsIcon
                  :icon="preview.playing.value ? PauseIcon : PlayIcon"
                  :size="14"
                  :stroke-width="1.8"
                />
              </button>
            </div>
          </div>

          <!-- The take's two halves: working, then done. The half that's
               playing fills; the matching half of the page lights with it. -->
          <div class="cv__phaseline" aria-hidden="true">
            <span class="cv__seg cv__seg--live">
              <i
                class="cv__fill"
                :style="{
                  transform: `scaleX(${preview.phase.value === 'done' ? 1 : preview.progress.value})`,
                }"
              />
            </span>
            <span class="cv__seg cv__seg--done">
              <i
                :key="preview.takeId.value"
                class="cv__fill cv__fill--hold"
                :class="{ 'cv__fill--run': preview.phase.value === 'done' && preview.playing.value }"
                :style="{ '--hold': `${PREVIEW_HOLD_MS}ms` }"
              />
            </span>
          </div>
        </aside>
      </div>
    </div>
  </SettingsPageShell>
</template>

<style scoped>
/* Same motion vocabulary as the other pages: arrivals decelerate, things that
   move in place ease at both ends. */
.cv {
  --cv-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --cv-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --cv-t-micro: 140ms;
  --cv-t-small: 220ms;
  --cv-t-enter: 360ms;
  display: flex;
  flex-direction: column;
  gap: 18px;
  flex: 1;
  min-height: 0;
  padding-top: 0.25rem;
}

@keyframes cv-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* ── the surface switch ───────────────────────────────────────────────────── */
.cv__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-inline: 0.25rem;
}
.cv__surfaces {
  position: relative;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  padding: 3px;
  border-radius: 12px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
}
/* The pill under the set surface. It moves by transform, so a switch is one
   glide rather than two colour changes. */
.cv__pill {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 6px) / var(--n));
  border-radius: 9px;
  background-color: var(--ground);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent),
    0 1px 3px color-mix(in srgb, var(--ink) 10%, transparent);
  transform: translateX(calc(100% * var(--i)));
  transition: transform 320ms var(--cv-ease-move);
}
.cv__surface {
  position: relative;
  z-index: 1;
  min-width: 96px;
  padding: 6px 16px;
  border-radius: 9px;
  font-size: 13px;
  line-height: 1.2;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--cv-t-small) ease;
}
.cv__surface:hover {
  color: var(--ink-soft);
}
.cv__surface--on {
  color: var(--ink);
}
.cv__surface:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.cv__reset {
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--cv-t-micro) ease,
    color var(--cv-t-micro) ease;
}
.cv__reset:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.cv-fade-enter-active,
.cv-fade-leave-active {
  transition: opacity var(--cv-t-small) ease;
}
.cv-fade-enter-from,
.cv-fade-leave-to {
  opacity: 0;
}

/* ── the body ─────────────────────────────────────────────────────────────── */
.cv__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  gap: 28px;
  flex: 1;
  min-height: 0;
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

/* ── the stage ────────────────────────────────────────────────────────────── */
.cv__stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding-bottom: 0.5rem;
  animation: cv-in var(--cv-t-enter) var(--cv-ease) backwards;
  animation-delay: 120ms;
}
/* A window onto a thread: the thread's own ground, a hairline, and enough
   height that a whole turn has room to happen in it. */
.cv__frame {
  position: relative;
  flex: 1;
  min-height: 320px;
  border-radius: 18px;
  background-color: var(--ground);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 1px 2px color-mix(in srgb, var(--ink) 4%, transparent),
    0 12px 32px -18px color-mix(in srgb, var(--ink) 22%, transparent);
  overflow: hidden;
  transition: box-shadow var(--cv-t-small) ease;
}
/* Trying a tile on is the one moment the stage isn't showing what's set, so
   the frame says so in the accent — no caption needed. */
.cv__frame--probe {
  box-shadow:
    inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent),
    0 1px 2px color-mix(in srgb, var(--ink) 4%, transparent),
    0 12px 32px -18px color-mix(in srgb, var(--accent) 30%, transparent);
}
.cv__screen {
  position: absolute;
  inset: 0;
  padding: 22px 22px 48px;
  overflow-y: auto;
  scrollbar-width: none;
  scroll-behavior: smooth;
}
.cv__screen::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.cv__transport {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 11px;
  background-color: color-mix(in srgb, var(--ground) 82%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  opacity: 0.55;
  transition: opacity var(--cv-t-small) ease;
}
.cv__frame:hover .cv__transport,
.cv__transport:focus-within {
  opacity: 1;
}
/* The app's one button recipe: bare until hovered, then a soft pill. */
.cv__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color var(--cv-t-micro) ease;
}
.cv__btn:hover {
  background-color: var(--hover);
}
.cv__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The take's timeline: the working half long, the done half short, as a turn
   is. Hairline-thin, so it reads as a progress mark, not a control. */
.cv__phaseline {
  display: flex;
  gap: 4px;
  padding-inline: 6px;
}
.cv__seg {
  position: relative;
  height: 3px;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--ink) 9%, transparent);
  overflow: hidden;
}
.cv__seg--live {
  flex: 3;
}
.cv__seg--done {
  flex: 1;
}
.cv__fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-color: var(--accent);
  opacity: 0.7;
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 420ms var(--cv-ease);
}
/* The done half fills over the hold, so it empties into the next take. */
.cv__fill--hold {
  transition: none;
}
.cv__fill--run {
  animation: cv-hold var(--hold) linear forwards;
}
@keyframes cv-hold {
  to {
    transform: scaleX(1);
  }
}

/* A page too narrow for two columns stacks the stage over the choices, at a
   height that still fits a turn. */
@media (max-width: 1180px) {
  .cv__body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: 18px;
  }
  .cv__stage {
    order: -1;
  }
  .cv__frame {
    flex: none;
    height: clamp(240px, 36vh, 360px);
    min-height: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cv__phase,
  .cv__stage {
    animation: none;
  }
  .cv__pill,
  .cv__fill {
    transition: none;
  }
  .cv__fill--run {
    animation: none;
    transform: scaleX(1);
  }
  .cv__screen {
    scroll-behavior: auto;
  }
}
</style>
