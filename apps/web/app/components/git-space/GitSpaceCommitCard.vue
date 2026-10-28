<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Magnet } from "~/components/ui/magnet";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";
import type { GitCommitDetail, GitCommitFile, GitFileDiff } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// A commit, opened over the history it came from — the same card a changed
// file opens into: it grows out of the clicked row, stops just short of the
// window's edges and shrinks back into the row on close, so the log you were
// reading stays where you left it under the scrim.
//
// The layout is the file card's too, so the two read as one kind of thing:
// actions down the left, the commit itself in the scrolling middle (subject,
// author, the message as written, then the files, each unfolding its own diff
// in place), and the facts down a mono rail on the right. It mounts itself on
// the body and owns its entrance, exit and Escape; the opener mounts it and
// unmounts it on `close`.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  hash: string;
  /** The clicked row's viewport rect — the grow's origin. */
  origin: DOMRect | null;
}>();

const emit = defineEmits<{
  /** Its exit has finished; unmount it now. */
  close: [];
}>();

const { cue } = useSound();

const detail = ref<GitCommitDetail | null>(null);
const loading = ref(true);
const openPath = ref<string | null>(null);
const diff = ref<GitFileDiff | null>(null);
const diffLoading = ref(false);
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

// The author's face comes from a separate, de-duped read of the repository's
// commit authors, so asking here costs nothing once History has.
onMounted(() => {
  void props.space.loadCommitAuthors();
});

watch(
  () => props.hash,
  async (hash) => {
    loading.value = true;
    detail.value = null;
    openPath.value = null;
    diff.value = null;
    const d = await props.space.commitDetail(hash);
    // A newer commit may have been opened while this was in flight.
    if (props.hash !== hash) return;
    detail.value = d;
    loading.value = false;
  },
  { immediate: true },
);

const commit = computed(() => detail.value?.commit ?? null);
const shortHash = computed(() => commit.value?.short ?? props.hash.slice(0, 7));
const isMerge = computed(() => (detail.value?.parents.length ?? 0) > 1);

const face = computed(() => props.space.faceFor(commit.value?.email));
const authorName = computed(() => commit.value?.author ?? "");
const authorInitial = computed(() => authorName.value[0]?.toUpperCase() ?? "");

/** The date it happened, not a distance from now: the list is where distances
 *  are scanned, and this is the fixed point. */
const when = computed(() => {
  const iso = commit.value?.date;
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  return then.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
});

const fileCount = computed(() => detail.value?.files.length ?? 0);

const webUrl = computed(() => {
  const o = props.space.origin.value;
  if (!o?.slug || !o.host) return null;
  return `https://${o.host}/${o.slug}/commit/${props.hash}`;
});

// The CHANGES readout as a proportional row of solid boxes, as the file card
// draws it.
const boxes = computed<("add" | "del")[]>(() => {
  const a = detail.value?.added ?? 0;
  const r = detail.value?.removed ?? 0;
  const total = a + r;
  if (total === 0) return [];
  const n = Math.min(total, 14);
  let greens = Math.round((n * a) / total);
  if (a > 0) greens = Math.max(1, greens);
  if (r > 0) greens = Math.min(n - 1, greens);
  const out: ("add" | "del")[] = [];
  for (let index = 0; index < n; index += 1) out.push(index < greens ? "add" : "del");
  return out;
});

async function toggleFile(f: GitCommitFile) {
  if (openPath.value === f.path) {
    openPath.value = null;
    cue("collapse");
    return;
  }
  cue("expand");
  openPath.value = f.path;
  diff.value = null;
  if (f.binary) return;
  diffLoading.value = true;
  const d = await props.space.commitDiff(props.hash, f.path);
  if (openPath.value !== f.path) return;
  diff.value = d;
  diffLoading.value = false;
}

async function copyHash() {
  try {
    await navigator.clipboard.writeText(props.hash);
    cue("copy");
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1400);
  } catch {
    // Clipboard denied — the hash is on screen and selectable anyway.
  }
}

function nameOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

// How far the card stands in from the window's edges, and the widest it gets.
const INSET = 20;
const MAX_WIDTH = 1080;

// Grow from the clicked row's centre, in the card's own coordinates: it sits
// INSET down from the window's top, centred across it.
const originStyle = computed(() => {
  const vars: Record<string, string> = { "--cm-inset": `${INSET}px`, "--cm-max": `${MAX_WIDTH}px` };
  const r = props.origin;
  if (!r) return vars;
  const left = Math.max(INSET, (window.innerWidth - MAX_WIDTH) / 2);
  vars["--ox"] = `${r.left + r.width / 2 - left}px`;
  vars["--oy"] = `${r.top + r.height / 2 - INSET}px`;
  return vars;
});

const { shown, dismiss } = useModalExit();
function onClose(): void {
  dismiss(() => emit("close"));
}

// The space behind answers Escape too. Taken in the capture phase and consumed,
// one press closes this card and nothing behind it.
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onClose();
}

const backEl = ref<HTMLButtonElement | null>(null);
const frameEl = ref<HTMLElement | null>(null);
const mainEl = ref<HTMLElement | null>(null);
// The row that opened the card, so focus goes back to it on close and a
// keyboard reader carries on down the list from where they were.
let opener: HTMLElement | null = null;

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("keydown", onEscape, { capture: true });
  requestAnimationFrame(() => (shown.value = true));
  backEl.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEscape, { capture: true });
  clearTimeout(copyTimer);
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});

// The arrow / page / home / end keys scroll the body wherever focus sits, so
// it never has to be tabbed into.
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]);
function onScrollKeys(e: KeyboardEvent) {
  const el = mainEl.value;
  if (!el || !SCROLL_KEYS.has(e.key)) return;
  e.preventDefault();
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

// Keep Tab inside the card — it's modal, so focus shouldn't leak to the page.
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
  const activeNode = document.activeElement;
  const active = activeNode instanceof HTMLElement ? activeNode : null;
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
  <Teleport to="body">
    <ModalShell v-slot="{ card }" :shown="shown" class="z-50" @dismiss="onClose">
      <div
        v-bind="card"
        class="cm"
        :style="originStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="commit?.subject ?? `Commit ${shortHash}`"
        @keydown="onKeydown"
      >
        <div ref="frameEl" class="cm__frame">
          <header class="cm__bar">
            <button ref="backEl" type="button" class="cm__back" aria-label="Back to the history" @click="onClose">
              <HugeiconsIcon
                class="cm__back-glyph"
                :icon="ArrowTurnBackwardIcon"
                :size="18"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>
            <span class="cm__crumb">
              <span class="cm__crumb-dim">commit</span>
              <span class="cm__crumb-name">{{ shortHash }}</span>
            </span>
          </header>

          <div class="cm__body">
            <!-- Left: commit-scoped actions. -->
            <div class="cm__left">
              <Magnet
                class="w-fit"
                inner-class="w-fit"
                :padding="12"
                :magnet-strength="9"
                active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
                inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
              >
                <button type="button" class="act" :class="{ 'act--copied': copied }" @click="copyHash">
                  <span class="act__ic">
                    <HugeiconsIcon class="act__copy" :icon="Copy01Icon" :size="14" :stroke-width="2" />
                    <HugeiconsIcon class="act__tick" :icon="Tick02Icon" :size="14" :stroke-width="2" />
                  </span>
                  {{ copied ? "Copied" : "Copy hash" }}
                </button>
              </Magnet>
              <Magnet
                v-if="webUrl"
                class="w-fit"
                inner-class="w-fit"
                :padding="12"
                :magnet-strength="9"
                active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
                inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
              >
                <button type="button" class="act" @click="space.openExternal(webUrl)">
                  <span class="act__ic">
                    <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" />
                  </span>
                  GitHub
                </button>
              </Magnet>
            </div>

            <!-- Middle: the commit itself. Only this scrolls. -->
            <div ref="mainEl" class="cm__main" tabindex="-1">
              <h1 class="cm__subject">{{ commit?.subject ?? "Commit" }}</h1>
              <p v-if="commit" class="cm__note">
                <span class="cm__author">
                  <span class="cm__face" aria-hidden="true">
                    <img v-if="face?.avatarDataUrl" :src="face.avatarDataUrl" alt="" />
                    <span v-else>{{ authorInitial }}</span>
                  </span>
                  {{ authorName }}
                </span>
                <span>{{ when }}</span>
              </p>

              <GitSpaceSkeleton v-if="loading" variant="prose" class="cm__gap" />

              <p v-else-if="!detail" class="cm__empty">This commit couldn't be read.</p>

              <template v-else>
                <p v-if="detail.body" class="cm__msg selectable">{{ detail.body }}</p>

                <p class="cm__stat">
                  <span>{{ fileCount }} file{{ fileCount === 1 ? "" : "s" }}</span>
                  <span v-if="detail.added" class="cm__add">+{{ detail.added }}</span>
                  <span v-if="detail.removed" class="cm__del">−{{ detail.removed }}</span>
                </p>

                <div class="cm__files">
                  <div v-for="(f, i) in detail.files" :key="f.path" class="cm__file" :style="{ '--i': i }">
                    <button
                      type="button"
                      class="cm__row"
                      :class="{ 'cm__row--on': openPath === f.path }"
                      :title="f.path"
                      :aria-expanded="openPath === f.path"
                      @click="toggleFile(f)"
                    >
                      <FileIcon :path="f.path" :size="14" />
                      <span class="cm__path">
                        <span class="cm__dir">{{ dirOf(f.path) }}</span>{{ nameOf(f.path) }}
                      </span>
                      <span v-if="f.from" class="cm__dim">from {{ nameOf(f.from) }}</span>
                      <span class="cm__nums">
                        <span v-if="f.added" class="cm__add">+{{ f.added }}</span>
                        <span v-if="f.removed" class="cm__del">−{{ f.removed }}</span>
                      </span>
                    </button>

                    <GitSpaceInlineDiff v-if="openPath === f.path" :diff="diff" :loading="diffLoading" />
                  </div>
                </div>
              </template>
            </div>

            <!-- Right: the facts, read top-down. -->
            <aside class="cm__meta">
              <div class="meta">
                <span class="meta__k">Commit</span>
                <span class="meta__v meta__v--ink">{{ shortHash }}</span>
              </div>
              <div v-if="commit" class="meta">
                <span class="meta__k">Author</span>
                <span class="meta__v">{{ authorName }}</span>
              </div>
              <div v-if="when" class="meta">
                <span class="meta__k">Date</span>
                <span class="meta__v">{{ when }}</span>
              </div>
              <div v-if="detail" class="meta">
                <span class="meta__k">Changes</span>
                <span class="meta__v meta__v--diff">
                  <span v-if="detail.added" class="cm__add">+{{ detail.added }}</span>
                  <span v-if="detail.removed" class="cm__del">−{{ detail.removed }}</span>
                  <span v-if="!detail.added && !detail.removed" class="meta__none">—</span>
                </span>
                <span v-if="boxes.length" class="meta__boxes">
                  <i v-for="(b, i) in boxes" :key="i" class="meta__box" :class="`meta__box--${b}`" />
                </span>
              </div>
              <div v-if="detail" class="meta">
                <span class="meta__k">Files</span>
                <span class="meta__v">{{ fileCount }}</span>
              </div>
              <div v-if="isMerge" class="meta">
                <span class="meta__k">Merge</span>
                <span class="meta__v">of {{ detail?.parents.length }} parents</span>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
/* The card is teleported out of the space, so the space's motion vocabulary
   doesn't reach it by inheritance; the pieces inside it (the inline diff, the
   skeleton) read these. */
.cm {
  --gs-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --gs-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --gs-t-micro: 140ms;
  --gs-t-small: 220ms;
  --gs-t-enter: 320ms;
  --gs-t-large: 420ms;
  --gs-stagger: 22ms;
  --gs-t-sweep: 1100ms;
  --gs-t-breathe: 1700ms;
  --gs-hold: 140ms;
  position: absolute;
  inset: var(--cm-inset, 20px) 0;
  width: min(var(--cm-max, 1080px), calc(100% - 2 * var(--cm-inset, 20px)));
  margin-inline: auto;
  z-index: 1;
  display: flex;
  justify-content: center;
  overflow: hidden;
  border-radius: 22px;
  background-color: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 16px 40px -16px rgb(0 0 0 / 24%);
}
/* Grow out of the clicked row, and shrink back into it. */
.cm.is-in {
  animation: cm-grow 460ms cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.cm.is-out {
  animation: cm-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes cm-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
}
@keyframes cm-shrink {
  to { opacity: 0; transform: scale(0.16); }
}
.cm__frame {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1080px;
  height: 100%;
  padding: 34px 40px 0;
  min-height: 0;
}

/* ── top bar ──────────────────────────────────────────────────────────────── */
.cm__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  padding-bottom: 22px;
}
.cm__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  opacity: 0.7;
  cursor: pointer;
  transition:
    opacity 0.18s ease,
    color 0.25s ease;
}
.cm__back:hover,
.cm__back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
.cm__back-glyph {
  transform: rotate(180deg) scaleX(-1);
}
.cm__crumb {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.cm__crumb-dim { color: var(--muted); }
.cm__crumb-name { color: var(--ink); }

/* ── body: actions · commit · facts ───────────────────────────────────────── */
.cm__body {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) 150px;
  gap: 30px;
  flex: 1;
  min-height: 0;
}

.cm__left {
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
  white-space: nowrap;
  color: var(--ink-soft);
  cursor: pointer;
  transition: color 0.16s ease;
}
.act:hover { color: var(--ink); }
.act:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
.act__ic {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}
/* Copy → tick is a quiet crossfade in a fixed box, so the label never shifts. */
.act__copy,
.act__tick {
  position: absolute;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.act__tick { opacity: 0; }
.act--copied .act__copy { opacity: 0; }
.act--copied .act__tick { opacity: 1; }

/* ── the commit ───────────────────────────────────────────────────────────── */
.cm__main {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0 40px;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 34px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 34px), transparent 100%);
  scrollbar-width: none;
}
.cm__main::-webkit-scrollbar { width: 0; height: 0; }
.cm__main:focus { outline: none; }

.cm__subject {
  font-size: 22px;
  letter-spacing: -0.4px;
  line-height: 1.25;
  color: var(--ink);
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.cm__note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.cm__note > span + span::before {
  content: "·";
  margin-right: 10px;
  opacity: 0.5;
}
.cm__author {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.cm__face {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1;
  color: var(--muted);
}
.cm__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cm__gap { margin-top: 28px; }
.cm__empty {
  margin-top: 28px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}

/* The message as written — its own line breaks are meaning, so they're kept. */
.cm__msg {
  max-width: 74ch;
  margin-top: 24px;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-soft);
}

.cm__stat {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 28px 0 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.cm__add { color: var(--diff-add); }
.cm__del { color: var(--diff-del); }

.cm__files {
  display: flex;
  flex-direction: column;
}
.cm__file {
  animation: cm-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
@keyframes cm-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.cm__row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: calc(100% + 16px);
  height: 30px;
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.cm__row:hover,
.cm__row--on {
  background-color: var(--hover);
}
.cm__row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.cm__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--ink);
}
.cm__dir { color: var(--muted); }
.cm__dim {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
}
.cm__nums {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* ── facts rail ───────────────────────────────────────────────────────────── */
.cm__meta {
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
.meta__v--ink { color: var(--ink); }
.meta__v--diff { display: inline-flex; gap: 8px; font-variant-numeric: tabular-nums; }
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

@media (prefers-reduced-motion: reduce) {
  .cm.is-in,
  .cm.is-out {
    animation-duration: 0.01s;
  }
  .cm__file {
    animation: none;
  }
  .cm__row,
  .act__copy,
  .act__tick {
    transition: none;
  }
}
</style>
