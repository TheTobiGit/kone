<script setup lang="ts">
// Compact identity & provider control bar directly under the card deck.
// Replaces the old Sign-in block: account pills + switcher on the left,
// provider-wide controls (In picker, Enabled, deck order) on the right.
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  CheckmarkCircle02Icon,
  Logout03Icon,
  PlusSignIcon,
  RefreshIcon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import MockSwitch from "~/mockups/providers-pane/MockSwitch.vue";
import { MOCK_ACCOUNTS } from "~/mockups/providers-pane/sample";
import type { MockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";
import { canSignIn } from "~/utils/providerLogin";

const props = defineProps<{ pane: MockProvidersPane }>();

const row = computed(() => props.pane.current.value);
const rows = computed(() => props.pane.rows.value);
const index = computed(() => rows.value.findIndex((r) => r.provider === row.value.provider));
const ready = computed(() => row.value.status?.readiness === "ready");
const notInstalled = computed(() => row.value.status?.readiness === "not-installed");
const signInCapable = computed(() => canSignIn(row.value.provider));

const accounts = computed(() => MOCK_ACCOUNTS[row.value.provider] ?? []);
const chosenId = ref<string | null>(null);

watch(
  () => row.value.provider,
  () => {
    chosenId.value = null;
  },
);

const activeId = computed(
  () => chosenId.value ?? accounts.value.find((a) => a.active)?.id ?? null,
);
</script>

<template>
  <div class="pf__bar">
    <!-- Left: Identity & accounts -->
    <div class="pf__ident" role="group" aria-label="Account">
      <template v-if="notInstalled">
        <span class="pf__status pf__status--muted">Not installed</span>
      </template>

      <template v-else-if="ready && accounts.length">
        <button
          v-for="acct in accounts"
          :key="acct.id"
          type="button"
          class="pf__acct"
          :class="{ 'pf__acct--on': acct.id === activeId }"
          :aria-pressed="acct.id === activeId"
          @click="chosenId = acct.id"
        >
          <HugeiconsIcon
            v-if="acct.id === activeId"
            :icon="CheckmarkCircle02Icon"
            :size="12"
            :stroke-width="2"
            class="pf__acctcheck"
            aria-hidden="true"
          />
          <span class="pf__acctdetail">{{ acct.detail }}</span>
          <span class="pf__sep" aria-hidden="true">·</span>
          <span class="pf__acctlabel">{{ acct.label }}</span>
        </button>

        <button type="button" class="pf__acct pf__acct--add">
          <HugeiconsIcon :icon="PlusSignIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          Account
        </button>

        <button
          v-if="signInCapable"
          type="button"
          class="pp__btn pf__authbtn"
          title="Re-authenticate"
        >
          <HugeiconsIcon :icon="RefreshIcon" :size="12" :stroke-width="1.8" aria-hidden="true" />
          Re-auth
        </button>
        <button type="button" class="pp__btn pf__authbtn" title="Sign out">
          <HugeiconsIcon :icon="Logout03Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
          Sign out
        </button>
      </template>

      <template v-else-if="ready">
        <span class="pf__status">
          <HugeiconsIcon :icon="UserCheck01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          {{ row.status?.authLabel ?? "Signed in" }}
        </span>
        <button type="button" class="pf__acct pf__acct--add">
          <HugeiconsIcon :icon="PlusSignIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          Account
        </button>
      </template>

      <template v-else>
        <span class="pf__status pf__status--warn">
          <span class="pf__warndot" aria-hidden="true" />
          Not signed in
        </span>
        <button v-if="signInCapable && pane.heroActionFor(row).kind !== 'signin'" type="button" class="pp__btn pp__btn--outline pf__signin">
          Sign in
        </button>
        <button type="button" class="pf__acct pf__acct--add">
          <HugeiconsIcon :icon="PlusSignIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          Account
        </button>
      </template>
    </div>

    <!-- Right: Provider-level visibility, enablement, and deck order -->
    <div class="pf__controls">
      <div class="pp__checkrow pf__ctl">
        <span class="pp__checklabel">In picker</span>
        <MockSwitch
          :on="!row.hidden"
          label="In picker"
          @toggle="pane.toggleHidden(row.provider)"
        />
      </div>

      <div class="pp__checkrow pf__ctl">
        <span class="pp__checklabel">Enabled</span>
        <MockSwitch
          :on="row.enabled"
          label="Enabled"
          @toggle="pane.toggleEnabled(row.provider)"
        />
      </div>

      <div class="pf__order" role="group" aria-label="Order">
        <button
          type="button"
          class="pp__btn pf__move"
          aria-label="Move earlier"
          :disabled="index <= 0"
          @click="pane.move(row.provider, -1)"
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
          :disabled="index >= rows.length - 1"
          @click="pane.move(row.provider, 1)"
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
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition:
    border-color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease,
    color var(--pp-t-micro) ease;
}
.pf__acct:hover {
  border-color: var(--line);
  background-color: var(--hover);
  color: var(--ink-soft);
}
.pf__acct--on {
  border-color: var(--line);
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--ink);
}
.pf__acctcheck {
  flex-shrink: 0;
  color: var(--ink);
}
.pf__acctdetail {
  font-family: var(--font-mono);
  font-size: 11px;
  color: inherit;
}
.pf__sep {
  color: var(--muted);
  opacity: 0.6;
}
.pf__acctlabel {
  color: var(--muted);
}
.pf__acct--on .pf__acctlabel {
  color: var(--ink-soft);
}
.pf__acct--add {
  border-style: dashed;
  border-color: var(--line);
  color: var(--muted);
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
  cursor: default;
}
.pf__ctl.pp__checkrow:hover {
  background-color: transparent;
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
