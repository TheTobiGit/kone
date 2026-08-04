<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { GitCommitDetail, GitCommitFile, GitFileDiff } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// One commit, given the whole surface.
//
// The inline version of this (GitSpaceCommitDetail, still used under a history
// row) has to stay small enough that the timeline around it reads — so it shows
// the body and the files and nothing about who wrote it, because the row above
// it already said. Standing alone, there is no row above it: this view has to
// introduce the commit itself, and it has the room to do it properly.
//
// So the head answers what the inline one can't — the subject as a title, the
// author as a person with a face, the date as a fixed point — and the page under
// it keeps the inline version's shape exactly: body first (that's the author
// talking), then the files, each unfolding its own diff in place.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  hash: string;
  /** This view is a step deeper — it was opened from a pull request, not from
   *  the history. All the stack can say is *that* there's something underneath,
   *  never what, so this changes the back button's wording and nothing more:
   *  a breadcrumb that can't name its parent is worse than an arrow. */
  nested: boolean;
}>();

const emit = defineEmits<{
  back: [];
  openFile: [path: string, rect: DOMRect | null];
}>();

const { cue } = useSound();

const detail = ref<GitCommitDetail | null>(null);
const loading = ref(true);
const openPath = ref<string | null>(null);
const diff = ref<GitFileDiff | null>(null);
const diffLoading = ref(false);
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

// The author's face comes from a separate read of the repository's commit
// authors (git knows an email, GitHub knows the account behind it). It's
// de-duped per space, so asking here costs nothing if History already did.
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
const isMerge = computed(() => (detail.value?.parents.length ?? 0) > 1);

const face = computed(() => props.space.faceFor(commit.value?.email));
const authorName = computed(() => commit.value?.author ?? "");
const authorInitial = computed(() => authorName.value[0]?.toUpperCase() ?? "");

/** The commit's date written out. A commit is a fixed point in the record, so
 *  it gets the date it happened, not a distance from now — the relative form is
 *  the history list's job, where distances are what you're scanning by. */
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

const backLabel = computed(() =>
  props.nested ? "Back to the pull request" : "Back to the history",
);

async function toggleFile(f: GitCommitFile) {
  if (openPath.value === f.path) {
    openPath.value = null;
    return;
  }
  cue("toggle");
  openPath.value = f.path;
  diff.value = null;
  if (f.binary) return;
  diffLoading.value = true;
  const d = await props.space.commitDiff(props.hash, f.path);
  if (openPath.value !== f.path) return;
  diff.value = d;
  diffLoading.value = false;
}

// The file as it stands now, not as this commit left it — FileDetail reads the
// working tree. That's the useful jump (you read the history, then go look at
// what the file became), but it's a jump to the present, so it's a separate,
// quiet affordance rather than what clicking the row does.
function openInFileDetail(e: Event, path: string) {
  const el = (e.currentTarget as HTMLElement).closest(".cv__file");
  emit("openFile", path, el ? el.getBoundingClientRect() : null);
}

async function copyHash() {
  try {
    await navigator.clipboard.writeText(props.hash);
    cue("toggle");
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1400);
  } catch {
    // Clipboard denied — the hash is on screen and selectable anyway.
  }
}

function goBack() {
  emit("back");
}

function nameOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}
</script>

<template>
  <article class="cv">
    <!-- ── head ─────────────────────────────────────────────────────────────
         The shell's masthead, with a back arrow where the repo slug's indent
         would be: same eyebrow / title / note column, so stepping into a commit
         doesn't feel like landing on a different kind of page. -->
    <header class="cv__head">
      <button type="button" class="cv__back" :aria-label="backLabel" :title="backLabel" @click="goBack">
        <HugeiconsIcon
          class="cv__back-glyph"
          :icon="ArrowTurnBackwardIcon"
          :size="18"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>

      <div class="cv__identity">
        <p class="cv__eyebrow">{{ commit?.short ?? hash.slice(0, 7) }}</p>
        <h1 class="cv__subject">{{ commit?.subject ?? "Commit" }}</h1>

        <p v-if="commit" class="cv__note">
          <span class="cv__author">
            <span class="cv__face" aria-hidden="true">
              <img v-if="face?.avatarDataUrl" :src="face.avatarDataUrl" alt="" />
              <span v-else>{{ authorInitial }}</span>
            </span>
            {{ authorName }}
          </span>
          <span>{{ when }}</span>
          <span v-if="isMerge">merge of {{ detail?.parents.length }}</span>
        </p>
      </div>

      <div class="cv__actions">
        <button
          type="button"
          class="cv__btn"
          :class="{ 'cv__btn--copied': copied }"
          title="Copy full hash"
          @click="copyHash"
        >
          <span class="cv__copyicon" aria-hidden="true">
            <HugeiconsIcon class="cv__icon-copy" :icon="Copy01Icon" :size="12" :stroke-width="2" />
            <HugeiconsIcon class="cv__icon-tick" :icon="Tick02Icon" :size="12" :stroke-width="2" />
          </span>
          {{ copied ? "Copied" : "Copy hash" }}
        </button>
        <button v-if="webUrl" type="button" class="cv__btn" @click="space.openExternal(webUrl)">
          GitHub
          <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </header>

    <!-- ── page ─────────────────────────────────────────────────────────── -->
    <div class="cv__scroll">
      <GitSpaceSkeleton v-if="loading" variant="prose" />

      <p v-else-if="!detail" class="cv__empty">This commit couldn't be read.</p>

      <template v-else>
        <p v-if="detail.body" class="cv__body selectable">{{ detail.body }}</p>

        <!-- The diffstat sits with the list it describes, not in the head: the
             head introduces the commit, this counts what's below it. -->
        <p class="cv__stat">
          <span>{{ fileCount }} file{{ fileCount === 1 ? "" : "s" }}</span>
          <span v-if="detail.added" class="cv__add">+{{ detail.added }}</span>
          <span v-if="detail.removed" class="cv__del">−{{ detail.removed }}</span>
        </p>

        <div class="cv__files">
          <div v-for="(f, i) in detail.files" :key="f.path" class="cv__file" :style="{ '--i': i }">
            <div class="cv__row" :class="{ 'cv__row--on': openPath === f.path }">
              <button type="button" class="cv__rowmain" :title="f.path" @click="toggleFile(f)">
                <FileIcon :path="f.path" :size="14" />
                <span class="cv__path">
                  <span class="cv__dir">{{ dirOf(f.path) }}</span>{{ nameOf(f.path) }}
                </span>
                <span v-if="f.from" class="cv__dim">from {{ nameOf(f.from) }}</span>
              </button>

              <span class="cv__nums">
                <span v-if="f.added" class="cv__add">+{{ f.added }}</span>
                <span v-if="f.removed" class="cv__del">−{{ f.removed }}</span>
              </span>

              <button
                v-if="f.status !== 'deleted'"
                type="button"
                class="cv__open"
                title="Open the file as it is now"
                @click="openInFileDetail($event, f.path)"
              >
                Open
              </button>
            </div>

            <GitSpaceInlineDiff v-if="openPath === f.path" :diff="diff" :loading="diffLoading" />
          </div>
        </div>
      </template>
    </div>
  </article>
</template>

<style scoped>
.cv {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1040px;
  min-height: 0;
  /* Clears the project's corner back arrow, exactly as the shell's inner does,
     so the two surfaces sit at the same height. */
  padding: 5rem 2.5rem 2.5rem;
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.cv__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  animation: cv-in var(--gs-t-enter) var(--gs-ease) backwards;
}
@keyframes cv-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* The same glyph as the project's corner return, turned the same way. */
.cv__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--muted);
  opacity: 0.7;
  cursor: pointer;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.cv__back:hover,
.cv__back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
.cv__back-glyph {
  transform: rotate(180deg) scaleX(-1);
}

.cv__identity {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  flex: 1 1 auto;
}
/* An identifier in its own case, like every hash and path in this space. */
.cv__eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.2px;
  line-height: 1;
  color: var(--muted);
}
/* One size under the shell's branch title: a commit subject is a sentence and
   runs long, and this page is one level down from the branch it belongs to. */
.cv__subject {
  font-size: 22px;
  letter-spacing: -0.4px;
  line-height: 1.25;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.cv__note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.cv__note > span + span::before {
  content: "·";
  margin-right: 10px;
  opacity: 0.5;
}
/* The person, as a unit: a wrap moves the face and the name together. */
.cv__author {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
/* The circle the rail's own face draws, one size down. */
.cv__face {
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
.cv__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cv__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 4px;
}
/* The app's one button recipe: bare until hovered, then a soft pill. */
.cv__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--gs-t-micro) ease;
}
.cv__btn:hover {
  background-color: var(--hover);
}
.cv__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The copy → tick swap is a quiet opacity crossfade at micro, never a pop —
   the two glyphs are stacked in a fixed box so the label never shifts. */
.cv__copyicon {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  width: 12px;
  height: 12px;
}
.cv__icon-copy,
.cv__icon-tick {
  position: absolute;
  inset: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.cv__icon-tick {
  opacity: 0;
}
.cv__btn--copied .cv__icon-copy {
  opacity: 0;
}
.cv__btn--copied .cv__icon-tick {
  opacity: 1;
}

/* ── page ─────────────────────────────────────────────────────────────────── */
/* Indented to the shell's panel, so the reading column doesn't jump sideways
   when you step into a commit from the history. */
.cv__scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin-top: 34px;
  padding-left: 34px;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: cv-in var(--gs-t-enter) var(--gs-ease) var(--gs-enter-panel) backwards;
}

.cv__empty {
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}

/* The commit message as written — its own line breaks are meaning, so they're
   kept, and it's set at reading width rather than the full page. */
.cv__body {
  max-width: 74ch;
  margin-bottom: 26px;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-soft);
}

.cv__stat {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.cv__add {
  color: var(--diff-add);
}
.cv__del {
  color: var(--diff-del);
}

.cv__files {
  display: flex;
  flex-direction: column;
  padding-bottom: 12px;
}
.cv__file {
  animation: cv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}

/* One row, two targets: the path unfolds the diff, "Open" leaves for the live
   file. The hover tint belongs to the row so both read as one thing. */
.cv__row {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: 7px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.cv__row:hover,
.cv__row:focus-within,
.cv__row--on {
  background-color: var(--hover);
}
.cv__rowmain {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  cursor: pointer;
}
.cv__rowmain:focus-visible,
.cv__open:focus-visible {
  outline: none;
  border-radius: 5px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.cv__path {
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
.cv__dir {
  color: var(--muted);
}
.cv__dim {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
}
.cv__nums {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
/* Revealed on hover, like every other row action in the space. It keeps its
   width when hidden so the diffstat above it never shifts sideways. */
.cv__open {
  flex-shrink: 0;
  min-width: 44px;
  text-align: right;
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.cv__row:hover .cv__open,
.cv__row:focus-within .cv__open {
  opacity: 1;
}
.cv__open:hover {
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .cv__head,
  .cv__scroll,
  .cv__file {
    animation: none;
  }
  .cv__back,
  .cv__btn,
  .cv__icon-copy,
  .cv__icon-tick,
  .cv__row,
  .cv__open {
    transition: none;
  }
}
</style>
