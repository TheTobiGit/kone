<script setup lang="ts">
// The provider deck from SettingsProvidersPane, as it is: one card open, the rest
// folded to a brand-hued spine. Markup and styles are copied unchanged; only the
// data comes from the mockup state.
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { LinkSquare02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import ProviderDeckLimits from "~/components/provider/ProviderDeckLimits.vue";
import type { MockProvidersPane } from "./useMockProvidersPane";

const props = defineProps<{ pane: MockProvidersPane; only?: boolean }>();

/** Every provider as a card, or with `only` just the open one at full width. */
const cards = computed(() =>
  props.only ? [props.pane.current.value] : props.pane.rows.value,
);

function heroClick() {
  const row = props.pane.current.value;
  if (props.pane.heroActionFor(row).kind === "toggle") props.pane.toggleEnabled(row.provider);
}
</script>

<template>
  <div class="pp__deck" role="tablist" aria-label="Providers">
    <div
      v-for="row in cards"
      :key="row.provider"
      class="pp__card"
      :class="{ 'pp__card--on': pane.selected.value === row.provider, 'pp__card--off': !row.enabled }"
      :style="{ '--grad': row.meta.grad }"
      role="tab"
      :aria-selected="pane.selected.value === row.provider ? 'true' : 'false'"
      :aria-label="pane.cardLabel(row)"
      tabindex="0"
      @click="pane.select(row.provider)"
      @keydown.enter.prevent="pane.select(row.provider)"
      @keydown.space.prevent="pane.select(row.provider)"
    >
      <ProviderLogo :brand="row.meta.brand" tone="mono" :size="228" class="pp__ghost" />
      <ProviderLogo :brand="row.meta.brand" tone="mono" :size="19" class="pp__spinemark" />
      <span
        v-if="row.signal"
        class="pp__pip"
        :class="[`pp__pip--${row.signal.tone}`, { 'pp__pip--show': pane.selected.value !== row.provider }]"
        aria-hidden="true"
      />
      <ProviderDeckLimits :readout="row.limits" :open="pane.selected.value === row.provider" />

      <div class="pp__foot">
        <div class="pp__ident">
          <ProviderLogo :brand="row.meta.brand" tone="mono" :size="19" class="pp__identmark" />
          <span class="pp__identtext">
            <span class="pp__cardname">{{ row.meta.label }}</span>
            <span class="pp__cardstatus">{{ pane.heroStatusFor(pane.current.value) }}</span>
          </span>
        </div>

        <a
          v-if="pane.heroActionFor(pane.current.value).kind === 'docs'"
          class="pp__pill"
          :href="(pane.heroActionFor(pane.current.value) as { href: string }).href"
          target="_blank"
          rel="noreferrer"
          @click.stop
        >
          {{ pane.heroActionFor(pane.current.value).label }}
          <HugeiconsIcon :icon="LinkSquare02Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </a>
        <button
          v-else
          type="button"
          class="pp__pill"
          :class="{ 'pp__pill--busy': pane.heroActionFor(pane.current.value).kind === 'busy' }"
          :disabled="['busy', 'idle'].includes(pane.heroActionFor(pane.current.value).kind)"
          @click.stop="heroClick"
        >
          <HugeiconsIcon
            v-if="pane.heroActionFor(pane.current.value).kind === 'busy'"
            :icon="RefreshIcon"
            :size="12"
            :stroke-width="2"
            class="pp__spin"
            aria-hidden="true"
          />
          {{ pane.heroActionFor(pane.current.value).label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── the deck ───────────────────────────────────────────────────────────────
   A row of cards: the open one grows to fill, the rest fold to a spine. The fold
   is a flex-grow transition — Chromium (this is Electron) animates it — so the
   cards ease open and shut rather than jumping. */
.pp__deck {
  display: flex;
  gap: 10px;
  height: 196px;
  flex-shrink: 0;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) 40ms backwards;
}
.pp__card {
  position: relative;
  flex-grow: 0;
  flex-basis: 64px;
  min-width: 64px;
  border-radius: 20px;
  overflow: hidden;
  cursor: pointer;
  background: var(--grad);
  transition:
    flex-grow var(--pp-t-fold) var(--pp-ease),
    filter var(--pp-t-micro) ease;
  will-change: flex-grow;
}
.pp__card--on {
  flex-grow: 1;
  cursor: default;
}
.pp__card:not(.pp__card--on):hover {
  filter: brightness(1.06);
}
.pp__card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 45%, transparent);
}
/* A folded provider the user has hidden from the picker still keeps its place —
   it just reads quieter. */
.pp__card--off:not(.pp__card--on) {
  filter: saturate(0.55) brightness(0.92);
}

/* The oversized logomark, bled off the card's trailing edge. */
.pp__ghost {
  position: absolute;
  top: 50%;
  right: -34px;
  transform: translateY(-50%);
  opacity: 0;
  color: #fff;
  pointer-events: none;
  transition: opacity var(--pp-t-fold) var(--pp-ease);
}
.pp__card--on .pp__ghost {
  opacity: 0.14;
}

/* The spine mark, centred low while the card is folded; it fades as the card
   opens and its own foot mark takes over. */
.pp__spinemark {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  color: #fff;
  opacity: 0.94;
  transition: opacity var(--pp-t-small) ease;
  pointer-events: none;
}
.pp__card--on .pp__spinemark {
  opacity: 0;
}

/* Signal pip: a single quiet dot near the top of a folded spine — no motion, no
   halo, just a mark that's there when you look. Colour carries the meaning; a
   hairline ring keeps that colour legible on any brand gradient without a heavy
   shadow. It fades out as its card opens (the open card speaks in full). */
.pp__pip {
  position: absolute;
  top: 15px;
  left: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  opacity: 0;
  transform: translateX(-50%);
  transition: opacity var(--pp-t-small) ease;
  pointer-events: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, #000 22%, transparent);
}
.pp__pip--show {
  opacity: 1;
}
/* An update is neutral news — the same light the open card's pill wears. */
.pp__pip--update {
  background-color: rgba(255, 255, 255, 0.95);
}
/* A sign-in is an ask, not a fault — a warm amber that reads on every wash. */
.pp__pip--attention {
  background-color: var(--warn);
}
/* Unreachable is the one state that alarms — the app's own delete/red. */
.pp__pip--problem {
  background-color: var(--danger);
}

.pp__foot {
  position: absolute;
  inset: auto 20px 18px 20px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity var(--pp-t-small) var(--pp-ease),
    transform var(--pp-t-small) var(--pp-ease);
  /* The folded card is 64px wide — its foot must not reflow while collapsed. */
  pointer-events: none;
}
.pp__card--on .pp__foot {
  opacity: 1;
  transform: none;
  transition-delay: 120ms;
  pointer-events: auto;
}
.pp__ident {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pp__identmark {
  flex-shrink: 0;
  color: #fff;
}
.pp__identtext {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pp__cardname {
  font-size: 14px;
  letter-spacing: -0.2px;
  line-height: 1.1;
  color: #fff;
  white-space: nowrap;
}
.pp__cardstatus {
  font-size: 11.5px;
  line-height: 1.2;
  color: rgba(255, 255, 255, 0.78);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The card's one pill: a solid light chip, dark ink — the Disconnect/Switch
   slot from the inspo, doubling as the state readout. */
.pp__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 32px;
  padding-inline: 15px;
  border-radius: 999px;
  background-color: rgba(255, 255, 255, 0.94);
  color: #17171a;
  font-size: 12px;
  letter-spacing: -0.1px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  text-decoration: none;
  transition:
    background-color var(--pp-t-micro) ease,
    transform var(--pp-t-micro) var(--pp-ease-move);
}
.pp__pill:hover:not(:disabled) {
  background-color: #fff;
  transform: translateY(-1px);
}
.pp__pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.7);
}
.pp__pill:disabled {
  cursor: default;
}
.pp__pill--busy {
  background-color: rgba(255, 255, 255, 0.78);
}

</style>
