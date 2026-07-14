<script setup lang="ts">
defineProps<{ label: string }>();
defineEmits<{ select: [] }>();
</script>

<template>
  <button
    type="button"
    class="group flex cursor-pointer items-center gap-3.5 rounded-[14px] py-[11px] pr-3 pl-1.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
    @click="$emit('select')"
  >
    <span class="flex w-[22px] shrink-0 items-center justify-center">
      <slot name="icon" />
    </span>
    <span
      class="text-ink"
      style="
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1;
      "
    >
      {{ label }}
    </span>
  </button>
</template>
