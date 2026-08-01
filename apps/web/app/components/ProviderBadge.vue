<script setup lang="ts">
import ProviderLogo from "~/components/ProviderLogo.vue";
import type { BrandKey } from "~/utils/modelCatalog";

// A provider mark with an optional vendor badge on its corner. For a harness
// provider (opencode) the mark is the harness itself and the corner badge is
// the model's true vendor (deepseek, openai, qwen, …) — so a row reads as
// "opencode, but this model". With no `corner` it is just the mark, so every
// call site can use one component.

const props = withDefaults(
  defineProps<{
    /** The main mark — a harness provider, or any single provider when there's
     *  no `corner`. */
    brand: BrandKey;
    /** The model's true vendor mark, shown as a small badge on the corner.
     *  Absent → the main mark alone. */
    corner?: BrandKey;
    size?: number;
  }>(),
  { size: 16 },
);
</script>

<template>
  <span class="pbadge">
    <ProviderLogo :brand="brand" :size="size" />
    <span v-if="corner" class="pbadge__corner" aria-hidden="true">
      <ProviderLogo :brand="corner" :size="Math.max(8, Math.round(size * 0.55))" />
    </span>
  </span>
</template>

<style scoped>
.pbadge {
  position: relative;
  display: inline-flex;
  flex: none;
  line-height: 0;
}
.pbadge__corner {
  position: absolute;
  right: -1px;
  bottom: -1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px;
  border-radius: 999px;
  background: var(--ground);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent);
}
</style>
