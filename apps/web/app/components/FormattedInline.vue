<script setup lang="ts">
type InlinePart =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string }
  | { kind: "code"; value: string };

const props = defineProps<{
  text: string;
}>();

const INLINE_PATTERN =
  /(\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*([^*]+)\*)/;

function parseInlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const match = remaining.match(INLINE_PATTERN);
    if (!match || match.index === undefined) {
      parts.push({ kind: "text", value: remaining });
      break;
    }

    if (match.index > 0) {
      parts.push({ kind: "text", value: remaining.slice(0, match.index) });
    }

    if (match[2]) parts.push({ kind: "strong", value: match[2] });
    else if (match[3]) parts.push({ kind: "strong", value: match[3] });
    else if (match[4]) parts.push({ kind: "code", value: match[4] });
    else if (match[5]) parts.push({ kind: "em", value: match[5] });

    remaining = remaining.slice(match.index + match[0].length);
  }

  return parts.filter((part) => part.value.length > 0);
}

const parts = computed(() => parseInlineParts(props.text));
</script>

<template>
  <span class="inline">
    <template v-for="(part, index) in parts" :key="index">
      <strong
        v-if="part.kind === 'strong'"
        class="font-medium text-zinc-800 dark:text-zinc-100"
      >
        {{ part.value }}
      </strong>
      <em v-else-if="part.kind === 'em'" class="italic text-zinc-600 dark:text-zinc-300">
        {{ part.value }}
      </em>
      <code
        v-else-if="part.kind === 'code'"
        class="rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-[0.92em] text-zinc-800 dark:bg-zinc-800/80 dark:text-zinc-200"
      >
        {{ part.value }}
      </code>
      <span v-else>{{ part.value }}</span>
    </template>
  </span>
</template>
