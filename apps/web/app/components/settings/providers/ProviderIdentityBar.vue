<script setup lang="ts">
// Compact identity & provider control strip directly under the card deck.
// Replaces the redundant Sign-in block: shows the signed-in account pill +
// quiet Re-auth action on the left, and In picker / Enabled / deck order
// controls on the right.
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  CheckmarkCircle02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { canSignIn } from "~/utils/providerLogin";
import type { HeroAction, ProviderPaneRow } from "./types";

const props = defineProps<{
  row: ProviderPaneRow;
  index: number;
  total: number;
  open: boolean;
  heroAction: HeroAction;
}>();

const emit = defineEmits<{
  signin: [];
  toggleShownInPicker: [];
  toggleEnabled: [];
  move: [delta: -1 | 1];
}>();

const ready = computed(() => props.row.status?.readiness === "ready");
const notInstalled = computed(() => props.row.status?.readiness === "not-installed");
const signInCapable = computed(() => canSignIn(props.row.provider));
const authLabel = computed(() => props.row.status?.authLabel ?? "Signed in");
</script>

<template>
  <div class="pf__bar">
    <!-- Left: Identity status & sign-in / re-auth trigger -->
    <div class="pf__ident" role="group" aria-label="Account">
      <template v-if="notInstalled">
        <span class="pf__status pf__status--muted">Not installed</span>
      </template>

      <template v-else-if="ready">
        <span class="pf__acct pf__acct--on">
          <HugeiconsIcon
            :icon="CheckmarkCircle02Icon"
            :size="12"
            :stroke-width="2"
            class="pf__acctcheck"
            aria-hidden="true"
          />
          <span class="pf__acctlabel">{{ authLabel }}</span>
        </span>

        <button
          v-if="signInCapable"
          type="button"
          class="pp__btn pf__authbtn"
          :tabindex="open ? 0 : -1"
          @click="emit('signin')"
        >
          <HugeiconsIcon :icon="RefreshIcon" :size="12" :stroke-width="1.8" aria-hidden="true" />
          Re-auth
        </button>
      </template>

      <template v-else>
        <span class="pf__status pf__status--warn">
          <span class="pf__warndot" aria-hidden="true" />
          Not signed in
        </span>
        <button
          v-if="signInCapable && heroAction.kind !== 'signin'"
          type="button"
          class="pp__btn pp__btn--outline pf__signin"
          :tabindex="open ? 0 : -1"
          @click="emit('signin')"
        >
          Sign in
        </button>
      </template>
    </div>

    <!-- Right: In picker, Enabled, and deck order -->
    <div class="pf__controls">
      <button
        type="button"
        role="switch"
        class="pp__checkrow pf__ctl"
        :aria-checked="row.shownInPicker"
        :tabindex="open ? 0 : -1"
        @click="emit('toggleShownInPicker')"
      >
        <span class="pp__checklabel">In picker</span>
        <span class="pp__switch" :class="{ 'pp__switch--on': row.shownInPicker }">
          <i class="pp__knob" />
        </span>
      </button>

      <button
        type="button"
        role="switch"
        class="pp__checkrow pf__ctl"
        :aria-checked="row.enabled"
        :tabindex="open ? 0 : -1"
        @click="emit('toggleEnabled')"
      >
        <span class="pp__checklabel">Enabled</span>
        <span class="pp__switch" :class="{ 'pp__switch--on': row.enabled }">
          <i class="pp__knob" />
        </span>
      </button>

      <div class="pf__order" role="group" aria-label="Order">
        <button
          type="button"
          class="pp__btn pf__move"
          aria-label="Move earlier"
          :disabled="index <= 0"
          :tabindex="open ? 0 : -1"
          @click="emit('move', -1)"
        >
          <HugeiconsIcon
            :icon="ArrowUp02Icon"
            :size="14"
            :stroke-width="1.8"
            class="pf__left"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="pp__btn pf__move"
          aria-label="Move later"
          :disabled="index >= total - 1"
          :tabindex="open ? 0 : -1"
          @click="emit('move', 1)"
        >
          <HugeiconsIcon
            :icon="ArrowDown02Icon"
            :size="14"
            :stroke-width="1.8"
            class="pf__right"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pf__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 20px;
  margin-top: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.pf__ident {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pf__acct {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  font-size: 11.5px;
  line-height: 1;
  color: var(--ink);
}
.pf__acctcheck {
  flex-shrink: 0;
  color: var(--ink);
}
.pf__acctlabel {
  color: var(--ink);
}
.pf__authbtn {
  height: 26px;
  padding-inline: 8px;
  color: var(--muted);
}
.pf__authbtn:hover {
  color: var(--ink);
}
.pf__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-soft);
  padding-right: 4px;
}
.pf__status--warn {
  color: var(--warn);
}
.pf__status--muted {
  color: var(--muted);
}
.pf__warndot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--warn);
}
.pf__signin {
  padding: 4px 12px;
  font-size: 11.5px;
}

.pf__controls {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.pf__ctl {
  gap: 8px;
  padding: 3px 6px 3px 8px;
}
.pf__order {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
}
.pf__move {
  padding-inline: 6px;
}
.pf__left,
.pf__right {
  transform: rotate(-90deg);
}
</style>
