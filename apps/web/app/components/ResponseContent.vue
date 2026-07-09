<script setup lang="ts">
import type { StyleValue } from "vue";
import { motion } from "motion-v";
import SplitText from "~/components/ui/split-text/SplitText.vue";
import FormattedInline from "~/components/FormattedInline.vue";
import {
  hasInlineMarkdown,
  parseResponseBlocks,
  stripInlineMarkdown,
} from "~/lib/response-blocks";

const props = defineProps<{
  text: string;
  typographyStyle?: StyleValue;
}>();

const blocks = computed(() => parseResponseBlocks(props.text));

const BLOCK_STAGGER_MS = 120;
const WORD_DELAY_MS = 50;

const bodyClass =
  "font-light leading-relaxed tracking-tight text-zinc-700 dark:text-zinc-300";

function blockStartDelay(index: number) {
  return index * BLOCK_STAGGER_MS;
}

function headingClass(level: number) {
  if (level <= 1) {
    return "text-[1.05em] font-medium tracking-tight text-zinc-800 dark:text-zinc-100";
  }
  if (level === 2) {
    return "text-[1.02em] font-medium tracking-tight text-zinc-800 dark:text-zinc-100";
  }
  return "font-medium tracking-tight text-zinc-700 dark:text-zinc-200";
}

function fadeTransition(startDelay: number) {
  return {
    duration: 0.45,
    delay: startDelay / 1000,
    type: "spring" as const,
    damping: 28,
    stiffness: 320,
  };
}
</script>

<template>
  <div class="response-content space-y-3">
    <template v-for="(block, index) in blocks" :key="`${index}-${block.type}`">
      <SplitText
        v-if="block.type === 'paragraph' && !hasInlineMarkdown(block.text)"
        :text="block.text"
        by="words"
        as="div"
        :active="true"
        :start-delay="blockStartDelay(index)"
        :delay="WORD_DELAY_MS"
        :duration="0.38"
        :from="{ opacity: 0, y: 6 }"
        :to="{ opacity: 1, y: 0 }"
        :class="['m-0 text-left', bodyClass]"
        :style="typographyStyle"
      />

      <component
        :is="motion.div"
        v-else-if="block.type === 'paragraph'"
        :initial="{ opacity: 0, y: 6 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="fadeTransition(blockStartDelay(index))"
        :class="['m-0 text-left', bodyClass]"
        :style="typographyStyle"
      >
        <FormattedInline :text="block.text" />
      </component>

      <component
        :is="`h${Math.min(block.level, 3)}`"
        v-else-if="block.type === 'heading'"
        :class="[headingClass(block.level), 'm-0 text-left']"
        :style="typographyStyle"
      >
        <SplitText
          :text="block.text"
          by="words"
          as="span"
          :active="true"
          :start-delay="blockStartDelay(index)"
          :delay="WORD_DELAY_MS"
          :duration="0.38"
          :from="{ opacity: 0, y: 6 }"
          :to="{ opacity: 1, y: 0 }"
          class="inline"
          :class="headingClass(block.level)"
        />
      </component>

      <component
        :is="motion.div"
        v-else-if="block.type === 'code'"
        :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="fadeTransition(blockStartDelay(index))"
        class="overflow-hidden rounded-xl border border-zinc-200/80 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/70"
        :style="typographyStyle"
      >
        <div
          v-if="block.language"
          class="border-b border-zinc-200/80 px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500"
        >
          {{ block.language }}
        </div>
        <pre
          class="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[0.88em] leading-relaxed text-zinc-800 dark:text-zinc-200"
        ><code>{{ block.text }}</code></pre>
      </component>

      <component
        :is="block.ordered ? 'ol' : 'ul'"
        v-else-if="block.type === 'list'"
        class="m-0 space-y-1.5 pl-5 text-left"
        :class="[block.ordered ? 'list-decimal' : 'list-disc', bodyClass]"
        :style="typographyStyle"
      >
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex" class="pl-1">
          <SplitText
            v-if="!hasInlineMarkdown(item)"
            :text="item"
            by="words"
            as="span"
            :active="true"
            :start-delay="blockStartDelay(index) + itemIndex * 80"
            :delay="WORD_DELAY_MS"
            :duration="0.38"
            :from="{ opacity: 0, y: 6 }"
            :to="{ opacity: 1, y: 0 }"
            class="inline"
            :class="bodyClass"
          />
          <component
            :is="motion.span"
            v-else
            :initial="{ opacity: 0, y: 6 }"
            :animate="{ opacity: 1, y: 0 }"
            :transition="fadeTransition(blockStartDelay(index) + itemIndex * 80)"
            class="inline"
          >
            <FormattedInline :text="item" />
          </component>
        </li>
      </component>
    </template>
  </div>
</template>
