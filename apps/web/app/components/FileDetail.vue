<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { usePreferredDark } from "@vueuse/core";
import { Magnet } from "~/components/ui/magnet";
import type { ChangeItem } from "~/components/ChangesPanel.vue";
import type { GitFileContent, GitFileDiff } from "~/types/desktop";
import type { CodeLine } from "~/composables/useHighlighter";
import type { DiffRow } from "~/composables/useDiff";

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
const { buildRows } = useDiff();
const dark = usePreferredDark();

const content = ref<GitFileContent | null>(null);
const tokenLines = ref<CodeLine[] | null>(null);
const renderedMd = ref<string | null>(null);
// The parsed diff is kept so a colour-scheme flip can re-tint its rows without a
// second read; diffRows are the built (highlighted) rows the view renders.
const diffData = ref<GitFileDiff | null>(null);
const diffRows = ref<DiffRow[] | null>(null);
const loading = ref(true);

// Markdown files get the rich/raw switch; everything else is always raw.
const isMarkdown = computed(() => {
  const ext = props.file.name.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
});

// View controls (right-rail footer). Diff view shows the change as a unified
// diff; off shows the file's own content. Rich preview (Markdown only) renders
// the file; off falls back to the raw source. Wrap on = long lines fold at the
// frame width; off = they run out to their own horizontal scroll. Line numbers
// on = the gutter shows (raw file view only — the diff carries its own).
const diffView = ref(true);
const richPreview = ref(true);
const wrap = ref(true);
const lineNumbers = ref(true);

// The diff is on screen only once its rows are built (and there's something to
// show); showDiff gates the body so there's no flash mid-load. When it can't be
// shown (no diff, or toggled off) the file content takes over.
const hasDiff = computed(() => !!diffRows.value && diffRows.value.length > 0);
const showDiff = computed(() => diffView.value && hasDiff.value);
// The rich preview only applies in the file view (not while the diff is up).
const wantsPreview = computed(
  () => !showDiff.value && isMarkdown.value && richPreview.value,
);
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
    diffData.value = null;
    diffRows.value = null;
    // Read the working-tree content and the change's diff together.
    const [result, diff] = await Promise.all([
      git.content(props.repoPath, props.file.path),
      git.diff(props.repoPath, props.file.path, props.file.staged),
    ]);
    if (mine !== token) return;
    content.value = result;
    diffData.value = diff;
    // Highlight the raw source, render the rich preview, and build the diff rows
    // together — they're independent, so preparing all three up front keeps
    // every toggle instant without serialising the passes. Everything's held
    // behind `loading` so the view arrives complete (no plain→coloured flash,
    // no file→diff flash).
    const [tokens, md, rows] = await Promise.all([
      result?.text ? highlight(result.text, props.file.path, dark.value) : null,
      result?.text && isMarkdown.value ? renderMd(result.text) : null,
      buildRows(diff, dark.value),
    ]);
    if (mine !== token) return;
    tokenLines.value = tokens;
    renderedMd.value = md;
    diffRows.value = rows;
    loading.value = false;
  },
  { immediate: true },
);

// Re-tint (not re-read) when the colour scheme flips — both the file tokens and
// the diff rows carry theme colours. Rebuilds from what's already loaded.
watch(dark, async () => {
  const mine = token;
  const [tinted, rows] = await Promise.all([
    content.value?.text ? highlight(content.value.text, props.file.path, dark.value) : null,
    buildRows(diffData.value, dark.value),
  ]);
  if (mine !== token) return;
  if (tinted) tokenLines.value = tinted;
  if (diffData.value) diffRows.value = rows;
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

// Take focus when the overlay opens so the triggering card isn't left focused
// underneath — otherwise an Esc-to-close (a keystroke) would trip the card into
// showing its keyboard focus ring the moment this closes. On close focus falls
// to the body (the card unmounts from under it), so nothing rings unbidden.
const backEl = ref<HTMLButtonElement | null>(null);
const frameEl = ref<HTMLElement | null>(null);
const mainEl = ref<HTMLElement | null>(null);
onMounted(() => backEl.value?.focus());

// While the preview is up the arrow / page / home / end keys drive the file body
// exclusively — you never have to tab into it (it's out of the tab order), and
// the keys scroll it wherever focus happens to sit (back, an action, a switch).
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]);
function onScrollKeys(e: KeyboardEvent) {
  const el = mainEl.value;
  if (!el || !SCROLL_KEYS.has(e.key)) return;
  e.preventDefault();
  // Hand focus to the body so the keystroke belongs to it — otherwise the arrow
  // would trip the focus ring on whatever control is focused (e.g. the back
  // button on open). The body has no ring, so nothing lights up while scrolling.
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  const page = el.clientHeight * 0.9;
  const step: Record<string, [number, ScrollBehavior]> = {
    ArrowDown: [48, "auto"],
    ArrowUp: [-48, "auto"],
    PageDown: [page, "smooth"],
    PageUp: [-page, "smooth"],
  };
  if (e.key === "Home") el.scrollTo({ top: 0, behavior: "smooth" });
  else if (e.key === "End") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  else el.scrollBy({ top: step[e.key]![0], behavior: step[e.key]![1] });
}

function onKeydown(e: KeyboardEvent) {
  onScrollKeys(e);
  if (!e.defaultPrevented) onTrapKeydown(e);
}

// Keep Tab inside the overlay — it's modal, so focus shouldn't leak to the
// (inert) page behind. Cycles at both ends; nothing else about Tab changes.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function onTrapKeydown(e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const root = frameEl.value;
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div class="fd" :style="originStyle" role="dialog" aria-modal="true" @keydown="onKeydown">
    <div ref="frameEl" class="fd__frame">
      <!-- Top: back + breadcrumb. Actions live down the left rail. -->
      <header class="fd__bar">
        <button ref="backEl" type="button" class="fd__back" aria-label="Back to changes" @click="emit('close')">
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
        <!-- Left action rail — file-scoped actions (room to grow). Each leans
             gently toward the cursor as it nears, then eases back. -->
        <div class="fd__left">
          <Magnet
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
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
          </Magnet>
          <!-- Discard only ever touches an unstaged file. -->
          <Magnet
            v-if="!file.staged"
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <HoldToConfirm
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
          </Magnet>
        </div>

        <!-- Body: the file's own content, softened at the top/bottom edges. Only
             this scrolls — the page behind is locked. Kept out of the tab order
             (tabindex -1); the arrow/page/home/end keys scroll it instead. -->
        <div ref="mainEl" class="fd__main" tabindex="-1">
          <div v-if="loading" class="fd__skeleton">
            <span v-for="n in 12" :key="n" class="fd__skeleton-row" :style="{ '--i': n, width: `${34 + ((n * 41) % 58)}%` }" />
          </div>
          <!-- Unified diff: one column, syntax-highlighted, with word-level
               emphasis on the changed spans. Its own old/new number gutter. -->
          <!-- tabindex -1: nowrap scrolls sideways (a focusable scroller). -->
          <div v-else-if="showDiff" class="diff" :class="{ 'diff--nowrap': !wrap }" tabindex="-1">
            <template v-for="(row, i) in diffRows" :key="i">
              <div v-if="row.kind === 'gap'" class="diff__gap" aria-hidden="true">
                <span /><span /><span />
              </div>
              <div v-else class="dl" :class="`dl--${row.kind}`">
                <span class="dl__no">{{ row.oldNo ?? "" }}</span>
                <span class="dl__no">{{ row.newNo ?? "" }}</span>
                <span class="dl__sign" aria-hidden="true">{{ row.kind === "add" ? "+" : row.kind === "del" ? "−" : "" }}</span>
                <span class="dl__text"><span
                    v-for="(c, j) in row.chunks"
                    :key="j"
                    :class="{ dl__emph: c.emph }"
                    :style="{ color: c.color }"
                  >{{ c.text }}</span></span>
              </div>
            </template>
          </div>
          <div v-else-if="note" class="fd__note">{{ note }}</div>
          <!-- Rich Markdown preview (safe HTML from markdown-it). -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article v-else-if="showPreview" class="md" v-html="renderedMd" />
          <!-- tabindex -1: with wrap off this scrolls sideways, which would make
               it a focusable scroller (an extra tab stop). Arrow keys scroll it. -->
          <div v-else class="code" :class="{ 'code--nowrap': !wrap }" tabindex="-1">
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
            <div v-if="hasDiff" class="ctl" :class="{ 'ctl--on': diffView }">
              <span class="ctl__k">Diff view</span>
              <button
                type="button"
                class="ctl__sw"
                :class="{ 'ctl__sw--on': diffView }"
                role="switch"
                :aria-checked="diffView"
                aria-label="Show unified diff"
                @click="diffView = !diffView"
              >
                <span class="ctl__dot" />
              </button>
            </div>
            <div v-if="!showDiff && isMarkdown" class="ctl" :class="{ 'ctl--on': richPreview }">
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
            <!-- Line numbers shape only the raw file view; the diff has its own. -->
            <div v-if="!showDiff && !wantsPreview" class="ctl" :class="{ 'ctl--on': lineNumbers }">
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
/* Keyboard focus rings — soft ink, only when focus is keyboard-driven. */
.fd__back:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: #1e1b1814 0 2px 8px, 0 0 0 2px color-mix(in srgb, var(--ink) 34%, transparent);
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
.act:hover { color: var(--ink); }
.act:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
.act__ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
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
/* Out of the tab order (tabindex -1); the arrow/page keys focus it to scroll.
   It's a scroll region, not an action — never a ring or the default outline. */
.fd__main:focus { outline: none; }

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

/* ── unified diff ─────────────────────────────────────────────────────────── */
.diff {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.75;
}
.dl {
  display: flex;
  align-items: flex-start;
  /* A calm tint over the row, and a coloured rule down the inside edge — no
     saturated fills (kone keeps changes reading like a page). The rule doubles
     as the left border so context lines stay flush. */
  border-inline-start: 2px solid transparent;
}
.dl--add { background-color: color-mix(in srgb, var(--diff-add) 8%, transparent); border-inline-start-color: color-mix(in srgb, var(--diff-add) 55%, transparent); }
.dl--del { background-color: color-mix(in srgb, var(--diff-del) 8%, transparent); border-inline-start-color: color-mix(in srgb, var(--diff-del) 55%, transparent); }
.dl__no {
  flex: none;
  width: 40px;
  padding-inline-end: 12px;
  text-align: right;
  color: var(--muted);
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
  -webkit-user-select: none;
  user-select: none;
}
.dl__no:first-child { padding-inline-start: 6px; }
.dl__sign {
  flex: none;
  width: 16px;
  text-align: center;
  -webkit-user-select: none;
  user-select: none;
}
.dl--add .dl__sign { color: var(--diff-add); }
.dl--del .dl__sign { color: var(--diff-del); }
.dl__text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  padding-inline-end: 18px;
  tab-size: 2;
}
/* Word-level emphasis: the exact span that changed gets a stronger tint, so the
   eye lands on the edit rather than the whole line. */
.dl__emph { border-radius: 3px; padding: 1px 0; }
.dl--add .dl__emph { background-color: color-mix(in srgb, var(--diff-add) 22%, transparent); }
.dl--del .dl__emph { background-color: color-mix(in srgb, var(--diff-del) 22%, transparent); }

/* A quiet break between non-adjacent hunks — three faint dots, no @@ header. */
.diff__gap {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 12px 0;
}
.diff__gap span {
  width: 3px;
  height: 3px;
  border-radius: 999px;
  background-color: var(--muted);
  opacity: 0.4;
}

/* Wrap off: rows run to their natural width and the block scrolls sideways. */
.diff--nowrap { overflow-x: auto; }
.diff--nowrap::-webkit-scrollbar { height: 8px; }
.diff--nowrap::-webkit-scrollbar-thumb { background-color: var(--hover); border-radius: 4px; }
.diff--nowrap .dl { width: max-content; min-width: 100%; }
.diff--nowrap .dl__text { flex: none; white-space: pre; overflow-wrap: normal; }

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
  border-radius: 3px;
}
.md :deep(a):focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 34%, transparent);
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
.ctl__sw:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px #1e1b1810, 0 0 0 2px color-mix(in srgb, var(--ink) 34%, transparent);
}
.ctl__sw--on:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 34%, transparent);
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
  .fd__back:focus-visible {
    box-shadow: #00000038 0 2px 8px, 0 0 0 2px color-mix(in srgb, var(--ink) 40%, transparent);
  }
  /* Off-track ring for definition; the thumb stays --ground so it reads on the
     light --ink on-track. */
  .ctl__sw { box-shadow: inset 0 0 0 1px #ffffff12; }
  .ctl__sw--on { box-shadow: none; }
  .ctl__sw:focus-visible {
    box-shadow: inset 0 0 0 1px #ffffff12, 0 0 0 2px color-mix(in srgb, var(--ink) 40%, transparent);
  }
  .ctl__dot { box-shadow: #00000045 0 1px 2px; }
}
@media (prefers-reduced-motion: reduce) {
  .fd__skeleton-row { animation: none; }
}
</style>
