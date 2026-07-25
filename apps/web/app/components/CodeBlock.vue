<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { CodeLine } from "~/composables/useHighlighter";

// A fenced code block inside an agent reply — syntax-highlighted with the same
// Shiki engine (and VSCode themes) the file viewer uses, so code in the chat
// reads exactly like code in a file. A quiet header names the language and, on
// hover, offers a copy button; the body is coloured tokens (plain text until
// they arrive, and as a graceful fallback for unknown grammars).
//
// Borderless by house style — a soft tonal slab, no card outline, no shadow.

const props = defineProps<{ code: string; info: string }>();

const { cue } = useSound();
const { highlightCode } = useHighlighter();
const dark = usePreferredDark();

const lines = shallowRef<CodeLine[] | null>(null);
const lang = ref<string>("");

// Highlight on mount and re-tint when the colour scheme flips. A token guards
// against an out-of-order async resolve painting stale colours.
let seq = 0;
watch(
  [() => props.code, dark],
  async () => {
    const mine = ++seq;
    const res = await highlightCode(props.code, props.info, dark.value);
    if (mine !== seq) return;
    lines.value = res.lines;
    lang.value = res.lang;
  },
  { immediate: true },
);

// The plain-text rows we fall back to before highlighting lands (or when the
// grammar is unknown) — split so line height stays identical either way.
const plainRows = computed(() => props.code.replace(/\n$/, "").split("\n"));

// A friendly label for the header. "plaintext" / empty reads as nothing.
const LABELS: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", tsx: "TSX", jsx: "JSX",
  shellscript: "Shell", python: "Python", ruby: "Ruby", yaml: "YAML",
  json: "JSON", jsonc: "JSON", json5: "JSON5", markdown: "Markdown",
  rust: "Rust", go: "Go", cpp: "C++", csharp: "C#", kotlin: "Kotlin",
  html: "HTML", css: "CSS", vue: "Vue", sql: "SQL", graphql: "GraphQL",
  toml: "TOML", docker: "Dockerfile", diff: "Diff", xml: "XML",
};
const label = computed(() => {
  const l = lang.value;
  if (!l || l === "plaintext") return "";
  return LABELS[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
});

const copied = ref(false);
async function copy() {
  if (!import.meta.client) return;
  try {
    await navigator.clipboard.writeText(props.code.replace(/\n$/, ""));
    cue("toggle");
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}
</script>

<template>
  <figure class="cb">
    <figcaption class="cb__bar">
      <span class="cb__lang">{{ label || "code" }}</span>
      <button
        type="button"
        class="cb__copy"
        :aria-label="copied ? 'Copied' : 'Copy code'"
        @click="copy"
      >
        <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
        <span>{{ copied ? "Copied" : "Copy" }}</span>
      </button>
    </figcaption>

    <div class="cb__scroll" tabindex="-1">
      <pre class="cb__pre"><code
        v-if="lines"
      ><span v-for="(row, i) in lines" :key="i" class="cb__line"><span
        v-for="(t, j) in row" :key="j" :style="{ color: t.color }">{{ t.content }}</span><span v-if="row.length === 0"> </span>
</span></code><code v-else>{{ code.replace(/\n$/, "") }}</code></pre>
    </div>
  </figure>
</template>

<style scoped>
.cb {
  margin: 0 0 4px;
  border-radius: 13px;
  background: var(--code-bg, var(--hover));
  overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .cb { --code-bg: rgb(244 244 245 / 0.045); }
}

/* Header — language on the left, copy fading in on hover. */
.cb__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px 6px 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: lowercase;
  color: var(--muted);
}
.cb__lang {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cb__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 3px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease, background-color 0.15s ease, color 0.15s ease;
}
.cb:hover .cb__copy,
.cb__copy:focus-visible { opacity: 1; }
.cb__copy:hover { background: var(--hover); color: var(--ink); }

.cb__scroll {
  overflow-x: auto;
  padding: 0 14px 13px;
}
.cb__pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 20px;
}
.cb__pre code {
  display: block;
  padding: 0;
  background: none;
  font: inherit;
  white-space: pre;
}
.cb__line {
  display: block;
  min-height: 20px;
}
</style>
