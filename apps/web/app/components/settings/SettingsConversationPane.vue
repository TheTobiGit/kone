<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { usePreferredReducedMotion } from "@vueuse/core";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import ConversationOptions from "~/components/settings/ConversationOptions.vue";
import ConversationStage from "~/components/settings/ConversationStage.vue";
import ConversationStylePicker from "~/components/settings/ConversationStylePicker.vue";
import { useConversationPreview } from "~/composables/useConversationPreview";
import { usePreviewOverride } from "~/composables/usePreviewOverride";
import {
  DEFAULT_DISPLAYS,
  SURFACES,
  sameDisplay,
  withChoice,
  type ChoiceOption,
  type ConversationSurface,
  type ResponseDisplay,
} from "~/utils/responseDisplay";
import type { ConversationStyle } from "~/utils/conversationStyle";

// How an agent's turns read — the Conversation page.
//
// The reader sets it per surface (the studio, the inbox, the assistant), and for
// each, in the two halves of a turn's life: while it works, and once it's done
// (ConversationOptions).
//
// The page's real answer to "what does this mean" is the stage beside the
// choices (ConversationStage): a turn playing on the actual thread renderer,
// under exactly the surface's choices. As the take moves through its two
// halves, the half of the page in effect lights up with it — so as the turn
// finishes, the eye is drawn from "While it works" to "When it's done" and sees
// which settings are acting. Point at a tile and the stage plays that choice
// instead, before it's made, and wears the accent while it does.
//
// Above all of it sits the style (ConversationStylePicker) — the layout every
// conversation is drawn in. It is one choice for every surface, so it sits
// above the surface switch rather than under it, and it probes the stage the
// same way a tile does.

defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const prefs = useResponsePrefs();

// ── the surface being set ─────────────────────────────────────────────────────
const surface = ref<ConversationSurface>("studio");
const surfaceIndex = computed(() => SURFACES.findIndex((s) => s.id === surface.value));

function pickSurface(id: ConversationSurface): void {
  if (surface.value === id) return;
  surface.value = id;
  displayPreview.clear();
  cue("toggle");
}

const current = computed(() => prefs.displays.value[surface.value]);
const isDefault = computed(() => sameDisplay(current.value, DEFAULT_DISPLAYS[surface.value]));

function reset(): void {
  prefs.reset(surface.value);
  cue("toggle");
}

function choose(opt: ChoiceOption): void {
  prefs.set(surface.value, opt);
  cue("toggle");
}

// ── preview overrides: one mechanism for both dimensions ────────────────────
// The display tiles below and the style picker above both probe the stage the
// same way — point at a tile and the stage plays that choice before it's made,
// wearing the accent while it does. Both go through `usePreviewOverride`: the
// display stages the surface's choices with the pointed-at choice swapped in,
// the style stages the pointed-at style outright. `probing` is the single
// source the stage reads — true while either dimension shows a try-on rather
// than what's set.
const conversationStyle = useConversationStyle();
// ChoiceOption carries label/description/glyph beyond the {choice,id} the
// display update needs, so it stages through an explicit probe type rather
// than letting P collapse to ResponsePick (which the options row rejects)
// or to unknown (which collapses staged with it).
const displayPreview = usePreviewOverride<ResponseDisplay, ChoiceOption>(
  current,
  withChoice,
  (c, p) => c[p.choice] !== p.id,
);
const stylePreview = usePreviewOverride<ConversationStyle, ConversationStyle>(
  conversationStyle.style,
  (c, p) => p,
  (c, p) => c !== p,
);
const probing = computed(() => displayPreview.active.value || stylePreview.active.value);

function chooseStyle(next: ConversationStyle): void {
  conversationStyle.set(next);
  cue("toggle");
}

const preview = useConversationPreview();
const reduced = usePreferredReducedMotion();
const playingHalf = preview.phase;

// A changed read — a surface switched, a tile pointed at, a choice made —
// replays the take from the top, so it's seen doing its thing rather than
// landing mid-sentence.
watch(displayPreview.staged, (next, prev) => {
  if (sameDisplay(next, prev)) return;
  if (preview.playing.value) preview.replay();
});

onMounted(() => {
  // A reduced-motion reader gets the settled turn, still; play is one press away.
  if (reduced.value === "reduce") preview.showSettled();
  else preview.start();
});
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
      <ConversationStylePicker
        :open="open"
        :value="conversationStyle.style.value"
        :probe="stylePreview.probe.value"
        @choose="chooseStyle"
        @probe="stylePreview.probe.value = $event"
      />

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
        <ConversationOptions
          :open="open"
          :surface="surface"
          :display="current"
          :probe="displayPreview.probe.value"
          :playing="playingHalf"
          @choose="choose"
          @probe="displayPreview.probe.value = $event"
        />
        <ConversationStage
          :open="open"
          :display="displayPreview.staged.value"
          :conversation-style="stylePreview.staged.value"
          :probing="probing"
          :blocks="preview.blocks.value"
          :now="preview.now.value"
          :playing="preview.playing.value"
          :done="playingHalf === 'done'"
          :progress="preview.progress.value"
          :take-id="preview.takeId.value"
          @replay="preview.replay()"
          @toggle="preview.toggle()"
        />
      </div>
    </div>
  </SettingsPageShell>
</template>

<style scoped>
/* Same motion vocabulary as the other pages: arrivals decelerate, things that
   move in place ease at both ends. The choices and the stage inherit it. */
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

/* A page too narrow for two columns stacks the stage over the choices. */
@media (max-width: 1180px) {
  .cv__body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cv__pill {
    transition: none;
  }
}
</style>
