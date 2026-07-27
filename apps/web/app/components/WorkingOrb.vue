<script setup lang="ts">
import TurnOrb from "~/components/TurnOrb.vue";

defineProps<{
  hue?: string;
  width?: number;
  height?: number;
  active?: boolean;
}>();
</script>

<template>
  <TurnOrb state="working" :size="Math.min(width ?? 20, height ?? 20)" :active="active" aria-label="Working" />
</template>
