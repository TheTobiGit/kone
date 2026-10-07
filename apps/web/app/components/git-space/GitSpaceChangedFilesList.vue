<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowExpand01Icon } from "@hugeicons/core-free-icons";
import FileIcon from "~/components/file/FileIcon.vue";
import DockSection from "~/components/thread/DockSection.vue";
import { useDockSection } from "~/composables/useDockSections";
import type { ChangedFile } from "~/utils/changedFiles";
import type { GitFileDiff } from "~/types/desktop";
import type { DiffRow } from "~/composables/useDiff";

// The Changes section of the thread dock — a sibling of the Tasks section
// (PlanTaskList) in the same shell. It lists every file the agent has created,
// edited, or removed this thread: the real file-type logo, the filename, and
// its +added / −removed diffstat, with the aggregate +/− in the head — the same
// diff vocabulary the change cards use.
//
// Picking a row doesn't leave the dock: the section itself morphs. It asks the
// shell for the wide stance, the head swaps its title for a back step + the
// file's own name, and the body cross-fades from the row list to that file's
// unified diff (the same highlighted rows the full detail view builds). From
// there, Back returns to the list and Open hands the file up to the full-screen
// detail.

const props = defineProps<{
  files: ChangedFile[];
  /** Aggregate +/− across all files — shown in the header. */
  totalAdded?: number;
  totalRemoved?: number;
  /** A file write is still in flight — keeps the dock open. */
  streaming?: boolean;
  /** Open project path — what the in-dock diff is read against. Without it the
   *  rows stay inert (nothing to read a diff from). */
  repoPath?: string;
}>();

const emit = defineEmits<{
  /** Escalate the peeked file to the full-screen detail, with the dock row's
   *  rect so the detail grows out of it. */
  openFile: [path: string, rect: DOMRect | null];
}>();

const { cue } = useSound();

// Open only when the section mounts into a live turn — the user is here
// watching work happen. Reopening a settled thread mounts collapsed: they came
// back to read the response, not to re-scan the file list. A write starting
// mid-thread still opens it via the streaming watch below.
const expanded = ref(props.streaming ?? false);
const { setWide } = useDockSection("changes", expanded);

const totalAdded = computed(() => props.totalAdded ?? 0);
const totalRemoved = computed(() => props.totalRemoved ?? 0);
const hasTotals = computed(() => totalAdded.value > 0 || totalRemoved.value > 0);

const liveFile = computed(() => props.files.find((f) => f.streaming));

// ── the peeked file ───────────────────────────────────────────────────────
// One file's diff, read in place. `peekPath` is the id (a path survives the row
// list re-deriving mid-turn); the row's rect is kept so Open can grow the full
// detail out of the row that was clicked.
const git = useGit();
const { buildRows } = useDiff();
const { scheme } = useTheme();

const peekPath = ref<string | null>(null);
const peekRect = ref<DOMRect | null>(null);
const peekRows = ref<DiffRow[] | null>(null);
const peekNote = ref<string | null>(null);
const peekLoading = ref(false);
// Held so a colour-scheme flip can re-tint the rows without a second read.
const peekDiff = ref<GitFileDiff | null>(null);

const peekFile = computed(
  () => props.files.find((f) => f.path === peekPath.value) ?? null,
);
const canPeek = computed(() => Boolean(props.repoPath));

// A read in flight is stamped, so a slow earlier diff landing after a newer one
// (or after Back) never paints.
let readToken = 0;

async function readDiff(path: string): Promise<void> {
  const dir = props.repoPath;
  if (!dir) return;
  const mine = ++readToken;
  peekLoading.value = true;
  peekNote.value = null;
  peekRows.value = null;
  peekDiff.value = null;
  // Unstaged first — an agent's edits land in the working tree — falling back to
  // the index view so a file the user staged mid-turn still reads.
  let diff = await git.diff(dir, path, false);
  if (!diff || (!diff.binary && diff.hunks.length === 0))
    diff = (await git.diff(dir, path, true)) ?? diff;
  if (mine !== readToken) return;
  peekDiff.value = diff;
  const rows = await buildRows(diff, scheme.value === "dark");
  if (mine !== readToken) return;
  peekRows.value = rows;
  peekNote.value = rows.length
    ? null
    : !diff
      ? "No diff available."
      : diff.binary
        ? "Binary file — nothing to show."
        : "No textual changes.";
  peekLoading.value = false;
}

function openPeek(file: ChangedFile, e: MouseEvent | KeyboardEvent): void {
  if (!canPeek.value) return;
  cue("expand");
  // SAFETY: currentTarget is the row element this click handler is bound to; el?. covers the rest.
  const el = e.currentTarget as HTMLElement | null;
  peekRect.value = el?.getBoundingClientRect() ?? null;
  peekPath.value = file.path;
  expanded.value = true;
  void readDiff(file.path);
}

function closePeek(): void {
  if (!peekPath.value) return;
  readToken++;
  peekPath.value = null;
  peekRows.value = null;
  peekDiff.value = null;
  peekNote.value = null;
  peekLoading.value = false;
  cue("collapse");
}

function openFull(): void {
  const path = peekPath.value;
  if (!path) return;
  emit("openFile", path, peekRect.value);
}

// The peek follows its file: a fresh write to it re-reads the diff, and a file
// that leaves the thread's list takes its peek with it.
watch(peekFile, (file, was) => {
  if (!peekPath.value) return;
  if (!file) {
    peekPath.value = null;
    peekRows.value = null;
    peekDiff.value = null;
    peekNote.value = null;
    return;
  }
  if (was && (file.added !== was.added || file.removed !== was.removed))
    void readDiff(file.path);
});

// Re-tint (not re-read) when the colour scheme flips.
watch(scheme, async () => {
  if (!peekDiff.value) return;
  const mine = readToken;
  const rows = await buildRows(peekDiff.value, scheme.value === "dark");
  if (mine !== readToken) return;
  peekRows.value = rows;
});

// A diff wants room: the shell widens while one is open — and only while the
// section is open to show it.
watch([peekPath, expanded], ([path, open]) => setWide(Boolean(path) && open), { immediate: true });

function toggle(): void {
  expanded.value = !expanded.value;
  cue(expanded.value ? "expand" : "collapse");
}

// A live write opens the body; from there it stays open until the user collapses
// it — the list of what changed outlives the turn, so we never auto-close it.
watch(
  () => props.streaming,
  (live, was) => {
    if (live && !was) expanded.value = true;
  },
);

// Esc steps back out of the diff before anything else takes it — the dock's own
// share of the board's back stack.
useEventListener(window, "keydown", (e) => {
  if (!peekPath.value || e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  closePeek();
});

const rowSpring = { type: "spring", stiffness: 460, damping: 24, mass: 0.65 } as const;
const fadeEase = [0.22, 1, 0.36, 1] as const;
const chevSpring = { type: "spring", stiffness: 520, damping: 30, mass: 0.45 } as const;

function rowDelay(index: number): number {
  return Math.min(index * 0.045, 0.28);
}

// A created file with no counted lines yet reads as "new" rather than an empty
// diffstat — mirrors the change card's quiet marker.
function isEmptyNew(file: ChangedFile): boolean {
  return file.kind === "created" && file.added === 0 && file.removed === 0;
}
</script>

<template>
  <DockSection label="Changes" :expanded="expanded" @toggle="toggle">
    <!-- Peeking a file: the head becomes the way back out of it — a back step
         carrying the file's own name, its diffstat, and the escalation to the
         full-screen detail. The fold chevron stays put through the swap so the
         section never loses its collapse. -->
    <template v-if="peekFile" #head="{ toggle: fold }">
      <div class="dock-section__head peek-head">
        <button
          type="button"
          class="peek-back"
          title="Back to changed files"
          aria-label="Back to changed files"
          @click="closePeek"
        >
          <HugeiconsIcon :icon="ArrowLeft01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          <FileIcon :path="peekFile.name" :size="15" />
          <span class="peek-name" :title="peekFile.path">{{ peekFile.name }}</span>
        </button>
        <span class="dock-section__trail">
          <span class="chg-total">
            <span v-if="peekFile.added > 0" class="chg-add">+{{ peekFile.added }}</span>
            <span v-if="peekFile.removed > 0" class="chg-del">−{{ peekFile.removed }}</span>
          </span>
          <button
            type="button"
            class="peek-open"
            title="Open the full file"
            aria-label="Open the full file"
            @click="openFull"
          >
            <HugeiconsIcon :icon="ArrowExpand01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
            <span>Open</span>
          </button>
          <button
            type="button"
            class="peek-fold"
            :aria-expanded="expanded"
            :aria-label="expanded ? 'Collapse' : 'Expand'"
            @click="fold"
          >
            <motion.span
              class="dock-section__chev"
              :animate="{ rotate: expanded ? 180 : 0 }"
              :transition="chevSpring"
              aria-hidden="true"
            >
              <HugeiconsIcon :icon="ArrowDown01Icon" :size="14" :stroke-width="2" />
            </motion.span>
          </button>
        </span>
      </div>
    </template>

    <template #trail>
      <AnimatePresence mode="wait">
        <motion.span
          v-if="!expanded && liveFile"
          :key="liveFile.id"
          class="dock-peek"
          :title="liveFile.path"
          :initial="{ opacity: 0, x: 8 }"
          :animate="{ opacity: 1, x: 0 }"
          :exit="{ opacity: 0, x: -6 }"
          :transition="{ duration: 0.22, ease: fadeEase }"
        >
          {{ liveFile.name }}
        </motion.span>
      </AnimatePresence>
      <span class="chg-total" :class="{ 'chg-total--muted': !hasTotals }">
        <template v-if="hasTotals">
          <span v-if="totalAdded > 0" class="chg-add">+{{ totalAdded }}</span>
          <span v-if="totalRemoved > 0" class="chg-del">−{{ totalRemoved }}</span>
        </template>
        <span v-else>{{ streaming ? "…" : files.length }}</span>
      </span>
    </template>

    <!-- The diff, in the dock: one unified column, syntax-highlighted with
         word-level emphasis on the changed spans — the same rows the full
         detail builds, set at dock scale. -->
    <div v-if="peekFile" class="dock-scroll peek-scroll">
      <div v-if="peekLoading" class="peek-skeleton">
        <span
          v-for="n in 7"
          :key="n"
          class="peek-skeleton__row"
          :style="{ '--i': n, width: `${32 + ((n * 37) % 56)}%` }"
        />
      </div>
      <p v-else-if="peekNote" class="dock-empty">{{ peekNote }}</p>
      <template v-else>
        <template v-for="(row, i) in peekRows" :key="i">
          <div v-if="row.kind === 'gap'" class="pdl__gap" aria-hidden="true">
            <span /><span />
          </div>
          <div v-else class="pdl" :class="`pdl--${row.kind}`">
            <span class="pdl__no">{{ row.newNo ?? row.oldNo ?? "" }}</span>
            <span class="pdl__sign" aria-hidden="true">{{ row.kind === "add" ? "+" : row.kind === "del" ? "−" : "" }}</span>
            <span class="pdl__text"><span
              v-for="(c, j) in row.chunks"
              :key="j"
              :class="{ pdl__emph: c.emph }"
              :style="{ color: c.color }"
            >{{ c.text }}</span></span>
          </div>
        </template>
      </template>
    </div>

    <div v-else class="dock-scroll">
      <AnimatePresence mode="wait">
        <motion.p
          v-if="!props.files.length"
          key="empty"
          class="dock-empty"
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :exit="{ opacity: 0, y: -4 }"
          :transition="{ duration: 0.2, ease: fadeEase }"
        >
          {{ streaming ? "Working…" : "No changes" }}
        </motion.p>
      </AnimatePresence>

      <AnimatePresence :initial="false">
        <motion.div
          v-for="(file, index) in props.files"
          :key="file.id"
          class="chg-row"
          :class="{
            'chg-row--removed': file.kind === 'removed',
            'chg-row--pick': canPeek,
          }"
          :role="canPeek ? 'button' : undefined"
          :tabindex="canPeek ? 0 : undefined"
          @click="openPeek(file, $event)"
          @keydown.enter.prevent="openPeek(file, $event)"
          @keydown.space.prevent="openPeek(file, $event)"
          layout
          :initial="{ opacity: 0, y: 8, scale: 0.98 }"
          :animate="{ opacity: 1, y: 0, scale: 1 }"
          :exit="{ opacity: 0, y: -6, scale: 0.98 }"
          :transition="{ ...rowSpring, delay: rowDelay(index) }"
        >
          <span class="chg-icon" aria-hidden="true">
            <FileIcon :path="file.name" :size="16" />
          </span>
          <span class="chg-name" :title="file.path">{{ file.name }}</span>
          <span class="chg-stat">
            <span v-if="file.kind === 'removed' && !file.removed" class="chg-tag">removed</span>
            <span v-else-if="isEmptyNew(file)" class="chg-tag">new</span>
            <template v-else>
              <span v-if="file.added > 0" class="chg-add">+{{ file.added }}</span>
              <span v-if="file.removed > 0" class="chg-del">−{{ file.removed }}</span>
            </template>
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  </DockSection>
</template>

<style scoped>
/* Header diffstat — the aggregate +/− (or a plain count until anything's
   measured), in the same mono/tabular treatment as the change cards. */
.chg-total {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.chg-total--muted {
  color: var(--muted);
}

.chg-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.38rem 0.55rem;
  border-radius: 9px;
}
/* A row is a way in — it lights on hover like the peek drawer's rows do. */
.chg-row--pick {
  cursor: pointer;
  outline: none;
  transition: background-color 0.14s ease;
}
.chg-row--pick:hover,
.chg-row--pick:focus-visible {
  background-color: var(--hover);
}
.chg-row--pick:focus-visible {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent);
}
.chg-row--pick:hover .chg-name {
  color: var(--ink);
}

/* ── peek head ────────────────────────────────────────────────────────────── */
/* The head the list swaps for while a file is open: back on the left (chevron,
   file logo, name), diffstat + Open + the fold chevron on the right. It is not
   itself a button, so it doesn't light as one. */
.peek-head {
  cursor: default;
}
.peek-head:hover {
  background-color: transparent;
}
.peek-back {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  padding: 0.125rem 0.375rem 0.125rem 0.25rem;
  margin-left: -0.25rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
}
.peek-back:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.peek-back:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 28%, transparent);
}
.peek-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.peek-back:hover .peek-name {
  color: var(--ink);
}
.peek-open {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  padding: 0.2rem 0.45rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
}
.peek-open:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.peek-open:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 28%, transparent);
}
.peek-fold {
  display: inline-flex;
  align-items: center;
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.peek-fold:focus-visible {
  outline: none;
  border-radius: 6px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 28%, transparent);
}

/* ── the diff, in the dock ────────────────────────────────────────────────── */
/* Unified, tinted rather than boxed — a wash behind changed lines and the sign
   carrying the colour, so a whole new file never becomes a green block. Long
   lines run out to their own horizontal scroll instead of wrapping, which would
   break the code's shape at this width. */
.dock-scroll.peek-scroll {
  overflow-x: auto;
  padding: 0.25rem 0.55rem 0.35rem 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  animation: peek-diff-in 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes peek-diff-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: none; }
}
.pdl {
  display: flex;
  align-items: baseline;
  min-width: max-content;
  border-radius: 3px;
  white-space: pre;
}
.pdl--add {
  background-color: color-mix(in srgb, var(--diff-add) 8%, transparent);
}
.pdl--del {
  background-color: color-mix(in srgb, var(--diff-del) 8%, transparent);
}
.pdl__no {
  flex: none;
  width: 38px;
  padding-inline: 6px 8px;
  text-align: right;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.5;
  -webkit-user-select: none;
  user-select: none;
}
.pdl__sign {
  flex: none;
  width: 13px;
  text-align: center;
  -webkit-user-select: none;
  user-select: none;
}
.pdl--add .pdl__sign {
  color: var(--diff-add);
}
.pdl--del .pdl__sign {
  color: var(--diff-del);
}
.pdl__text {
  flex: 1;
  min-width: 0;
  padding-inline-end: 14px;
  color: var(--ink-soft);
  tab-size: 2;
}
/* The words that actually changed on a changed line — tinted by the line's own
   add/del colour, the same emphasis the full detail draws. */
.pdl__emph {
  border-radius: 3px;
  padding: 1px 0;
}
.pdl--add .pdl__emph {
  background-color: color-mix(in srgb, var(--diff-add) 22%, transparent);
}
.pdl--del .pdl__emph {
  background-color: color-mix(in srgb, var(--diff-del) 22%, transparent);
}
/* Skipped lines between hunks — a quiet break, not a rule. */
.pdl__gap {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 14px;
  padding-left: 12px;
  opacity: 0.4;
}
.pdl__gap span {
  width: 3px;
  height: 3px;
  border-radius: 999px;
  background-color: var(--muted);
}

/* Reading — the diff's own rows, held back until it lands. */
.peek-skeleton {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 0.5rem 0 0.5rem 0.5rem;
}
.peek-skeleton__row {
  height: 8px;
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--muted) 18%, transparent);
  animation: peek-skeleton-pulse 1.4s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 70ms);
}
@keyframes peek-skeleton-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 0.9; }
}

.chg-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
}

.chg-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.chg-row--removed .chg-name {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted) 70%, transparent);
}

.chg-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.chg-add {
  color: var(--diff-add);
}
.chg-del {
  color: var(--diff-del);
}

.chg-tag {
  font-size: 10px;
  letter-spacing: 0.3px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .peek-scroll {
    animation: none;
  }
  .peek-skeleton__row {
    animation: none;
    opacity: 0.6;
  }
}
</style>
