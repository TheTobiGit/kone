<script setup lang="ts">
import { computed } from "vue";
import TurnOrb from "~/components/TurnOrb.vue";
import { stateForToolFamily, type TurnOrbState } from "~/utils/thinkingOrb";
import type { ToolOrbFamily } from "~/utils/toolOrbDraw";

const props = withDefaults(
  defineProps<{
    family: ToolOrbFamily;
    size?: number;
    active?: boolean;
  }>(),
  { size: 14, active: true },
);

const state = computed<TurnOrbState>(() => stateForToolFamily(props.family));
</script>

<template>
  <TurnOrb :state="state" :size="size" :active="active" :aria-label="`${family} tool running`" />
</template>
