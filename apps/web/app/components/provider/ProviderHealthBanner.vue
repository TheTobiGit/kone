<script setup lang="ts">
import { computed } from "vue";
import type { ProviderStatus } from "~/types/desktop";

// Why the thread's provider can't take a turn, said once, where the turn would
// have gone. It exists because the alternative is silence: the composer refuses
// the send and keeps the draft, and without this the user is left with a dead
// Enter key and no account of it.
//
// Deliberately quiet. A provider that needs a login is an errand, not an
// emergency — the sentence and a way to re-check, nothing that competes with
// the conversation for attention.

const props = defineProps<{
  /** The provider's last known health, or null while nothing is known. */
  status: ProviderStatus | null;
  /** The sentence to show. Null when the provider can take a turn — the banner
   *  renders nothing, so a host can bind it unconditionally. */
  reason: string | null;
  /** A re-check is in flight; the action reads as busy and can't be re-fired. */
  checking?: boolean;
}>();

const emit = defineEmits<{ recheck: [] }>();

// Not-installed is the only state the user can't clear from inside kone, so it
// is the only one drawn as a hard stop. Everything else is a warning: a signed
// out or slow CLI is one terminal command or one moment away from working.
const severe = computed(() => props.status?.readiness === "not-installed");
</script>

<template>
  <div v-if="reason" class="phb" :class="{ 'phb--severe': severe }" role="status">
    <p class="phb__text">{{ reason }}</p>
    <button
      type="button"
      class="phb__action"
      :disabled="checking"
      @click="emit('recheck')"
    >
      {{ checking ? "Checking…" : "Check again" }}
    </button>
  </div>
</template>

<style scoped>
.phb {
  --phb-tone: var(--warn);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 12px;
  border: 1px solid color-mix(in srgb, var(--phb-tone) 28%, transparent);
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--phb-tone) 8%, var(--raised));
}
.phb--severe {
  --phb-tone: var(--danger);
}

.phb__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink);
  /* The probe hands back whatever the CLI said, which can run long; three lines
     is enough to be useful and little enough to stay a banner. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.phb__action {
  flex: none;
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--phb-tone) 34%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    opacity 0.16s ease;
}
.phb__action:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--phb-tone) 14%, transparent);
}
.phb__action:disabled {
  opacity: 0.55;
  cursor: default;
}
.phb__action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--phb-tone) 42%, transparent);
}
</style>
