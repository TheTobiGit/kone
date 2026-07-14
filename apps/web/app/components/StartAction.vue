<script setup lang="ts">
defineProps<{ label: string; loading?: boolean; disabled?: boolean }>();
defineEmits<{ select: [] }>();
</script>

<template>
  <button
    type="button"
    :disabled="loading || disabled"
    :aria-busy="loading || undefined"
    class="group flex cursor-pointer items-center gap-3.5 rounded-[14px] py-[11px] pr-3 pl-1.5 text-left transition-[color,opacity] duration-200 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
    :class="{ 'opacity-35': disabled && !loading }"
    @click="$emit('select')"
  >
    <span class="flex w-[22px] shrink-0 items-center justify-center">
      <!-- Ring spinner replaces the icon while this action is in session. -->
      <span
        v-if="loading"
        class="block h-[15px] w-[15px] animate-spin rounded-full border-[1.75px] border-muted/30 border-t-ink-soft"
      />
      <slot v-else name="icon" />
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
