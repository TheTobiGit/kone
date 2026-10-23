<script setup lang="ts">
// The open agent's accounts as one quiet strip: each credential on one chip, the
// active one marked. Signing in lives on the card and the Sign-in block, so the
// strip only ever adds.
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckmarkCircle02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { MockRow } from "~/mockups/providers-pane/useMockProvidersPane";
import { MOCK_ACCOUNTS } from "~/mockups/providers-pane/sample";

const props = defineProps<{ row: MockRow }>();

const accounts = computed(() => MOCK_ACCOUNTS[props.row.provider] ?? []);
</script>

<template>
  <div class="pc__accounts" role="group" aria-label="Accounts">
    <span
      v-for="account in accounts"
      :key="account.id"
      class="pc__acct"
      :class="{ 'pc__acct--on': account.active }"
    >
      <HugeiconsIcon
        v-if="account.active"
        :icon="CheckmarkCircle02Icon"
        :size="12"
        :stroke-width="2"
        class="pc__acctcheck"
        aria-hidden="true"
      />
      <span class="pc__acctlabel">{{ account.label }}</span>
      <span class="pc__sep" aria-hidden="true">·</span>
      <span class="pc__acctdetail">{{ account.detail }}</span>
    </span>

    <button type="button" class="pc__acct pc__acct--act pc__acct--add">
      <HugeiconsIcon :icon="PlusSignIcon" :size="12" :stroke-width="2" aria-hidden="true" />
      Add account
    </button>
  </div>
</template>

<style scoped>
.pc__accounts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pc__acct {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 1;
  color: var(--muted);
}
.pc__acct--on {
  border-color: var(--line);
}
.pc__acctcheck {
  flex-shrink: 0;
  color: var(--ink-soft);
}
.pc__acctlabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
.pc__acct--on .pc__acctlabel {
  color: var(--ink);
}
.pc__sep {
  color: var(--faint);
}
.pc__acctdetail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.pc__acct--act {
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    border-color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pc__acct--act:hover {
  border-color: var(--line);
  background-color: var(--hover);
}
.pc__acct--act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pc__acct--add {
  border-style: dashed;
  border-color: var(--line);
  color: var(--muted);
}
</style>
