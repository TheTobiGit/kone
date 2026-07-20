<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { usePreferredDark } from "@vueuse/core";
import type { ChangeItem } from "~/components/ChangesPanel.vue";
import type { GitFileContent } from "~/types/desktop";
import type { CodeLine } from "~/composables/useHighlighter";

// The overlay a change opens into — the file appears to enlarge out of its card
// (the grow is driven by ProjectView's transition, anchored on --ox/--oy) and
// fills the screen over the page. It shows the file's own content, plain, on the
// page ground (no card): a left action rail, the scrolling body with softened
// edges, and a mono metadata rail down the right. The page itself doesn't
// scroll while this is open — only the body does.

const props = defineProps<{
  file: ChangeItem;
  /** Open project path, to read this file's content. */
  repoPath: string;
  /** The clicked card's viewport rect — the grow's origin. */
  origin: DOMRect | null;
}>();

const emit = defineEmits<{
  close: [];
  stage: [path: string];
  unstage: [path: string];
  discard: [path: string];
}>();

const git = useGit();
const { highlight } = useHighlighter();
const { render: renderMd } = useMarkdown();
const dark = usePreferredDark();

const content = ref<GitFileContent | null>(null);
const tokenLines = ref<CodeLine[] | null>(null);
const renderedMd = ref<string | null>(null);
const loading = ref(true);

// Markdown files get the rich/raw switch; everything else is always raw.
const isMarkdown = computed(() => {
  const ext = props.file.name.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
});

// View controls (right-rail footer). Rich preview (Markdown only) renders the
// file; off falls back to the raw source. Wrap on = long lines fold at the frame
// width; off = they run out to their own horizontal scroll. Line numbers on =
// the gutter shows. Wrap/numbers only apply to the raw view.
const richPreview = ref(true);
const wrap = ref(true);
const lineNumbers = ref(true);
// The user wants the preview (intent) — drives which controls apply. The
// preview is actually on screen (vs. the raw code view) only once its HTML has
// rendered; showPreview gates the body swap so there's no flash mid-load.
const wantsPreview = computed(() => isMarkdown.value && richPreview.value);
const showPreview = computed(
  () => wantsPreview.value && renderedMd.value !== null,
);

// Re-read whenever the file changes, then highlight before revealing (skeleton →
// coloured code, no plain flash). A token guards a slow earlier read/highlight
// landing after a newer one.
let token = 0;
watch(
  () => props.file.path,
  async () => {
    const mine = ++token;
    loading.value = true;
    content.value = null;
    tokenLines.value = null;
    renderedMd.value = null;
    const result = await git.content(props.repoPath, props.file.path);
    if (mine !== token) return;
    content.value = result;
    if (result?.text) {
      // Highlight the raw source and render the rich preview together — they're
      // independent, so preparing both up front keeps the switch instant either
      // way without serialising the two passes.
      const [tokens, md] = await Promise.all([
        highlight(result.text, props.file.path, dark.value),
        isMarkdown.value ? renderMd(result.text) : Promise.resolve(null),
      ]);
      if (mine !== token) return;
      tokenLines.value = tokens;
      renderedMd.value = md;
    }
    loading.value = false;
  },
  { immediate: true },
);

// Re-tint (not re-read) when the colour scheme flips.
watch(dark, async () => {
  const text = content.value?.text;
  if (!text) return;
  const mine = token;
  const tinted = await highlight(text, props.file.path, dark.value);
  if (mine === token) tokenLines.value = tinted;
});

// Grow from the clicked card's centre — ProjectView's <Transition> reads these.
const originStyle = computed(() => {
  const r = props.origin;
  if (!r || typeof window === "undefined") return {};
  const ox = ((r.left + r.width / 2) / window.innerWidth) * 100;
  const oy = ((r.top + r.height / 2) / window.innerHeight) * 100;
  return { "--ox": `${ox}%`, "--oy": `${oy}%` };
});

const dirPart = computed(() => {
  const i = props.file.path.lastIndexOf("/");
  return i < 0 ? "" : props.file.path.slice(0, i + 1);
});

const statusLabel = computed(() =>
  props.file.deleted ? "Deleted" : props.file.isNew ? "New file" : "Modified",
);

const LANGS: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  vue: "Vue", css: "CSS", scss: "Sass", sass: "Sass", less: "Less",
  html: "HTML", json: "JSON", jsonc: "JSON", md: "Markdown", mdx: "MDX",
  py: "Python", go: "Go", rs: "Rust", rb: "Ruby", java: "Java", kt: "Kotlin",
  swift: "Swift", c: "C", h: "C", cpp: "C++", cc: "C++", cs: "C#",
  php: "PHP", sh: "Shell", bash: "Shell", zsh: "Shell", sql: "SQL",
  yml: "YAML", yaml: "YAML", toml: "TOML", xml: "XML", svg: "SVG",
  lock: "Lockfile", txt: "Text",
};
const language = computed(() => {
  const ext = props.file.name.split(".").pop()?.toLowerCase() ?? "";
  return LANGS[ext] ?? (ext ? ext.toUpperCase() : "Plain");
});

// The CHANGES readout as a proportional row of solid boxes — the same colour
// blocks the change cards sketch their diff with.
const boxes = computed<("add" | "del")[]>(() => {
  const a = props.file.added;
  const r = props.file.removed;
  const total = a + r;
  if (total === 0) return [];
  const n = Math.min(total, 14);
  let greens = Math.round((n * a) / total);
  if (a > 0) greens = Math.max(1, greens);
  if (r > 0) greens = Math.min(n - 1, greens);
  return [
    ...(Array(greens).fill("add") as "add"[]),
    ...(Array(n - greens).fill("del") as "del"[]),
  ];
});

// The rows to render: coloured token lines when highlighting succeeded,
// otherwise the raw text split into plain lines.
const lines = computed(() => (content.value?.text ?? "").split("\n"));
const rows = computed<CodeLine[] | string[]>(() => tokenLines.value ?? lines.value);
const note = computed(() => {
  if (loading.value) return null;
  if (props.file.deleted) return "This file was deleted.";
  const c = content.value;
  if (!c || c.text === null) return c?.binary ? "Binary file — no preview." : "Can’t preview this file.";
  if (c.text.trim() === "") return "Empty file.";
  return null;
});

function toggleStage() {
  if (props.file.staged) emit("unstage", props.file.path);
  else emit("stage", props.file.path);
}
</script>

<template>
  <div class="fd" :style="originStyle">
    <div class="fd__frame">
      <!-- Top: back + breadcrumb. Actions live down the left rail. -->
      <header class="fd__bar">
        <button type="button" class="fd__back" aria-label="Back to changes" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <span class="fd__crumb">
          <FileIcon :path="file.name" :size="15" />
          <span class="fd__crumb-dir">{{ dirPart }}</span>
          <span class="fd__crumb-name" :class="{ 'fd__crumb-name--del': file.deleted }">{{ file.name }}</span>
        </span>
      </header>

      <div class="fd__body">
        <!-- Left action rail — file-scoped actions (room to grow). -->
        <div class="fd__left">
          <button type="button" class="act" @click="toggleStage">
            <span class="act__ic">
              <svg v-if="file.staged" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            {{ file.staged ? "Unstage" : "Stage" }}
          </button>
          <!-- Discard only ever touches an unstaged file. -->
          <HoldToConfirm
            v-if="!file.staged"
            variant="lane-discard"
            title="Hold to discard this file's changes"
            aria-label="Hold to discard this file"
            @confirm="emit('discard', file.path)"
          >
            <span class="act__ic">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M3 7v6h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            Discard
          </HoldToConfirm>
        </div>

        <!-- Body: the file's own content, softened at the top/bottom edges. Only
             this scrolls — the page behind is locked. -->
        <div class="fd__main">
          <div v-if="loading" class="fd__skeleton">
            <span v-for="n in 12" :key="n" class="fd__skeleton-row" :style="{ '--i': n, width: `${34 + ((n * 41) % 58)}%` }" />
          </div>
          <div v-else-if="note" class="fd__note">{{ note }}</div>
          <!-- Rich Markdown preview (safe HTML from markdown-it). -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article v-else-if="showPreview" class="md" v-html="renderedMd" />
          <div v-else class="code" :class="{ 'code--nowrap': !wrap }">
            <div v-for="(row, i) in rows" :key="i" class="code__line">
              <span v-if="lineNumbers" class="code__no">{{ i + 1 }}</span>
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

        <!-- Right: the technical caption, read top-down. -->
        <aside class="fd__meta">
          <div class="meta">
            <span class="meta__k">Filename</span>
            <span class="meta__v meta__v--file">{{ file.name }}</span>
          </div>
          <div class="meta">
            <span class="meta__k">Status</span>
            <span class="meta__v">{{ statusLabel }}</span>
          </div>
          <div class="meta">
            <span class="meta__k">Changes</span>
            <span class="meta__v meta__v--diff">
              <span v-if="file.added > 0" class="meta__add">+{{ file.added }}</span>
              <span v-if="file.removed > 0" class="meta__del">−{{ file.removed }}</span>
              <span v-if="file.added === 0 && file.removed === 0" class="meta__none">—</span>
            </span>
            <span v-if="boxes.length" class="meta__boxes">
              <i v-for="(b, i) in boxes" :key="i" class="meta__box" :class="`meta__box--${b}`" />
            </span>
          </div>
          <div class="meta">
            <span class="meta__k">Language</span>
            <span class="meta__v">{{ language }}</span>
          </div>
          <div class="meta">
            <span class="meta__k">Staged</span>
            <span class="meta__v">{{ file.staged ? "Yes" : "No" }}</span>
          </div>

          <!-- View controls, seated near the foot of the rail. Only the switch
               toggles — the label is just a caption. -->
          <div class="fd__controls">
            <span class="meta__k">Controls</span>
            <div v-if="isMarkdown" class="ctl" :class="{ 'ctl--on': richPreview }">
              <span class="ctl__k">Rich preview</span>
              <button
                type="button"
                class="ctl__sw"
                :class="{ 'ctl__sw--on': richPreview }"
                role="switch"
                :aria-checked="richPreview"
                aria-label="Rich Markdown preview"
                @click="richPreview = !richPreview"
              >
                <span class="ctl__dot" />
              </button>
            </div>
            <!-- Wrap & line numbers only shape the raw view. -->
            <div v-if="!wantsPreview" class="ctl" :class="{ 'ctl--on': wrap }">
              <span class="ctl__k">Line wrap</span>
              <button
                type="button"
                class="ctl__sw"
                :class="{ 'ctl__sw--on': wrap }"
                role="switch"
                :aria-checked="wrap"
                aria-label="Wrap lines"
                @click="wrap = !wrap"
              >
                <span class="ctl__dot" />
              </button>
            </div>
            <div v-if="!wantsPreview" class="ctl" :class="{ 'ctl--on': lineNumbers }">
              <span class="ctl__k">Line numbers</span>
              <button
                type="button"
                class="ctl__sw"
                :class="{ 'ctl__sw--on': lineNumbers }"
                role="switch"
                :aria-checked="lineNumbers"
                aria-label="Show line numbers"
                @click="lineNumbers = !lineNumbers"
              >
                <span class="ctl__dot" />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fd {
  position: fixed;
  inset: 0;
  z-index: 50;
  background-color: var(--ground);
  display: flex;
  justify-content: center;
}
.fd__frame {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1080px;
  height: 100%;
  padding: 34px 40px 0;
  min-height: 0;
}

/* ── top bar ──────────────────────────────────────────────────────────────── */
.fd__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  padding-bottom: 22px;
}
.fd__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  color: var(--ink-soft);
  background-color: var(--ground);
  box-shadow: #1e1b1814 0 2px 8px;
  cursor: pointer;
  transition: transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1), color 0.16s ease;
}
.fd__back:hover {
  color: var(--ink);
  transform: translateX(-2px);
}
.fd__crumb {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.fd__crumb-dir {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.fd__crumb-name { color: var(--ink); white-space: nowrap; }
.fd__crumb-name--del { text-decoration: line-through; color: var(--muted); }

/* ── body: left rail · content · meta ─────────────────────────────────────── */
.fd__body {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) 150px;
  gap: 30px;
  flex: 1;
  min-height: 0;
}

.fd__left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: start;
  padding: 6px 10px 6px 6px;
  border-radius: 9px;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}
.act:hover { background-color: var(--hover); color: var(--ink); }
.act__ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background-color: var(--hover);
}
/* The Discard hold styled like the other rail actions, red only on the hold. */
.fd__left :deep(.hold--lane-discard) {
  align-self: start;
  gap: 8px;
  padding: 6px 10px 6px 6px;
  border-radius: 9px;
  font-family: var(--font-sans);
  font-size: 12px;
}

/* ── content ──────────────────────────────────────────────────────────────── */
.fd__main {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px 0 40px;
  /* Soft "smoke" at the scroll edges so lines fade in/out rather than clip. */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 34px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 34px), transparent 100%);
  scrollbar-width: none;
}
.fd__main::-webkit-scrollbar { width: 0; height: 0; }

.code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.75;
}
/* The frame width is fixed, so a long line wraps instead of scrolling sideways —
   its number stays pinned to the first visual row while the text flows below. */
.code__line {
  display: flex;
  align-items: flex-start;
}
.code__no {
  flex: none;
  width: 46px;
  padding-right: 20px;
  text-align: right;
  color: var(--muted);
  opacity: 0.55;
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
/* Wrap off: lines run to their natural width and the block scrolls sideways. */
.code--nowrap {
  overflow-x: auto;
}
.code--nowrap::-webkit-scrollbar { height: 8px; }
.code--nowrap::-webkit-scrollbar-thumb { background-color: var(--hover); border-radius: 4px; }
.code--nowrap .code__line {
  width: max-content;
  min-width: 100%;
}
.code--nowrap .code__text {
  flex: none;
  white-space: pre;
  overflow-wrap: normal;
}

.fd__note {
  padding: 48px 4px;
  color: var(--muted);
  font-size: 13px;
}

/* ── rich Markdown preview ────────────────────────────────────────────────── */
/* v-html output isn't scoped, so the prose is styled through :deep(). Calm
   editorial defaults: a capped measure, a descending heading scale, roomy body
   line-height. */
.md {
  max-width: 68ch;
  padding: 4px 0 8px;
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.md :deep(> :first-child) { margin-top: 0; }
.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(blockquote),
.md :deep(pre),
.md :deep(table) {
  margin: 0 0 1.05em;
}
.md :deep(p) { text-wrap: pretty; }

/* Headings — descending scale, tight leading, balanced wrap, ink. */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 1.9em 0 0.6em;
  line-height: 1.2;
  font-weight: 600;
  color: var(--ink);
  text-wrap: balance;
}
.md :deep(h1) { font-size: 27px; letter-spacing: -0.02em; }
.md :deep(h2) { font-size: 21px; letter-spacing: -0.015em; }
.md :deep(h3) { font-size: 17px; letter-spacing: -0.01em; }
.md :deep(h4) { font-size: 15px; }
.md :deep(h5) { font-size: 13px; }
.md :deep(h6) {
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.md :deep(strong) { font-weight: 650; color: var(--ink); }
.md :deep(em) { font-style: italic; }

/* Links — accent, underline pulled from the font's own metrics. */
.md :deep(a) {
  color: var(--accent, #4f46e5);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: from-font;
  text-decoration-skip-ink: auto;
}

.md :deep(ul),
.md :deep(ol) { padding-inline-start: 1.4em; }
.md :deep(li) { margin: 0.28em 0; }
.md :deep(li)::marker { color: var(--muted); }

.md :deep(blockquote) {
  padding-inline-start: 1em;
  border-inline-start: 2px solid var(--hover);
  color: var(--muted);
}

/* Inline code + fenced blocks — mono on a recessed fill (no border). */
.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  padding: 0.12em 0.36em;
  border-radius: 5px;
  background-color: var(--hover);
}
.md :deep(pre) {
  padding: 14px 16px;
  border-radius: 10px;
  background-color: var(--hover);
  overflow-x: auto;
  line-height: 1.6;
}
.md :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 12.5px;
}

.md :deep(hr) {
  margin: 1.8em 0;
  border: 0;
  border-top: 1px solid var(--hover);
}

.md :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}

.md :deep(table) {
  border-collapse: collapse;
  font-size: 14px;
}
.md :deep(th),
.md :deep(td) {
  padding: 7px 14px 7px 0;
  text-align: start;
  border-bottom: 1px solid var(--hover);
}
.md :deep(th) { font-weight: 600; color: var(--ink); }

@keyframes fd-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.8; } }
.fd__skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}
.fd__skeleton-row {
  height: 9px;
  border-radius: 3px;
  background-color: var(--hover);
  animation: fd-pulse 1.5s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 80ms);
}

/* ── meta caption ─────────────────────────────────────────────────────────── */
.fd__meta {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-top: 4px;
}
.meta { display: flex; flex-direction: column; gap: 6px; }
.meta__k {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  color: var(--muted);
}
.meta__v {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink-soft);
  word-break: break-word;
}
.meta__v--file { color: var(--ink); }
.meta__v--diff { display: inline-flex; gap: 8px; font-variant-numeric: tabular-nums; }
.meta__add { color: var(--diff-add); }
.meta__del { color: var(--diff-del); }
.meta__none { color: var(--muted); }
.meta__boxes {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 4px;
  max-width: 132px;
}
.meta__box { width: 8px; height: 8px; border-radius: 2px; }
.meta__box--add { background-color: var(--diff-add); }
.meta__box--del { background-color: var(--diff-del); }

/* ── view controls (rail footer) ──────────────────────────────────────────── */
.fd__controls {
  margin-top: auto;
  /* Lift off the very bottom so it doesn't hug the frame edge. */
  padding: 22px 0 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ctl {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.ctl__k {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  color: var(--muted);
  transition: color 0.18s ease;
}
.ctl--on .ctl__k { color: var(--ink-soft); }
/* Pill switch — track fills on, thumb springs across with a hairline ring. The
   thumb is --ground (always the opposite of --ink), so it stays legible against
   the --ink on-track in both light and dark. */
.ctl__sw {
  flex: none;
  width: 34px;
  height: 19px;
  border-radius: 999px;
  background-color: var(--hover);
  box-shadow: inset 0 0 0 1px #1e1b1810;
  padding: 2.5px;
  cursor: pointer;
  transition: background-color 0.24s ease;
}
.ctl__sw--on {
  background-color: var(--ink);
  box-shadow: none;
}
.ctl__dot {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background-color: var(--ground);
  box-shadow: #1e1b1833 0 1px 2px;
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ctl__sw--on .ctl__dot { transform: translateX(15px); }

@media (prefers-color-scheme: dark) {
  .fd__back { background-color: #17171a; box-shadow: #00000038 0 2px 8px; }
  /* Off-track ring for definition; the thumb stays --ground so it reads on the
     light --ink on-track. */
  .ctl__sw { box-shadow: inset 0 0 0 1px #ffffff12; }
  .ctl__sw--on { box-shadow: none; }
  .ctl__dot { box-shadow: #00000045 0 1px 2px; }
}
@media (prefers-reduced-motion: reduce) {
  .fd__skeleton-row { animation: none; }
}
</style>
