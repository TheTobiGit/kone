<script setup lang="ts">
import { computed, ref, type StyleValue } from "vue";
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
  streaming?: boolean;
}>();

const blocks = computed(() => parseResponseBlocks(props.text));
const wordCount = computed(() => props.text.trim().split(/\s+/).filter(Boolean).length);
const shouldSplitText = computed(() => !props.streaming && wordCount.value <= 150);
const copiedCodeIndex = ref<number | null>(null);

const BLOCK_STAGGER_MS = 80;
const WORD_DELAY_MS = 35;

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

async function copyCode(text: string, index: number) {
  if (!import.meta.client || !navigator.clipboard) return;
  await navigator.clipboard.writeText(text);
  copiedCodeIndex.value = index;
  window.setTimeout(() => {
    if (copiedCodeIndex.value === index) copiedCodeIndex.value = null;
  }, 1400);
}
</script>

<template>
  <div
    class="response-content space-y-3"
    :aria-busy="streaming"
  >
    <template v-for="(block, index) in blocks" :key="`${index}-${block.type}`">
      <SplitText
        v-if="
          block.type === 'paragraph' &&
          !hasInlineMarkdown(block.text) &&
          shouldSplitText
        "
        :text="block.text"
        by="words"
        as="div"
        :active="true"
        :start-delay="blockStartDelay(index)"
        :delay="WORD_DELAY_MS"
        :duration="0.32"
        :from="{ opacity: 0, y: 6 }"
        :to="{ opacity: 1, y: 0 }"
        :class="`m-0 text-left ${bodyClass}`"
        :style="typographyStyle"
      />

      <component
        :is="streaming ? 'div' : motion.div"
        v-else-if="block.type === 'paragraph'"
        v-bind="
          streaming
            ? {}
            : {
                initial: { opacity: 0, y: 6 },
                animate: { opacity: 1, y: 0 },
                transition: fadeTransition(blockStartDelay(index)),
              }
        "
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
          v-if="shouldSplitText"
          :text="block.text"
          by="words"
          as="span"
          :active="true"
          :start-delay="blockStartDelay(index)"
          :delay="WORD_DELAY_MS"
          :duration="0.32"
          :from="{ opacity: 0, y: 6 }"
          :to="{ opacity: 1, y: 0 }"
          class="inline"
          :class="headingClass(block.level)"
        />
        <FormattedInline v-else :text="block.text" />
      </component>

      <component
        :is="streaming ? 'div' : motion.div"
        v-else-if="block.type === 'code'"
        v-bind="
          streaming
            ? {}
            : {
                initial: { opacity: 0, y: 8 },
                animate: { opacity: 1, y: 0 },
                transition: fadeTransition(blockStartDelay(index)),
              }
        "
        class="group/code -mx-2 overflow-hidden rounded-lg border border-zinc-200/70 bg-black/[0.025] dark:border-zinc-800 dark:bg-white/[0.035]"
        :style="typographyStyle"
      >
        <div class="flex min-h-8 items-center justify-between border-b border-zinc-200/70 px-3 dark:border-zinc-800">
          <span class="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">
            {{ block.language || "text" }}
          </span>
          <button
            type="button"
            class="text-[10px] font-mono uppercase tracking-[0.12em] text-zinc-400 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40"
            @click="copyCode(block.text, index)"
          >
            {{ copiedCodeIndex === index ? "Copied" : "Copy" }}
          </button>
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
            v-if="!hasInlineMarkdown(item) && shouldSplitText"
            :text="item"
            by="words"
            as="span"
            :active="true"
            :start-delay="blockStartDelay(index) + itemIndex * 80"
            :delay="WORD_DELAY_MS"
            :duration="0.32"
            :from="{ opacity: 0, y: 6 }"
            :to="{ opacity: 1, y: 0 }"
            class="inline"
            :class="bodyClass"
          />
          <component
            :is="streaming ? 'span' : motion.span"
            v-else
            v-bind="
              streaming
                ? {}
                : {
                    initial: { opacity: 0, y: 6 },
                    animate: { opacity: 1, y: 0 },
                    transition: fadeTransition(
                      blockStartDelay(index) + itemIndex * 80,
                    ),
                  }
            "
            class="inline"
          >
            <FormattedInline :text="item" />
          </component>
        </li>
      </component>

      <blockquote
        v-else-if="block.type === 'blockquote'"
        class="m-0 border-l border-zinc-300 py-0.5 pl-4 text-left font-light italic leading-relaxed text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
        :style="typographyStyle"
      >
        <FormattedInline :text="block.text" />
      </blockquote>

      <hr
        v-else-if="block.type === 'rule'"
        class="my-6 border-0 border-t border-zinc-200/80 dark:border-zinc-800/80"
      />

      <div
        v-else-if="block.type === 'table'"
        class="-mx-2 overflow-x-auto border-y border-zinc-200/80 dark:border-zinc-800/80"
      >
        <table class="w-full min-w-max border-collapse text-left text-sm">
          <thead>
            <tr class="border-b border-zinc-200/80 dark:border-zinc-800/80">
              <th
                v-for="header in block.headers"
                :key="header"
                class="px-2 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                <FormattedInline :text="header" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, rowIndex) in block.rows"
              :key="rowIndex"
              class="border-b border-zinc-200/50 last:border-b-0 dark:border-zinc-800/60"
            >
              <td
                v-for="(cell, cellIndex) in row"
                :key="cellIndex"
                class="px-2 py-2 font-light text-zinc-600 dark:text-zinc-400"
              >
                <FormattedInline :text="cell" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
