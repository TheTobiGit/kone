<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  FoldVerticalIcon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { Project } from "~/composables/useProject";
import type { useProjectGit } from "~/composables/useProjectGit";
import type { GitFileStatus } from "~/types/desktop";

// The project's third tab: its files, read-only. A lazy tree down the left
// (one folder listed at a time, see useProjectTree), a quick filter that swaps
// the tree for a flat list of matches, and the open files as tabs over a
// highlighted viewer. The working tree's git status tints the rows, and when
// that status moves — the agent wrote something — the tree and the open file
// quietly re-read, so what's on screen is what's on disk.

const props = defineProps<{
  project: Project;
  git: ReturnType<typeof useProjectGit>;
  /** This tab is the one on screen. Re-reads wait until it is. */
  visible: boolean;
}>();

const emit = defineEmits<{ viewing: [path: string | null] }>();

const { cue } = useSound();
const root = computed(() => props.project.path);
const tree = useProjectTree(root);

onMounted(() => void tree.load(""));

// ── git tint ──────────────────────────────────────────────────────────────────
const statusByPath = computed(() => {
  const map = new Map<string, GitFileStatus>();
  for (const c of props.git.changes.value) map.set(c.path, c.status);
  return map;
});
/** Folders holding a change somewhere below them, so a closed folder still
 *  says there is something inside. */
const dirtyDirs = computed(() => {
  const set = new Set<string>();
  for (const path of statusByPath.value.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return set;
});
function tintOf(path: string): "new" | "edit" | "conflict" | null {
  const s = statusByPath.value.get(path);
  if (!s) return null;
  if (s === "added" || s === "untracked") return "new";
  if (s === "conflicted") return "conflict";
  if (s === "deleted") return null;
  return "edit";
}

// ── open files ────────────────────────────────────────────────────────────────
const MAX_TABS = 10;
const tabs = ref<string[]>([]);
const active = ref<string | null>(null);
const version = ref(0);

watch(active, (p) => emit("viewing", p), { immediate: true });

function openFile(path: string): void {
  if (active.value === path) return;
  cue("select");
  if (!tabs.value.includes(path)) {
    const next = [...tabs.value, path];
    // Past the cap, the oldest tab that isn't the one being shown goes.
    while (next.length > MAX_TABS) next.splice(next.findIndex((t) => t !== path), 1);
    tabs.value = next;
  }
  active.value = path;
}

function closeTab(path: string): void {
  const i = tabs.value.indexOf(path);
  if (i === -1) return;
  cue("collapse");
  const next = tabs.value.filter((t) => t !== path);
  tabs.value = next;
  if (active.value === path) active.value = next[Math.min(i, next.length - 1)] ?? null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ── tree interaction ──────────────────────────────────────────────────────────
function onRow(entry: { path: string; kind: "dir" | "file" }): void {
  if (entry.kind === "dir") {
    cue(tree.isOpen(entry.path) ? "collapse" : "expand");
    tree.toggle(entry.path);
  } else {
    openFile(entry.path);
  }
}

// ── filter ────────────────────────────────────────────────────────────────────
const query = ref("");
const searching = computed(() => query.value.trim().length > 0);
const { entries: matches, pending: matchesPending } = useProjectFiles(root, query, searching);
const filterInput = ref<HTMLInputElement | null>(null);

function pickMatch(path: string): void {
  openFile(path);
  tree.reveal(path);
}
function clearQuery(): void {
  query.value = "";
  filterInput.value?.focus();
}

// ── staying current ───────────────────────────────────────────────────────────
// Git status moves on every working-tree change. Coalesce a burst (an agent
// writing ten files) into one re-read, and hold it while the tab is hidden —
// nobody is looking, so it runs once when they come back.
const REFRESH_DEBOUNCE_MS = 400;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let stale = false;

function refreshNow(): void {
  stale = false;
  void tree.refresh();
  version.value += 1;
}
function scheduleRefresh(): void {
  if (!props.visible) {
    stale = true;
    return;
  }
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshNow, REFRESH_DEBOUNCE_MS);
}
watch(() => props.git.changes.value, scheduleRefresh);
watch(
  () => props.visible,
  (v) => {
    if (v && stale) refreshNow();
  },
);
onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
});

function onRefreshClick(): void {
  cue("press");
  refreshNow();
}
function onCollapseClick(): void {
  cue("collapse");
  tree.collapseAll();
}
</script>

<template>
  <div class="fs">
    <!-- ── sidebar ─────────────────────────────────────────────────────── -->
    <aside class="fs__side" aria-label="Project files">
      <div class="fs__head">
        <p class="fs__title">{{ project.name }}</p>
        <div class="fs__tools">
          <button
            type="button"
            class="fs__tool"
            title="Collapse folders"
            aria-label="Collapse folders"
            @click="onCollapseClick"
          >
            <HugeiconsIcon :icon="FoldVerticalIcon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="fs__tool"
            :class="{ 'is-busy': tree.busy.value }"
            title="Refresh"
            aria-label="Refresh"
            @click="onRefreshClick"
          >
            <HugeiconsIcon :icon="RefreshIcon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </div>
      </div>

      <label class="fs__filter">
        <HugeiconsIcon :icon="Search01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <input
          ref="filterInput"
          v-model="query"
          type="text"
          placeholder="Find a file"
          spellcheck="false"
          autocomplete="off"
          aria-label="Find a file"
          @keydown.esc.stop="query = ''"
          @keydown.enter="matches[0] && pickMatch(matches[0].path)"
        />
        <button
          v-if="searching"
          type="button"
          class="fs__clear"
          aria-label="Clear"
          @click="clearQuery"
        >
          <HugeiconsIcon :icon="Cancel01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </label>

      <div class="fs__list">
        <!-- Search: a flat list of matches, name first, folder after. -->
        <template v-if="searching">
          <button
            v-for="m in matches"
            :key="m.path"
            type="button"
            class="fs__row"
            :class="{ 'is-active': active === m.path, [`tint-${tintOf(m.path)}`]: tintOf(m.path) }"
            :title="m.path"
            @click="pickMatch(m.path)"
          >
            <FileIcon :path="m.name" :size="15" />
            <span class="fs__name">{{ m.name }}</span>
            <span class="fs__parent">{{ m.parent }}</span>
          </button>
          <p v-if="!matchesPending && matches.length === 0" class="fs__empty">No files match.</p>
        </template>

        <!-- Tree -->
        <template v-else>
          <p v-if="tree.rootError.value" class="fs__empty">{{ tree.rootError.value }}</p>
          <p v-else-if="!tree.rootLoaded.value" class="fs__empty">Reading files…</p>
          <p v-else-if="tree.rows.value.length === 0" class="fs__empty">This folder is empty.</p>
          <template v-for="row in tree.rows.value" :key="row.kind === 'entry' ? row.entry.path : `${row.kind}:${row.dir}`">
            <button
              v-if="row.kind === 'entry'"
              type="button"
              class="fs__row"
              :class="{
                'is-active': active === row.entry.path,
                'is-dir': row.entry.kind === 'dir',
                [`tint-${tintOf(row.entry.path)}`]: tintOf(row.entry.path),
              }"
              :style="{ '--depth': row.depth }"
              :title="row.entry.path"
              :aria-expanded="row.entry.kind === 'dir' ? row.open : undefined"
              @click="onRow(row.entry)"
            >
              <HugeiconsIcon
                v-if="row.entry.kind === 'dir'"
                class="fs__chev"
                :icon="row.open ? ArrowDown01Icon : ArrowRight01Icon"
                :size="12"
                :stroke-width="2"
                aria-hidden="true"
              />
              <FileIcon v-else :path="row.entry.name" :size="15" />
              <span class="fs__name">{{ row.entry.name }}</span>
              <i
                v-if="row.entry.kind === 'dir' && dirtyDirs.has(row.entry.path)"
                class="fs__dot"
                aria-label="Has changes"
              />
            </button>
            <p v-else-if="row.kind === 'loading'" class="fs__note" :style="{ '--depth': row.depth }">
              Reading…
            </p>
            <p v-else-if="row.kind === 'error'" class="fs__note" :style="{ '--depth': row.depth }">
              {{ row.message }}
            </p>
            <p v-else class="fs__note" :style="{ '--depth': row.depth }">
              Too many files to list — use Find.
            </p>
          </template>
        </template>
      </div>
    </aside>

    <!-- ── viewer ──────────────────────────────────────────────────────── -->
    <section class="fs__main">
      <div v-if="tabs.length" class="fs__tabs" role="tablist" aria-label="Open files">
        <div
          v-for="t in tabs"
          :key="t"
          class="fs__tab"
          :class="{ 'is-on': active === t }"
          :title="t"
          @auxclick.middle="closeTab(t)"
        >
          <button
            type="button"
            role="tab"
            class="fs__tab-open"
            :aria-selected="active === t"
            @click="openFile(t)"
          >
            <FileIcon :path="t" :size="14" />
            <span>{{ basename(t) }}</span>
          </button>
          <button
            type="button"
            class="fs__tab-close"
            :aria-label="`Close ${basename(t)}`"
            @click="closeTab(t)"
          >
            <HugeiconsIcon :icon="Cancel01Icon" :size="11" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <FilesViewer v-if="active" :root="root" :path="active" :version="version" />
      <div v-else class="fs__blank">
        <p class="fs__blank-title">Pick a file to read it</p>
        <p class="fs__blank-hint">Read-only · changes from git are tinted in the tree</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.fs {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  /* Clear the fixed chrome row (3.25rem) the back arrow and nav ride. */
  padding: 4.25rem 1.25rem 1.25rem;
  gap: 8px;
  animation: fs-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
@keyframes fs-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

/* ── sidebar ──────────────────────────────────────────────────────────────── */
.fs__side {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 272px;
  min-height: 0;
  padding-right: 8px;
  border-right: 1px solid var(--line);
}
.fs__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 6px 10px 10px;
}
.fs__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.fs__tools {
  display: flex;
  gap: 2px;
}
.fs__tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.fs__tool:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.fs__tool.is-busy :deep(svg) {
  animation: fs-spin 0.8s linear infinite;
}
@keyframes fs-spin {
  to {
    transform: rotate(360deg);
  }
}

.fs__filter {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 4px 8px;
  padding: 6px 9px;
  border-radius: 9px;
  background-color: color-mix(in srgb, var(--ink) 4.5%, transparent);
  color: var(--muted);
}
.fs__filter:focus-within {
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
.fs__filter input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font-size: 12.5px;
  color: var(--ink);
}
.fs__filter input::placeholder {
  color: var(--muted);
}
.fs__clear {
  display: inline-flex;
  color: var(--muted);
  cursor: pointer;
}
.fs__clear:hover {
  color: var(--ink);
}

.fs__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 4px 24px;
  scrollbar-width: thin;
  scrollbar-color: var(--hover) transparent;
}
.fs__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 8px 0 calc(8px + var(--depth, 0) * 14px);
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.fs__row:hover {
  background-color: var(--hover);
}
.fs__row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 22%, transparent);
  outline-offset: -2px;
}
.fs__row.is-active {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
}
/* A folder's chevron sits in the same 15px slot a file's icon does, so names
   line up down the column. */
.fs__chev {
  flex: none;
  width: 15px;
  color: var(--muted);
}
.fs__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fs__parent {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--muted);
  text-align: right;
  direction: rtl;
}
.tint-new .fs__name {
  color: var(--diff-add);
}
.tint-edit .fs__name {
  color: var(--accent);
}
.tint-conflict .fs__name {
  color: var(--diff-del);
}
.fs__dot {
  flex: none;
  width: 5px;
  height: 5px;
  margin-left: auto;
  border-radius: 999px;
  background-color: var(--accent);
  opacity: 0.8;
}
.fs__note,
.fs__empty {
  padding: 5px 8px 5px calc(29px + var(--depth, 0) * 14px);
  font-size: 12px;
  color: var(--muted);
}
.fs__empty {
  padding: 16px 10px;
}

/* ── viewer ───────────────────────────────────────────────────────────────── */
.fs__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.fs__tabs {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  padding: 0 12px 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.fs__tabs::-webkit-scrollbar {
  display: none;
}
.fs__tab {
  display: flex;
  align-items: center;
  flex: none;
  max-width: 220px;
  border-radius: 8px;
  color: var(--muted);
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.fs__tab:hover {
  color: var(--ink-soft);
}
.fs__tab.is-on {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
}
.fs__tab-open {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 4px 6px 10px;
  font-size: 12.5px;
  cursor: pointer;
}
.fs__tab-open span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fs__tab-close {
  display: inline-flex;
  padding: 4px;
  margin-right: 5px;
  border-radius: 5px;
  color: var(--muted);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s ease;
}
.fs__tab:hover .fs__tab-close,
.fs__tab.is-on .fs__tab-close,
.fs__tab-close:focus-visible {
  opacity: 1;
}
.fs__tab-close:hover {
  color: var(--ink);
  background-color: var(--hover);
}

.fs__blank {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
}
.fs__blank-title {
  font-size: 14px;
  color: var(--ink-soft);
}
.fs__blank-hint {
  font-size: 12px;
  color: var(--muted);
}

@media (max-width: 860px) {
  .fs__side {
    width: 220px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .fs {
    animation: none;
  }
  .fs__tool.is-busy :deep(svg) {
    animation: none;
  }
}
</style>
