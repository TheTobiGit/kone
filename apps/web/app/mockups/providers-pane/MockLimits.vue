<script setup lang="ts">
// The Limits block from SettingsProvidersPane, as it is: the provider's own
// AgentSettingsLimits read, then the two what-happens-at-the-limit switches and
// the handoff history token cap.
import { ref } from "vue";
import AgentSettingsLimits from "~/components/agent/AgentSettingsLimits.vue";
import type { MockProvidersPane } from "./useMockProvidersPane";

withDefaults(defineProps<{ pane: MockProvidersPane; label?: boolean }>(), { label: true });

const handoffCap = ref("16,000");
</script>

<template>
  <section class="pp__block pp__limits" aria-label="Limits">
    <p v-if="label" class="pp__blocklabel">Limits</p>
    <AgentSettingsLimits :space="pane.space" :provider="pane.current.value.provider" :foot="false" />

    <div class="pp__limitrows">
      <button
        type="button"
        role="switch"
        class="pp__checkrow pp__limitrow"
        :aria-checked="pane.resumeAtReset(pane.current.value.provider)"
        @click="pane.toggleResumeAtReset(pane.current.value.provider)"
      >
        <span class="pp__checklabel">Auto-resume at reset</span>
        <span class="pp__switch" :class="{ 'pp__switch--on': pane.resumeAtReset(pane.current.value.provider) }">
          <i class="pp__knob" />
        </span>
      </button>

      <button
        type="button"
        role="switch"
        class="pp__checkrow pp__limitrow"
        :aria-checked="pane.snoozeWhenLimited(pane.current.value.provider)"
        @click="pane.toggleSnoozeWhenLimited(pane.current.value.provider)"
      >
        <span class="pp__checklabel">Snooze limited threads</span>
        <span class="pp__switch" :class="{ 'pp__switch--on': pane.snoozeWhenLimited(pane.current.value.provider) }">
          <i class="pp__knob" />
        </span>
      </button>

      <div class="pp__checkrow pp__limitrow pp__caprow">
        <span class="pp__checklabel">Handoff token cap</span>
        <span class="pp__capfield">
          <input
            v-model="handoffCap"
            type="text"
            class="pp__input pp__capinput"
            spellcheck="false"
            aria-label="Handoff token cap"
          />
          <span class="pp__capunit">tokens</span>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pp__caprow {
  cursor: default;
}
.pp__caprow:hover {
  background-color: transparent;
}
.pp__capfield {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pp__capinput {
  width: 84px;
  padding: 4px 8px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pp__capunit {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
</style>
