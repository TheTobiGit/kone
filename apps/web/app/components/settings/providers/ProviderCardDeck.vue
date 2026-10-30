<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { LinkSquare02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import ProviderDeckLimits, { pctLabel } from "~/components/provider/ProviderDeckLimits.vue";
import type { ProviderKind } from "~/types/desktop";
import type { HeroAction, ProviderPaneRow } from "./types";

defineProps<{
  rows: ProviderPaneRow[];
  selected: ProviderKind;
  open: boolean;
  heroStatus: string;
  heroAction: HeroAction;
}>();

const emit = defineEmits<{
  select: [provider: ProviderKind];
  action: [];
}>();

function cardLabel(row: ProviderPaneRow): string {
  const parts = [row.meta.label];
  if (row.signal) parts.push(row.signal.label);
  const spine = row.limits.spine;
  if (spine) parts.push(`${spine.label} ${pctLabel(spine)} used`);
  return parts.join(" — ");
}
</script>

<template>
  <div class="pp__deck" role="tablist" aria-label="Providers">
    <div
      v-for="row in rows"
      :key="row.provider"
      class="pp__card"
      :class="{
        'pp__card--on': selected === row.provider,
        'pp__card--off': !row.enabled || !row.shownInPicker,
      }"
      :style="{ '--grad': row.meta.grad }"
      role="tab"
      :aria-selected="selected === row.provider ? 'true' : 'false'"
      :aria-label="cardLabel(row)"
      :tabindex="open ? 0 : -1"
      @click="emit('select', row.provider)"
      @keydown.enter.prevent="emit('select', row.provider)"
      @keydown.space.prevent="emit('select', row.provider)"
    >
      <ProviderLogo :brand="row.meta.brand" tone="mono" :size="228" class="pp__ghost" />
      <ProviderLogo :brand="row.meta.brand" tone="mono" :size="19" class="pp__spinemark" />
      <span
        v-if="row.signal"
        class="pp__pip"
        :class="[`pp__pip--${row.signal.tone}`, { 'pp__pip--show': selected !== row.provider }]"
        aria-hidden="true"
      />
      <ProviderDeckLimits :readout="row.limits" :open="selected === row.provider" />

      <div class="pp__foot">
        <div class="pp__ident">
          <ProviderLogo :brand="row.meta.brand" tone="mono" :size="19" class="pp__identmark" />
          <span class="pp__identtext">
            <span class="pp__cardname">{{ row.meta.label }}</span>
            <span class="pp__cardstatus">{{ heroStatus }}</span>
          </span>
        </div>

        <a
          v-if="heroAction.kind === 'docs'"
          class="pp__pill"
          :href="heroAction.href"
          target="_blank"
          rel="noreferrer"
          :tabindex="open ? 0 : -1"
          @click.stop
        >
          {{ heroAction.label }}
          <HugeiconsIcon :icon="LinkSquare02Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </a>
        <button
          v-else
          type="button"
          class="pp__pill"
          :class="{ 'pp__pill--busy': heroAction.kind === 'busy' }"
          :disabled="heroAction.kind === 'busy' || heroAction.kind === 'idle'"
          :tabindex="open ? 0 : -1"
          @click.stop="emit('action')"
        >
          <HugeiconsIcon
            v-if="heroAction.kind === 'busy'"
            :icon="RefreshIcon"
            :size="12"
            :stroke-width="2"
            class="pp__spin"
            aria-hidden="true"
          />
          {{ heroAction.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.pp__card--off:not(.pp__card--on) {
  filter: saturate(0.55) brightness(0.92);
}

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
.pp__pip--update {
  background-color: rgba(255, 255, 255, 0.95);
}
.pp__pip--attention {
  background-color: var(--warn);
}
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
