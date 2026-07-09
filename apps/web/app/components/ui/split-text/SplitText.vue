<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useIntersectionObserver } from "@vueuse/core";
import { motion } from "motion-v";
import { cn } from "~/lib/utils";
import { useMotionPreference } from "~/composables/useMotionPreference";

const props = withDefaults(
  defineProps<{
    text: string;
    by?: "chars" | "words";
    delay?: number;
    duration?: number;
    from?: Record<string, string | number | Array<string | number>>;
    to?: Record<string, string | number | Array<string | number>>;
    threshold?: number;
    active?: boolean;
    startDelay?: number;
    class?: string;
    as?: "p" | "div" | "span";
  }>(),
  {
    by: "chars",
    delay: 50,
    duration: 0.6,
    from: () => ({ opacity: 0, y: 40 }),
    to: () => ({ opacity: 1, y: 0 }),
    threshold: 0.1,
    active: undefined,
    startDelay: 0,
    class: "",
    as: "p",
  },
);

const { prefersReducedMotion } = useMotionPreference();

const el = ref<HTMLElement>();
const isInView = ref(false);
const isReady = ref(false);

watch(
  () => props.active,
  (value) => {
    if (value) isInView.value = true;
  },
  { immediate: true },
);

useIntersectionObserver(
  el,
  ([entry]) => {
    if (props.active !== undefined) return;
    if (entry?.isIntersecting) {
      isInView.value = true;
    }
  },
  { threshold: props.threshold },
);

onMounted(() => {
  if (prefersReducedMotion.value) {
    isReady.value = true;
    isInView.value = true;
    return;
  }

  nextTick(() => {
    requestAnimationFrame(() => {
      isReady.value = true;
    });
  });
});

const shouldAnimate = computed(
  () => !prefersReducedMotion.value && isReady.value && isInView.value,
);

const words = computed(() => {
  if (props.by === "words") {
    return props.text.split(" ").map((word, i, arr) => ({
      characters: [word],
      needsSpace: i < arr.length - 1,
    }));
  }
  return props.text.split(" ").map((word, i, arr) => ({
    characters: word.split(""),
    needsSpace: i < arr.length - 1,
  }));
});

function getDelay(globalIndex: number): number {
  return (props.startDelay + globalIndex * props.delay) / 1000;
}
</script>

<template>
  <component
    :is="as"
    ref="el"
    :class="
      cn(
        'flex flex-wrap whitespace-pre-wrap overflow-hidden',
        !isReady && !prefersReducedMotion && 'opacity-0',
        props.class,
      )
    "
  >
    <template v-if="prefersReducedMotion">
      {{ text }}
    </template>
    <template v-else>
      <span v-for="(word, wi) in words" :key="wi" class="inline-flex">
        <component
          :is="motion.span"
          v-for="(char, ci) in word.characters"
          :key="`${wi}-${ci}`"
          class="inline-block"
          :initial="from"
          :animate="shouldAnimate ? to : from"
          :transition="{
            duration,
            delay: getDelay(
              words
                .slice(0, wi)
                .reduce((sum, w) => sum + w.characters.length, 0) + ci,
            ),
            type: 'spring',
            damping: 25,
            stiffness: 300,
          }"
          style="will-change: transform, opacity"
        >
          {{ char }}
        </component>
        <span v-if="word.needsSpace" class="whitespace-pre">&nbsp;</span>
      </span>
    </template>
  </component>
</template>
