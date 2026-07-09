<script setup lang="ts">
import { computed, h, ref, type StyleValue, type VNode } from "vue";
import { motion } from "motion-v";
import SplitText from "~/components/ui/split-text/SplitText.vue";
import FormattedInline from "~/components/FormattedInline.vue";
import {
  hasInlineMarkdown,
  parseResponseBlocks,
  stripInlineMarkdown,
  type ResponseListBlock,
  type ResponseListItem,
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
const wrappedCodeIndexes = ref<Set<number>>(new Set());

const BLOCK_STAGGER_MS = 80;
const WORD_DELAY_MS = 35;

const bodyClass =
  "font-light leading-relaxed tracking-tight text-ink-secondary";

function blockStartDelay(index: number) {
  return index * BLOCK_STAGGER_MS;
}

function headingClass(level: number) {
  if (level <= 1) {
    return "text-[1.05em] font-medium tracking-tight text-ink-primary";
  }
  if (level === 2) {
    return "text-[1.02em] font-medium tracking-tight text-ink-primary";
  }
  return "font-medium tracking-tight text-ink-primary";
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

function toggleWrap(index: number) {
  const next = new Set(wrappedCodeIndexes.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  wrappedCodeIndexes.value = next;
}

// Nested lists are rendered with small inline render functions (rather than a
// dedicated child component) so item markup — including the leaf-level
// SplitText/FormattedInline treatment — can recurse across indent levels
// without adding a new file.
function renderListItemContent(item: ResponseListItem, delay: number): VNode {
  if (!hasInlineMarkdown(item.text) && shouldSplitText.value) {
    return h(SplitText, {
      text: item.text,
      by: "words",
      as: "span",
      active: true,
      startDelay: delay,
      delay: WORD_DELAY_MS,
      duration: 0.32,
      from: { opacity: 0, y: 6 },
      to: { opacity: 1, y: 0 },
      class: `inline ${bodyClass}`,
    });
  }

  const content = h(FormattedInline, { text: item.text });

  if (props.streaming) {
    return h("span", { class: "inline" }, [content]);
  }

  return h(
    motion.span,
    {
      initial: { opacity: 0, y: 6 },
      animate: { opacity: 1, y: 0 },
      transition: fadeTransition(delay),
      class: "inline",
    },
    [content],
  );
}

function renderListLevel(
  block: ResponseListBlock,
  baseDelay: number,
  depth: number,
  style?: StyleValue,
): VNode {
  return h(
    block.ordered ? "ol" : "ul",
    {
      class: [
        "m-0 space-y-1.5 text-left",
        block.ordered ? "list-decimal" : "list-disc",
        bodyClass,
        depth > 0 ? "mt-1.5 pl-5" : "pl-5",
      ],
      style: depth === 0 ? style : undefined,
    },
    block.items.map((item, itemIndex) => {
      const delay = baseDelay + itemIndex * 80;
      return h("li", { key: itemIndex, class: "pl-1" }, [
        renderListItemContent(item, delay),
        item.children ? renderListLevel(item.children, delay, depth + 1) : null,
      ]);
    }),
  );
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
          <span class="text-[10px] font-mono uppercase tracking-[0.18em] text-ink-muted">
            {{ block.language || "text" }}
          </span>
          <span class="flex items-center gap-3">
            <button
              type="button"
              class="text-[10px] font-mono uppercase tracking-[0.12em] text-ink-muted opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
              @click="toggleWrap(index)"
            >
              {{ wrappedCodeIndexes.has(index) ? "Nowrap" : "Wrap" }}
            </button>
            <button
              type="button"
              class="text-[10px] font-mono uppercase tracking-[0.12em] text-ink-muted opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
              @click="copyCode(block.text, index)"
            >
              {{ copiedCodeIndex === index ? "Copied" : "Copy" }}
            </button>
          </span>
        </div>
        <pre
          class="m-0 px-3 py-2.5 font-mono text-[0.88em] leading-relaxed text-ink-code"
          :class="
            wrappedCodeIndexes.has(index)
              ? 'whitespace-pre-wrap break-words'
              : 'overflow-x-auto'
          "
        ><code>{{ block.text }}</code></pre>
      </component>

      <component
        :is="() => renderListLevel(block, blockStartDelay(index), 0, typographyStyle)"
        v-else-if="block.type === 'list'"
      />

      <blockquote
        v-else-if="block.type === 'blockquote'"
        class="m-0 border-l border-zinc-300 py-0.5 pl-4 text-left font-light italic leading-relaxed text-ink-secondary dark:border-zinc-700"
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
                class="px-2 py-2 text-xs font-medium text-ink-secondary"
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
                class="px-2 py-2 font-light text-ink-secondary"
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
