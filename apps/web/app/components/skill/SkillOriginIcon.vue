<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { PuzzleIcon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { brandForOrigin } from "~/utils/detailFormat";

// The mark for where a skill lives: a provider's own logomark, the dot for one
// without a mark, and a puzzle piece for the shared root, which no single
// provider owns. Decorative — the origin's name sits beside it.

withDefaults(defineProps<{ origin: string; size?: number }>(), { size: 14 });
</script>

<template>
  <HugeiconsIcon v-if="origin === 'agents'" :icon="PuzzleIcon" :size="size" :stroke-width="1.8" aria-hidden="true" />
  <ProviderLogo v-else :brand="brandForOrigin(origin)" :size="size" />
</template>
