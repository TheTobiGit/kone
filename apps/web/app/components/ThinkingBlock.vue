<script setup lang="ts">
import { computed, useId } from "vue";
import ShinyText from "~/components/ui/shiny-text/ShinyText.vue";

const props = withDefaults(
  defineProps<{
    text: string;
    active?: boolean;
  }>(),
  {
    active: false,
  },
);

const expanded = defineModel<boolean>("expanded", { default: true });
const regionId = `thinking-${useId()}`;

const label = computed(() => (props.active ? "Thinking" : "Thought process"));

const toggle = () => {
  expanded.value = !expanded.value;
};
</script>

<template>
  <div class="mt-3 w-full">
    <button
      type="button"
      class="group flex items-center gap-1.5 rounded-md py-1 text-xs text-ink-muted transition-colors hover:text-ink-secondary"
      :aria-expanded="expanded"
      :aria-controls="regionId"
      @click="toggle"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class="size-3.5 shrink-0"
        :class="active ? 'motion-safe:animate-[kone-breathe_2.4s_ease-in-out_infinite] text-accent-thought' : 'text-ink-muted'"
      >
        <path
          d="M12 18V5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M17.997 5.125a4 4 0 0 1 2.526 5.77"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M18 18a4 4 0 0 0 2-7.464"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M6 18a4 4 0 0 1-2-7.464"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M6.003 5.125a4 4 0 0 0-2.526 5.77"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>

      <ShinyText
        v-if="active"
        :text="label"
        class="font-medium tracking-tight"
        :speed="1.6"
        color="#a1a1aa"
        shine-color="#f4f4f5"
      />
      <span v-else class="font-medium tracking-tight">{{ label }}</span>

      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0 text-ink-muted transition-transform duration-300 ease-out"
        :class="expanded ? 'rotate-90' : 'rotate-0'"
      >
        <path
          d="M9 18l6-6-6-6"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div
      :id="regionId"
      role="region"
      aria-label="Assistant reasoning"
      class="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
      :style="{ gridTemplateRows: expanded ? '1fr' : '0fr' }"
    >
      <div class="overflow-hidden">
        <div
          class="ml-[7px] border-l border-zinc-200 py-1 pl-3 text-xs font-light leading-relaxed text-ink-muted whitespace-pre-wrap dark:border-zinc-800"
        >
          {{ text }}
        </div>
      </div>
    </div>
  </div>
</template>
