<script setup lang="ts">
import TurnOrb from "~/components/TurnOrb.vue";

defineProps<{
  hue?: string;
  size?: number;
  active?: boolean;
}>();
</script>

<template>
  <TurnOrb state="thinking" :size="size ?? 14" :active="active" aria-label="Thinking" />
</template>
