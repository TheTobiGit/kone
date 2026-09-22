<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { ProviderStatus } from "~/types/desktop";

const props = defineProps<{
  open: boolean;
  closing: boolean;
  blockedReason: string | null | undefined;
  healthStatus: ProviderStatus | null | undefined;
  healthChecking?: boolean;
}>();

const emit = defineEmits<{
  recheck: [];
}>();

// Null provider (nothing installed) and not-installed are the hard stop;
// everything else is a warning — a signed-out CLI is one terminal command
// away from working.
const severe = computed(
  () => !props.healthStatus || props.healthStatus.readiness === "not-installed",
);

const visible = computed(() => props.open && !!props.blockedReason);
</script>

<template>
  <div
    v-if="visible"
    class="status-tray"
    :class="{ 'is-shown': open && !closing, 'is-closing': closing, 'is-severe': severe }"
    role="status"
    aria-label="Provider status"
  >
    <span class="status-tray__item">
      <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" class="status-tray__alert" />
      <span class="status-tray__label">{{ blockedReason }}</span>
    </span>
    <button
      type="button"
      class="status-tray__item status-tray__action"
      :tabindex="open ? 0 : -1"
      :disabled="healthChecking"
      @click.stop="emit('recheck')"
    >
      <span class="status-tray__label status-tray__label--strong">{{
        healthChecking ? "Checking…" : "Check again"
      }}</span>
    </button>
  </div>
</template>

<style scoped>
/* The send-block reason, hanging off the top of the composer card. Its own
   slab — sunken ground washed with the tone — so it never re-states the base
   tray rules to zero them out. Severe (no provider, not installed) wears
   danger; warnings wear warn. */
.status-tray {
  --tray-tone: var(--warn);
  display: flex;
  align-items: flex-start;
  border-radius: 18px 18px 0 0;
  background: color-mix(in srgb, var(--tray-tone) 12%, var(--sunken));
  height: 40px;
  margin-bottom: -14px;
  padding-bottom: 0;
}
.status-tray.is-severe {
  --tray-tone: var(--danger);
}
.status-tray.is-shown {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition:
    height 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.06s,
    margin-bottom 0.3s cubic-bezier(0.22, 1, 0.36, 1) 0.06s,
    opacity 0.24s ease 0.14s;
}
.status-tray.is-closing {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.status-tray__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-top: 9px;
}
.status-tray__item:first-child {
  flex: 1;
  min-width: 0;
}
.status-tray__item:last-child {
  margin-left: auto;
}
.status-tray__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.status-tray__label--strong {
  font-weight: 600;
}
.status-tray__alert {
  flex: none;
  color: var(--tray-tone);
}
.status-tray__action {
  margin-top: 7px;
  margin-bottom: 2px;
  padding: 2px 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  color: inherit;
}
.status-tray__action:hover {
  background: transparent;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, var(--tray-tone) 65%, transparent);
}
.status-tray__action:hover .status-tray__label {
  opacity: 0.9;
}
.status-tray__action:disabled {
  opacity: 0.45;
  cursor: default;
}
.status-tray__action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--tray-tone) 42%, transparent);
}
</style>
