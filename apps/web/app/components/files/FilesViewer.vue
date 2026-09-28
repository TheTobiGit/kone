<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { ProjectFileText } from "~/types/desktop";
import type { CodeLine } from "~/composables/useHighlighter";

// One file, read-only: the Files tab's right-hand pane. The text is read and
// highlighted before it is shown (skeleton → coloured code, never a plain
// flash), re-tinted in place when the scheme flips, and re-read when `version`
// ticks — the space bumps it when the working tree moves, so an agent's edit
// shows up without the user having to reopen the file.

const props = defineProps<{
  root: string;
  path: string;
  /** Bumped by the parent to ask for a re-read of the same path. */
  version: number;
}>();

const fs = useFileSystem();
const { highlight } = useHighlighter();
const { scheme } = useTheme();

const file = shallowRef<ProjectFileText | null>(null);
const tokenLines = shallowRef<CodeLine[] | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

const wrap = ref(false);
const richPreview = ref(true);

const ext = computed(() => props.path.split(".").pop()?.toLowerCase() ?? "");
const isMarkdown = computed(() => ["md", "mdx", "markdown"].includes(ext.value));
const showPreview = computed(
  () => isMarkdown.value && richPreview.value && Boolean(file.value?.text),
);

let token = 0;
async function read(keepOnScreen: boolean): Promise<void> {
  const mine = ++token;
  if (!keepOnScreen) {
    loading.value = true;
    file.value = null;
    tokenLines.value = null;
  }
  error.value = null;
  try {
    const result = await fs.readProjectFile(props.root, props.path);
    if (mine !== token) return;
    const tokens = result.text ? await highlight(result.text, props.path, scheme.value === "dark") : null;
    if (mine !== token) return;
    file.value = result;
    tokenLines.value = tokens;
  } catch (e) {
    if (mine !== token) return;
    file.value = null;
    tokenLines.value = null;
    error.value = e instanceof Error ? e.message : "Couldn’t read this file.";
  } finally {
    if (mine === token) loading.value = false;
  }
}

watch(() => [props.root, props.path], () => void read(false), { immediate: true });
// Same file, fresh content: keep the old text up until the new read lands.
watch(() => props.version, () => void read(true));

watch(scheme, async () => {
  const text = file.value?.text;
  if (!text) return;
  const mine = token;
  const tinted = await highlight(text, props.path, scheme.value === "dark");
  if (mine === token && tinted) tokenLines.value = tinted;
});

const plainLines = computed(() => (file.value?.text ?? "").split("\n"));
const rows = computed<CodeLine[] | string[]>(() => tokenLines.value ?? plainLines.value);
const lineCount = computed(() => plainLines.value.length);

const note = computed(() => {
  if (loading.value) return null;
  if (error.value) return error.value;
  const f = file.value;
  if (!f) return "Couldn’t read this file.";
  if (f.binary) return "Binary file — no preview.";
  if (f.text === "") return "Empty file.";
  return null;
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const crumbs = computed(() => props.path.split("/"));
</script>

<template>
  <section class="fv">
    <header class="fv__bar">
      <nav class="fv__crumbs" :aria-label="`Path: ${path}`">
        <template v-for="(part, i) in crumbs" :key="i">
          <span v-if="i > 0" class="fv__sep" aria-hidden="true">/</span>
          <span :class="i === crumbs.length - 1 ? 'fv__leaf' : 'fv__dir'">{{ part }}</span>
        </template>
      </nav>
      <div class="fv__meta">
        <span v-if="file && !file.binary && file.text">{{ lineCount.toLocaleString() }} lines</span>
        <span v-if="file">{{ formatSize(file.size) }}</span>
        <button
          v-if="isMarkdown"
          type="button"
          class="fv__toggle"
          :class="{ 'is-on': richPreview }"
          :aria-pressed="richPreview"
          @click="richPreview = !richPreview"
        >
          Preview
        </button>
        <button
          v-if="!showPreview"
          type="button"
          class="fv__toggle"
          :class="{ 'is-on': wrap }"
          :aria-pressed="wrap"
          @click="wrap = !wrap"
        >
          Wrap
        </button>
      </div>
    </header>

    <p v-if="file?.truncated" class="fv__warn">
      Showing the first 512 KB of this file.
    </p>

    <!-- tabindex 0: the body is the one scroll region, reachable by keyboard. -->
    <div class="fv__body" tabindex="0">
      <div v-if="loading" class="fv__skeleton" aria-hidden="true">
        <i v-for="n in 14" :key="n" :style="{ width: `${28 + ((n * 37) % 56)}%` }" />
      </div>
      <p v-else-if="note" class="fv__note">{{ note }}</p>
      <MarkdownMessage v-else-if="showPreview" class="fv__md" :source="file!.text!" historical />
      <div v-else class="code" :class="{ 'code--nowrap': !wrap }">
        <div v-for="(row, i) in rows" :key="i" class="code__line">
          <span class="code__no">{{ i + 1 }}</span>
          <span class="code__text">
            <template v-if="Array.isArray(row)">
              <span
                v-for="(t, j) in row"
                :key="j"
                :style="{ color: t.color }"
                >{{ t.content }}</span
              ><span v-if="row.length === 0"> </span>
            </template>
            <template v-else>{{ row || " " }}</template>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.fv {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

/* ── the path bar ─────────────────────────────────────────────────────────── */
.fv__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  padding: 10px 20px;
}
.fv__crumbs {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
}
.fv__dir,
.fv__sep {
  color: var(--muted);
}
.fv__sep {
  opacity: 0.5;
}
.fv__leaf {
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
}
.fv__meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}
.fv__toggle {
  padding: 3px 9px;
  border-radius: 999px;
  font-family: var(--font-sans);
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}
.fv__toggle:hover {
  color: var(--ink-soft);
}
.fv__toggle.is-on {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
}
.fv__toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 1px;
}

.fv__warn {
  flex-shrink: 0;
  margin: 0 20px 6px;
  font-size: 12px;
  color: var(--muted);
}

/* ── the body ─────────────────────────────────────────────────────────────── */
.fv__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 0 40px;
  scrollbar-width: thin;
  scrollbar-color: var(--hover) transparent;
}
.fv__body:focus {
  outline: none;
}
.fv__note {
  padding: 48px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}
.fv__md {
  max-width: 760px;
  padding: 8px 28px;
}

.fv__skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 20px 0 66px;
}
.fv__skeleton i {
  display: block;
  height: 9px;
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  animation: fv-breathe 1.7s ease-in-out infinite;
}
@keyframes fv-breathe {
  50% {
    opacity: 0.45;
  }
}

/* ── code (the file detail's treatment, so both viewers read alike) ──────── */
.code {
  font-family: var(--font-mono);
  font-size: calc(var(--font-size-code) + 0.5px);
  line-height: 1.75;
}
.code__line {
  display: flex;
  align-items: flex-start;
  /* Long files: skip layout and paint for lines far off screen. */
  content-visibility: auto;
  contain-intrinsic-size: auto 1.75em;
}
.code__no {
  position: sticky;
  left: 0;
  flex: none;
  width: 56px;
  padding-right: 18px;
  text-align: right;
  /* Pinned while the line scrolls sideways, so it needs a solid ground — the
     dimming lives in the colour, not in opacity, or code would show through. */
  color: color-mix(in srgb, var(--muted) 55%, var(--ground));
  background-color: var(--ground);
  font-variant-numeric: tabular-nums;
  -webkit-user-select: none;
  user-select: none;
}
.code__text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  padding-right: 24px;
  tab-size: 2;
}
.code--nowrap .code__line {
  width: max-content;
  min-width: 100%;
}
.code--nowrap .code__text {
  flex: none;
  white-space: pre;
  overflow-wrap: normal;
}

@media (prefers-reduced-motion: reduce) {
  .fv__skeleton i {
    animation: none;
  }
}
</style>
