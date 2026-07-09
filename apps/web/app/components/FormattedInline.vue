<script setup lang="ts">
type InlinePart =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; value: string; href: string };

const props = defineProps<{
  text: string;
}>();

const INLINE_PATTERN =
  /(\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\))/;

function safeHref(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

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
    else if (match[6] && match[7]) {
      const href = safeHref(match[7]);
      parts.push(
        href
          ? { kind: "link", value: match[6], href }
          : { kind: "text", value: match[6] },
      );
    }

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
      <a
        v-else-if="part.kind === 'link'"
        :href="part.href"
        :target="part.href.startsWith('http') ? '_blank' : undefined"
        :rel="part.href.startsWith('http') ? 'noopener noreferrer' : undefined"
        class="text-sky-700 underline decoration-sky-500/30 underline-offset-2 transition-colors hover:text-sky-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 dark:text-sky-300 dark:hover:text-sky-200"
      >
        {{ part.value }}
      </a>
      <span v-else>{{ part.value }}</span>
    </template>
  </span>
</template>
