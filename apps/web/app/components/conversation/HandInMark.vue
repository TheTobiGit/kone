<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { effortMeta, type EffortTier } from "~/utils/modelCatalog";
import { brainStack } from "~/utils/subagentRuns";
import { type HandInMark } from "~/utils/handInMarkers";

// One hand-in line in the timeline flow: the thread carried on here in new
// hands. Both ends are named, because which model answered above the line is
// as much the point as which one answers below it — and the two names with an
// arrow between them already say "this became that", so no verb is spelled
// out. The accessible name still carries one: a screen reader gets no arrow.
//
// When the tier moved with the hands, it rides inside each leg in parentheses
// rather than stacking a second row underneath: the user made one decision at
// the picker, and two lines above one request would read as two changes.
//
// Inert — unlike a handoff there is nowhere to jump to, the conversation is
// this one.

const props = defineProps<{
  mark: HandInMark;
  /** The tier change this hand-in carried, when the same pick moved it.
   *  Absent when only the hands changed — the marker then says only that. */
  effort?: { from: EffortTier; to: EffortTier };
}>();

const legs = computed(() =>
  (["from", "to"] as const).map((side) => ({
    side,
    hands: props.mark[side],
    effort: props.effort ? effortMeta(props.effort[side]) : null,
  })),
);

const label = computed(() => {
  const say = (side: "from" | "to"): string => {
    const tier = props.effort ? effortMeta(props.effort[side]).label : null;
    return tier ? `${props.mark[side].label} at ${tier}` : props.mark[side].label;
  };
  return `Continued by ${say("to")}, from ${say("from")}`;
});
</script>

<template>
  <div class="thread-mark hand-in-mark" :aria-label="label">
    <template v-for="(leg, i) in legs" :key="leg.side">
      <span v-if="i > 0" class="hand-in-arrow" aria-hidden="true">→</span>
      <span class="hand-in-leg" :class="{ 'hand-in-leg--from': leg.side === 'from' }">
        <ProviderLogo :brand="leg.hands.brand" :size="13" />
        <span>{{ leg.hands.label }}</span>
        <span v-if="leg.effort" class="hand-in-effort">
          <span aria-hidden="true">(</span>
          <span class="hand-in-brains" aria-hidden="true">
            <HugeiconsIcon
              v-for="n in brainStack(leg.effort.brains)"
              :key="`${leg.side}-${n}`"
              :icon="AiBrain01Icon"
              :size="13"
              :stroke-width="2"
              :style="{ color: leg.effort.hue }"
            />
          </span>
          <span>{{ leg.effort.label }}</span>
          <span aria-hidden="true">)</span>
        </span>
      </span>
    </template>
  </div>
</template>

<style scoped>
.hand-in-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  font-size: 12px;
  color: var(--muted);
  user-select: none;
}
.hand-in-leg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 550;
  color: var(--ink-soft);
}
/* The hands it left, dimmed against the hands it is in now: the eye should
   land on who is answering from here down. */
.hand-in-leg--from {
  font-weight: 500;
  opacity: 0.72;
}
.hand-in-effort {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-weight: 500;
  color: var(--muted);
}
.hand-in-brains {
  display: inline-flex;
  align-items: center;
}
.hand-in-arrow {
  color: var(--muted);
}
</style>
