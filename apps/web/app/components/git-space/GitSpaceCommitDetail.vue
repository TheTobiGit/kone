<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowUpRight01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { GitCommitDetail, GitCommitFile, GitFileDiff } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// What one commit actually did.
//
// It opens underneath its row in the history, so the commit you clicked stays
// where it was and the surrounding timeline stays legible. The body comes first
// (that's the author talking), then the files, and any file will unfold its own
// diff in place — three levels of detail, each one a click deeper, none of them
// a new screen.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  hash: string;
}>();

const { cue } = useSound();

const detail = ref<GitCommitDetail | null>(null);
const loading = ref(true);
const openPath = ref<string | null>(null);
const diff = ref<GitFileDiff | null>(null);
const diffLoading = ref(false);
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.hash,
  async (hash) => {
    loading.value = true;
    detail.value = null;
    openPath.value = null;
    diff.value = null;
    const d = await props.space.commitDetail(hash);
    // A newer click may have landed while this was in flight.
    if (props.hash !== hash) return;
    detail.value = d;
    loading.value = false;
  },
  { immediate: true },
);

const isMerge = computed(() => (detail.value?.parents.length ?? 0) > 1);
const webUrl = computed(() => {
  const o = props.space.origin.value;
  if (!o?.slug || !o.host) return null;
  return `https://${o.host}/${o.slug}/commit/${props.hash}`;
});

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
  <div class="cd">
    <p v-if="loading" class="cd__note">Reading commit…</p>
    <p v-else-if="!detail" class="cd__note">This commit couldn't be read.</p>

    <template v-else>
      <p v-if="detail.body" class="cd__body selectable">{{ detail.body }}</p>

      <div class="cd__meta">
        <button
          type="button"
          class="cd__hash"
          :class="{ 'cd__hash--copied': copied }"
          title="Copy full hash"
          @click="copyHash"
        >
          <span class="cd__copyicon" aria-hidden="true">
            <HugeiconsIcon class="cd__icon-copy" :icon="Copy01Icon" :size="11" :stroke-width="2" />
            <HugeiconsIcon class="cd__icon-tick" :icon="Tick02Icon" :size="11" :stroke-width="2" />
          </span>
          {{ detail.commit.short }}
        </button>
        <span v-if="isMerge" class="cd__tag">merge of {{ detail.parents.length }}</span>
        <span class="cd__dim">{{ detail.files.length }} file{{ detail.files.length === 1 ? "" : "s" }}</span>
        <span v-if="detail.added" class="cd__add">+{{ detail.added }}</span>
        <span v-if="detail.removed" class="cd__del">−{{ detail.removed }}</span>
        <a
          v-if="webUrl"
          class="cd__link"
          :href="webUrl"
          @click.prevent="space.openExternal(webUrl!)"
        >
          GitHub
          <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="11" :stroke-width="2" aria-hidden="true" />
        </a>
      </div>

      <div class="cd__files">
        <div v-for="f in detail.files" :key="f.path" class="cd__file">
          <button
            type="button"
            class="cd__filerow"
            :class="{ 'cd__filerow--on': openPath === f.path }"
            @click="toggleFile(f)"
          >
            <FileIcon :path="f.path" :size="14" />
            <span class="cd__path">
              <span class="cd__dir">{{ dirOf(f.path) }}</span>{{ nameOf(f.path) }}
            </span>
            <span v-if="f.from" class="cd__dim">from {{ nameOf(f.from) }}</span>
            <span class="cd__nums">
              <span v-if="f.added" class="cd__add">+{{ f.added }}</span>
              <span v-if="f.removed" class="cd__del">−{{ f.removed }}</span>
            </span>
          </button>

          <GitSpaceInlineDiff
            v-if="openPath === f.path"
            :diff="diff"
            :loading="diffLoading"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cd {
  padding: 2px 0 14px 8px;
  animation: cd-in var(--gs-t-small) var(--gs-ease) backwards;
}
@keyframes cd-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.cd__note {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

.cd__body {
  margin-bottom: 12px;
  white-space: pre-wrap;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-soft);
}

.cd__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.cd__hash,
.cd__link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-inline: -5px;
  padding: 3px 5px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.cd__hash:hover,
.cd__link:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.cd__hash:focus-visible,
.cd__link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The copy → tick swap is a quiet opacity crossfade at micro, never a pop —
   the two glyphs are stacked in a fixed box so the button text never shifts. */
.cd__copyicon {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  width: 11px;
  height: 11px;
}
.cd__icon-copy,
.cd__icon-tick {
  position: absolute;
  inset: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.cd__icon-tick {
  opacity: 0;
}
.cd__hash--copied .cd__icon-copy {
  opacity: 0;
}
.cd__hash--copied .cd__icon-tick {
  opacity: 1;
}
.cd__tag,
.cd__dim {
  color: var(--muted);
}
.cd__add {
  color: var(--diff-add);
}
.cd__del {
  color: var(--diff-del);
}

.cd__files {
  display: flex;
  flex-direction: column;
}
.cd__filerow {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 28px;
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.cd__filerow:hover,
.cd__filerow--on {
  background-color: var(--hover);
}
.cd__filerow:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.cd__path {
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
.cd__dir {
  color: var(--muted);
}
.cd__nums {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .cd {
    animation: none;
  }
  .cd__hash,
  .cd__link,
  .cd__filerow,
  .cd__icon-copy,
  .cd__icon-tick {
    transition: none;
  }
}
</style>
