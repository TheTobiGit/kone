<script setup lang="ts">
// The Limits block from SettingsProvidersPane, as it is: the provider's own
// AgentSettingsLimits read, then the two what-happens-at-the-limit switches.
import AgentSettingsLimits from "~/components/agent/AgentSettingsLimits.vue";
import type { MockProvidersPane } from "./useMockProvidersPane";

withDefaults(defineProps<{ pane: MockProvidersPane; label?: boolean }>(), { label: true });
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
    </div>
  </section>
</template>
