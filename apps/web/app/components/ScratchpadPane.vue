<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDebounceFn, useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Copy01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import type { ScratchpadSession } from "~/composables/useScratchpad";
import { usePadEditor, type PadMarkKind } from "~/composables/usePadEditor";
import { normalizeTaskLists, padHtmlToMarkdown, padHtmlToText } from "~/utils/padMarkdown";
import HoldToConfirm from "~/components/HoldToConfirm.vue";
import PadFormatBar from "~/components/PadFormatBar.vue";

const props = defineProps<{
  session: ScratchpadSession;
}>();

const emit = defineEmits<{
  flush: [];
}>();

const { cue } = useSound();
const { render } = useMarkdown();
const reducedMotion = usePreferredReducedMotion();

const host = ref<HTMLElement | null>(null);
const flashing = ref(false);
const savedWhisper = ref(false);
let savedTimer = 0;
let flashTimer = 0;

const editor = usePadEditor({
  host,
  doc: props.session.doc,
  marker: () => props.session.marker.value,
  onMarkerUse: (patch) => props.session.setMarker(patch),
});

const plainText = computed(() => padHtmlToText(props.session.doc.value));
const isEmpty = computed(() => !plainText.value.trim());

const wordCount = computed(() => {
  const t = plainText.value.trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
});

const savedLabel = computed(() => {
  if (props.session.status === "saving") return "Saving…";
  if (!props.session.savedAt) return "";
  return new Date(props.session.savedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
});

onMounted(() => {
  // Enter should make paragraphs, not the legacy <div> soup.
  try {
    document.execCommand("defaultParagraphSeparator", false, "p");
  } catch {
    // not fatal — Chromium already defaults to <div>, which we serialize anyway
  }
  editor.syncFromDoc();
});

onBeforeUnmount(() => {
  window.clearTimeout(savedTimer);
  window.clearTimeout(flashTimer);
});

// An outside write — a snippet captured from a thread, Clear, a reopened pad —
// replaces the document; our own keystrokes never come back through here.
watch(() => props.session.doc.value, () => editor.syncFromDoc());

function showSavedWhisper(): void {
  savedWhisper.value = true;
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => {
    savedWhisper.value = false;
  }, 2200);
}

watch(
  () => props.session.status,
  (status, prev) => {
    if (prev === "saving" && status === "ready") showSavedWhisper();
  },
);

watch(
  () => props.session.flashAt.value,
  (at) => {
    if (!at) return;
    flashing.value = true;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashing.value = false;
    }, reducedMotion.value === "reduce" ? 0 : 700);
    void nextTick(() => {
      const el = host.value?.parentElement;
      el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  },
);

// ── the floating format bar ──────────────────────────────────────────────────
const barVisible = ref(false);
const barCoords = ref({ top: 0, left: 0 });
const barPlacement = ref<"above" | "below">("above");
const marks = ref<Record<PadMarkKind, boolean>>({
  bold: false,
  italic: false,
  strike: false,
  code: false,
  highlight: false,
});

const BAR_WIDTH = 232;

function positionBar(range: Range): void {
  // A selection over several lines has a rect per line. The bar goes above the
  // first of them or below the last — measuring one line and placing against the
  // other is what made it sit on top of the words it was meant to act on.
  const rects = Array.from(range.getClientRects()).filter((r) => r.width || r.height);
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  const margin = 10;
  const anchor = first.left + first.width / 2 - BAR_WIDTH / 2;
  const left = Math.min(window.innerWidth - BAR_WIDTH - margin, Math.max(margin, anchor));
  if (first.top - margin > 96) {
    barPlacement.value = "above";
    barCoords.value = { top: first.top - margin, left };
  } else {
    barPlacement.value = "below";
    barCoords.value = { top: last.bottom + margin, left };
  }
}

const evaluateSelection = useDebounceFn(() => {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ?? null;
  if (!sel || sel.isCollapsed || !anchor || !host.value?.contains(anchor)) {
    barVisible.value = false;
    return;
  }
  if (!sel.toString().trim()) {
    barVisible.value = false;
    return;
  }
  positionBar(sel.getRangeAt(0));
  marks.value = editor.activeMarks();
  barVisible.value = true;
}, 90);

useEventListener(document, "selectionchange", evaluateSelection);
useEventListener(document, "mouseup", evaluateSelection);
useEventListener(document, "keyup", (e: KeyboardEvent) => {
  if (e.shiftKey || e.key.startsWith("Arrow")) evaluateSelection();
});
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && barVisible.value) barVisible.value = false;
});

/** Re-read the marks after the bar acts, so its lit state stays honest. */
function refreshMarks(): void {
  marks.value = editor.activeMarks();
}

function onBarMark(kind: PadMarkKind): void {
  editor.applyMark(kind);
  cue("press");
  refreshMarks();
}

function onBarHighlight(id: string): void {
  editor.applyHighlight(id);
  cue("press");
  refreshMarks();
}

function onBarTextColor(id: string): void {
  editor.applyTextColor(id);
  cue("press");
}

function onBarClear(): void {
  editor.clearFormat();
  cue("toggle");
  refreshMarks();
}

// ── footer actions ───────────────────────────────────────────────────────────
async function copyAll(): Promise<void> {
  const md = padHtmlToMarkdown(props.session.doc.value);
  if (!md.trim() || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(md);
    cue("toggle");
  } catch {
    // clipboard blocked
  }
}

function exportFile(): void {
  const md = padHtmlToMarkdown(props.session.doc.value);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scratchpad.md";
  a.click();
  URL.revokeObjectURL(url);
  cue("press");
}

function clearDoc(): void {
  props.session.doc.value = "";
  cue("press");
}

async function renderMarkdown(src: string): Promise<string> {
  const html = await render(src);
  return normalizeTaskLists(html ?? src);
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    emit("flush");
    return;
  }
  editor.onKeydown(e);
}
</script>

<template>
  <div class="pad">
    <div class="pad__body" :class="{ 'pad__body--flash': flashing }">
      <p v-if="isEmpty" class="pad__empty" aria-hidden="true">
        Notes, snippets, drafts. Type <span class="pad__hint">##</span> or
        <span class="pad__hint">-</span> and it formats itself.
      </p>
      <div
        ref="host"
        class="pad__doc pad-doc selectable"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        aria-label="Scratchpad"
        spellcheck="true"
        @beforeinput="editor.onBeforeInput"
        @input="editor.onInput"
        @keydown="onKeydown"
        @click="editor.onClick"
        @paste="(e) => editor.onPaste(e, renderMarkdown)"
      />
    </div>

    <footer class="pad__foot">
      <span class="pad__meta">{{ wordCount }} words</span>
      <span
        class="pad__meta pad__saved"
        :class="{ 'is-visible': savedWhisper || session.status === 'saving' }"
      >
        {{ session.status === "saving" ? "Saving…" : savedWhisper ? "Saved" : savedLabel }}
      </span>
      <div class="pad__tools">
        <button type="button" class="pad__tool" title="Copy as Markdown" @click="copyAll">
          <HugeiconsIcon :icon="Copy01Icon" :size="13" :stroke-width="2" />
        </button>
        <button type="button" class="pad__tool" title="Export .md" @click="exportFile">
          <HugeiconsIcon :icon="Download04Icon" :size="13" :stroke-width="2" />
        </button>
        <HoldToConfirm
          variant="lane-discard"
          title="Hold to clear"
          aria-label="Hold to clear scratchpad"
          @confirm="clearDoc"
        >
          Clear
        </HoldToConfirm>
      </div>
    </footer>

    <PadFormatBar
      :visible="barVisible"
      :top="barCoords.top"
      :left="barCoords.left"
      :placement="barPlacement"
      :marks="marks"
      :marker="session.marker.value"
      @mark="onBarMark"
      @highlight="onBarHighlight"
      @text-color="onBarTextColor"
      @clear="onBarClear"
    />
  </div>
</template>

<style scoped>
.pad {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}

.pad__body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-radius: 4px;
  transition: background-color 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
.pad__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pad__body--flash {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.pad__empty {
  position: absolute;
  top: 0;
  left: 0;
  margin: 0;
  font-size: 16px;
  line-height: 1.68;
  color: var(--muted);
  pointer-events: none;
}
.pad__hint {
  font-family: var(--font-mono);
  font-size: 0.86em;
  color: var(--ink-soft, var(--ink));
  opacity: 0.7;
}

.pad__doc {
  flex: 1;
  min-height: 12rem;
  outline: none;
  font-size: 16px;
  line-height: 1.68;
  color: var(--ink);
  caret-color: var(--accent);
  overflow-wrap: anywhere;
}

.pad__foot {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.65rem 0.1rem 0.15rem;
  opacity: 0.45;
  transition: opacity 0.2s ease;
}
:global(.col:hover) .pad__foot,
.pad__foot:focus-within {
  opacity: 1;
}

.pad__meta {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.pad__saved {
  opacity: 0;
  transition: opacity 0.35s ease;
}
.pad__saved.is-visible {
  opacity: 1;
}

.pad__tools {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  margin-left: auto;
}

.pad__tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.28rem 0.35rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.pad__tool:hover {
  background: var(--hover);
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .pad__body,
  .pad__saved {
    transition: none;
  }
  .pad__body--flash {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
}
</style>

<!-- The document's own typography. Unscoped because the editor writes this markup
     itself (contenteditable, browser commands) and Vue's scope attribute never
     reaches it — `.pad-doc` is the scope instead. -->
<style>
/* ── The pad palette ──────────────────────────────────────────────────────── */
/* The one place the pens' colours are written down. Documents store the *name*
   of a colour, so these can differ per scheme without touching what's saved:
   a wash that reads on paper needs more alpha and a brighter hue to read on the
   dark ground. `--…-dot` is the picker's swatch — stronger than the wash so a
   6px circle still reads as that colour. Defined on :root because the format bar
   is teleported to <body>, away from the pad. */
:root {
  --pad-hl-copper: rgba(217, 119, 87, 0.3);
  --pad-hl-amber: rgba(234, 179, 8, 0.32);
  --pad-hl-moss: rgba(16, 185, 129, 0.26);
  --pad-hl-sky: rgba(56, 132, 255, 0.22);
  --pad-hl-orchid: rgba(167, 106, 240, 0.24);

  --pad-hl-copper-dot: rgba(217, 119, 87, 0.62);
  --pad-hl-amber-dot: rgba(234, 179, 8, 0.68);
  --pad-hl-moss-dot: rgba(16, 185, 129, 0.58);
  --pad-hl-sky-dot: rgba(56, 132, 255, 0.55);
  --pad-hl-orchid-dot: rgba(167, 106, 240, 0.56);

  --pad-tc-copper: #c1613f;
  --pad-tc-moss: #3f9e6f;
  --pad-tc-sky: #4d86d8;
  --pad-tc-orchid: #9268c9;
  --pad-tc-ash: #8a8a90;
}

@media (prefers-color-scheme: dark) {
  :root {
    --pad-hl-copper: rgba(217, 119, 87, 0.36);
    --pad-hl-amber: rgba(234, 179, 8, 0.32);
    --pad-hl-moss: rgba(16, 185, 129, 0.3);
    --pad-hl-sky: rgba(86, 152, 255, 0.32);
    --pad-hl-orchid: rgba(178, 124, 245, 0.32);

    --pad-hl-copper-dot: rgba(226, 137, 108, 0.8);
    --pad-hl-amber-dot: rgba(234, 179, 8, 0.8);
    --pad-hl-moss-dot: rgba(52, 199, 148, 0.75);
    --pad-hl-sky-dot: rgba(108, 166, 255, 0.75);
    --pad-hl-orchid-dot: rgba(188, 141, 247, 0.75);

    --pad-tc-copper: #e8907a;
    --pad-tc-moss: #5fc294;
    --pad-tc-sky: #7fa9f0;
    --pad-tc-orchid: #b58ae0;
    --pad-tc-ash: #9c9ca4;
  }
}

.pad-doc > *:first-child {
  margin-top: 0;
}
.pad-doc > * {
  margin: 0 0 0.55em;
}

.pad-doc h1,
.pad-doc h2,
.pad-doc h3,
.pad-doc h4,
.pad-doc h5,
.pad-doc h6 {
  margin: 1.1em 0 0.35em;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.3;
  color: var(--ink);
}
.pad-doc h1 {
  font-size: 22px;
}
.pad-doc h2 {
  font-size: 19px;
}
.pad-doc h3 {
  font-size: 17px;
}
.pad-doc h4,
.pad-doc h5,
.pad-doc h6 {
  font-size: 16px;
  color: var(--ink-soft, var(--ink));
}

.pad-doc ul,
.pad-doc ol {
  margin: 0 0 0.55em;
  padding-left: 1.25em;
}
.pad-doc li {
  margin: 0.12em 0;
}
.pad-doc ul {
  list-style: none;
}
.pad-doc ul > li::before {
  content: "";
  display: inline-block;
  width: 4px;
  height: 4px;
  margin: 0 0.6em 0.22em -0.9em;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 40%, transparent);
  vertical-align: middle;
}
.pad-doc ol {
  list-style: decimal;
}
.pad-doc ol > li::marker {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* Task items draw their own box, so the caret never lands inside a widget and
   the list still serializes as `- [ ] …`. */
.pad-doc li[data-checked]::before {
  content: "";
  width: 12px;
  height: 12px;
  margin: 0 0.5em 0.14em -1.35em;
  border-radius: 3.5px;
  border: 1.5px solid color-mix(in srgb, var(--ink) 28%, transparent);
  background: transparent;
  cursor: pointer;
}
.pad-doc li[data-checked="true"]::before {
  border-color: var(--accent);
  background:
    linear-gradient(var(--accent), var(--accent)) padding-box,
    var(--accent);
  box-shadow: inset 0 0 0 2px var(--ground);
}
.pad-doc li[data-checked="true"] {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent);
}

.pad-doc blockquote {
  margin: 0 0 0.55em;
  padding-left: 0.85em;
  border-left: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--ink-soft, var(--ink));
}

.pad-doc pre {
  margin: 0 0 0.7em;
  padding: 0.7em 0.85em;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  font-family: var(--font-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.pad-doc code {
  padding: 0.1em 0.32em;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 0.88em;
  color: var(--ink);
}
.pad-doc pre code {
  padding: 0;
  background: none;
  font-size: inherit;
}

.pad-doc hr {
  margin: 1.1em 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
}

.pad-doc a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent);
  text-underline-offset: 2px;
}

/* Geist is served at one weight (400), and `font-synthesis: none` is set app-wide
   — so a bolder `font-weight` here resolves to nothing at all and `**bold**`
   comes out looking exactly like the words around it. The pad turns weight
   synthesis back on for its own document: emphasis you just typed has to be
   visible, and the pad is the one place in kone where that's the whole point.
   <b> is what the browser's bold command writes, <strong> what Markdown brings. */
.pad-doc {
  font-synthesis: weight;
}
.pad-doc b,
.pad-doc strong {
  font-weight: 700;
}

.pad-doc s,
.pad-doc del,
.pad-doc strike {
  text-decoration-color: color-mix(in srgb, currentColor 55%, transparent);
}

/* ── The two pens ─────────────────────────────────────────────────────────── */
/* Selected text is tinted to plain ink app-wide, for legibility on the accent
   wash. In the pad that hides the pen you just used: the words stay selected so
   you can try another colour, so a freshly coloured run would read as unchanged
   until you clicked away. Here selected text keeps its own colour — and it has to
   be `currentColor`, since `inherit` picks the ink straight back up. */
.pad-doc::selection,
.pad-doc ::selection {
  color: currentColor;
}

/* A mark carries only the name of its colour; the wash it resolves to is per
   scheme (see padColors.ts). The shape — how it hugs the text and survives a
   line wrap — is the same either way. */
.pad-doc mark,
.pad-doc span[style*="background-color"] {
  padding: 0.08em 0.16em;
  margin: 0 -0.04em;
  border-radius: 4px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  color: inherit;
  background: var(--pad-hl-copper);
}
.pad-doc mark[data-hl="amber"] {
  background: var(--pad-hl-amber);
}
.pad-doc mark[data-hl="moss"] {
  background: var(--pad-hl-moss);
}
.pad-doc mark[data-hl="sky"] {
  background: var(--pad-hl-sky);
}
.pad-doc mark[data-hl="orchid"] {
  background: var(--pad-hl-orchid);
}

.pad-doc span[data-tc="copper"] {
  color: var(--pad-tc-copper);
}
.pad-doc span[data-tc="moss"] {
  color: var(--pad-tc-moss);
}
.pad-doc span[data-tc="sky"] {
  color: var(--pad-tc-sky);
}
.pad-doc span[data-tc="orchid"] {
  color: var(--pad-tc-orchid);
}
.pad-doc span[data-tc="ash"] {
  color: var(--pad-tc-ash);
}
</style>
