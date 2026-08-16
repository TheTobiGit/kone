<script setup lang="ts">
import { computed, reactive, ref, watch, nextTick } from "vue";
import { useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import FileIcon from "~/components/FileIcon.vue";
import HoldToConfirm from "~/components/HoldToConfirm.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import type { ChangeItem } from "~/types/change";

// The right-hand "peek" drawer that the +N bundle opens — the mirror of the
// settings panel. The project stage slides left (see ProjectView) to uncover
// this fixed strip pinned to the right edge; it lists *every* changed file so a
// working tree too big for the two-row card grid stays fully scannable without
// growing the page.
//
// The list is a shallow tree: staging groups (Staged / Changed) hold collapsible
// folder sections, and each row carries a proportional add/remove magnitude bar
// beside its diffstat so the shape of the change reads at a glance. A shared
// leading path segment is lifted off every folder into the masthead so the rows
// stay short. Pure presentation: the stage owns the slide, this renders the tree
// and hands actions (sweep / discard / open) back up. Picking a file hands its
// row rect up so the detail can grow out of it, and the stage slides back.

const props = withDefaults(
  defineProps<{
    open: boolean;
    changes: ChangeItem[];
  }>(),
  { open: false, changes: () => [] },
);

const emit = defineEmits<{
  close: [];
  openFile: [item: ChangeItem, rect: DOMRect];
  stageAll: [];
  unstageAll: [];
  discard: [];
}>();

const staged = computed(() => props.changes.filter((c) => c.staged));
const unstaged = computed(() => props.changes.filter((c) => !c.staged));
const added = computed(() => props.changes.reduce((a, c) => a + c.added, 0));
const removed = computed(() => props.changes.reduce((a, c) => a + c.removed, 0));

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// The deepest folder every changed file shares — lifted into the masthead so the
// per-folder labels below drop the part that would just repeat on every row. Held
// back to "" when the tree is a single folder (there'd be nothing left to name).
const commonPrefix = computed(() => {
  const dirs = props.changes.map((c) => dirOf(c.path)).filter(Boolean);
  if (dirs.length < 2 || new Set(dirs).size < 2) return "";
  const parts = dirs.map((d) => d.split("/"));
  const [first, ...rest] = parts;
  if (!first) return "";
  let n = 0;
  for (; n < first.length; n++) {
    const seg = first[n];
    if (!rest.every((p) => p[n] === seg)) break;
  }
  return first.slice(0, n).join("/");
});

interface FolderGroup {
  /** Full repo-relative dir — the collapse key and stable id. */
  dir: string;
  /** Dir with the masthead's shared prefix stripped; "·" for the shared root. */
  label: string;
  items: ChangeItem[];
}

interface StageGroup {
  key: "staged" | "changed";
  label: string;
  count: number;
  folders: FolderGroup[];
  /** The sweep verb — staged sweeps back out, changed stages in. */
  sweep: "stage" | "unstage" | null;
  /** Discard only ever touches the unstaged group. */
  discard?: boolean;
}

// Fold each staging group's files into folder sections, preserving file order
// within a folder and sorting the folders shallow-to-deep, then alphabetically.
function foldFolders(items: ChangeItem[]): FolderGroup[] {
  const by = new Map<string, ChangeItem[]>();
  for (const c of items) {
    const dir = dirOf(c.path);
    (by.get(dir) ?? by.set(dir, []).get(dir)!).push(c);
  }
  const prefix = commonPrefix.value;
  return [...by.entries()]
    .map(([dir, folderItems]) => {
      let label = dir;
      if (prefix && (dir === prefix || dir.startsWith(prefix + "/")))
        label = dir.slice(prefix.length).replace(/^\//, "");
      return { dir, label: label || "·", items: folderItems };
    })
    .sort((a, b) => {
      const da = a.dir.split("/").length - (a.dir ? 0 : 1);
      const db = b.dir.split("/").length - (b.dir ? 0 : 1);
      return da - db || a.dir.localeCompare(b.dir);
    });
}

const groups = computed<StageGroup[]>(() => {
  const out: StageGroup[] = [];
  if (staged.value.length)
    out.push({
      key: "staged",
      label: "Staged",
      count: staged.value.length,
      folders: foldFolders(staged.value),
      sweep: "unstage",
    });
  if (unstaged.value.length)
    out.push({
      key: "changed",
      label: "Changed",
      count: unstaged.value.length,
      folders: foldFolders(unstaged.value),
      sweep: "stage",
      discard: true,
    });
  return out;
});

// When the working tree is all one staging state (the common case — everything
// unstaged), the group's own "CHANGED 21" header just echoes the masthead's
// "Changes 21". So its label is dropped and its bulk actions ride in the
// masthead instead; per-group headers only return once staged + changed coexist.
const soleGroup = computed<StageGroup | null>(() =>
  groups.value.length === 1 ? groups.value[0]! : null,
);

// Collapsed folders, keyed by `${stage}::${dir}`. In-memory and default-open —
// the fold is a scan convenience for this viewing, not a persisted git fact.
const collapsed = reactive(new Set<string>());
function folderKey(stage: string, dir: string): string {
  return `${stage}::${dir}`;
}
function toggleFolder(stage: string, dir: string): void {
  const k = folderKey(stage, dir);
  if (collapsed.has(k)) collapsed.delete(k);
  else collapsed.add(k);
}

// Add/remove split for a row's magnitude bar — proportion of the file's churn
// that is additions. A pure-new file with no counted lines still reads as green.
function addRatio(c: ChangeItem): number {
  const total = c.added + c.removed;
  if (total > 0) return c.added / total;
  return c.isNew ? 1 : 0;
}

// Clicking a row hands up the row's viewport rect as the detail's grow origin —
// the same contract the change cards use.
function onRowClick(item: ChangeItem, e: MouseEvent | KeyboardEvent) {
  const el = e.currentTarget as HTMLElement;
  emit("openFile", item, el.getBoundingClientRect());
}

// No visible scrollbar — the list smokes its top/bottom edges exactly like the
// settings panes (same useEdgeFade), so it reads as one quiet surface with the
// settings drawer rather than growing a bar the settings side doesn't have. A
// fold toggle changes the scroll height, so re-measure after the DOM settles.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);
watch([() => props.changes, collapsed], () => void nextTick(measure), { deep: true });

// Esc closes the peek; ProjectView's own Esc handler walks the stack after this
// (detail → peek → switcher), so this is the peek's own share of it.
useEventListener(window, "keydown", (e) => {
  if (!props.open || e.key !== "Escape") return;
  e.preventDefault();
  emit("close");
});
</script>

<template>
  <aside
    class="peek"
    :class="{ 'peek--open': open }"
    role="dialog"
    aria-label="All changed files"
    :aria-hidden="!open"
  >
    <!-- Masthead: what the working tree holds, in one glance — count + diffstat,
         and the folder every change shares (lifted off the rows below). The close
         glyph mirrors the settings panel's corner return. When the tree is all one
         staging state its bulk actions ride here too, so the list drops straight
         into folders with no repeated "CHANGED 21" header underneath. -->
    <header class="peek__head">
      <div class="peek__title-row">
        <div class="peek__title">
          <h2 class="peek__name">Changes</h2>
          <span class="peek__count">{{ changes.length }}</span>
        </div>
        <span class="peek__diff">
          <span v-if="added > 0" class="peek__add">+{{ added }}</span>
          <span v-if="removed > 0" class="peek__del">−{{ removed }}</span>
        </span>
        <button
          type="button"
          class="peek__close"
          aria-label="Close changed files"
          @click="emit('close')"
        >
          <HugeiconsIcon :icon="Cancel01Icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </div>
      <div v-if="commonPrefix || soleGroup" class="peek__meta">
        <span v-if="commonPrefix" class="peek__root selectable" :title="commonPrefix">
          {{ commonPrefix }}<span class="peek__root-slash">/</span>
        </span>
        <div v-if="soleGroup" class="peek__meta-actions">
          <button
            v-if="soleGroup.sweep"
            type="button"
            class="peek__sweep"
            @click="soleGroup.sweep === 'stage' ? emit('stageAll') : emit('unstageAll')"
          >
            {{ soleGroup.sweep === "stage" ? "Stage all" : "Unstage all" }}
          </button>
          <HoldToConfirm
            v-if="soleGroup.discard"
            variant="lane-discard"
            title="Hold to discard all changed (unstaged) files"
            aria-label="Hold to discard all changed files"
            @confirm="emit('discard')"
          >
            Discard
          </HoldToConfirm>
        </div>
      </div>
    </header>

    <!-- The tree — one scroll region: staging groups over collapsible folder
         sections over dense rows (icon, path, magnitude bar, ± diffstat).
         Smokes its edges (no bar) to match the settings drawer. -->
    <div
      ref="scroller"
      class="peek__scroll"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <section v-for="group in groups" :key="group.key" class="peek__group">
        <div v-if="!soleGroup" class="peek__group-head">
          <span class="peek__label">{{ group.label }}</span>
          <span class="peek__group-count">{{ group.count }}</span>
          <button
            v-if="group.sweep"
            type="button"
            class="peek__sweep"
            @click="group.sweep === 'stage' ? emit('stageAll') : emit('unstageAll')"
          >
            {{ group.sweep === "stage" ? "Stage all" : "Unstage all" }}
          </button>
          <HoldToConfirm
            v-if="group.discard"
            variant="lane-discard"
            title="Hold to discard all changed (unstaged) files"
            aria-label="Hold to discard all changed files"
            @confirm="emit('discard')"
          >
            Discard
          </HoldToConfirm>
        </div>

        <div class="peek__folders">
          <div
            v-for="folder in group.folders"
            :key="folder.dir"
            class="peek__folder"
          >
            <button
              type="button"
              class="peek__folder-head"
              :aria-expanded="!collapsed.has(folderKey(group.key, folder.dir))"
              @click="toggleFolder(group.key, folder.dir)"
            >
              <HugeiconsIcon
                class="peek__folder-chev"
                :class="{ 'peek__folder-chev--open': !collapsed.has(folderKey(group.key, folder.dir)) }"
                :icon="ArrowRight01Icon"
                :size="11"
                :stroke-width="1.9"
                aria-hidden="true"
              />
              <span class="peek__folder-path selectable" :title="folder.dir || folder.label">{{ folder.label }}</span>
              <span class="peek__folder-count">{{ folder.items.length }}</span>
            </button>

            <div
              class="peek__folder-body"
              :class="{ 'peek__folder-body--open': !collapsed.has(folderKey(group.key, folder.dir)) }"
            >
              <ul class="peek__list">
                <li
                  v-for="(c, i) in folder.items"
                  :key="c.path"
                  class="peek__row"
                  :class="{ 'peek__row--in': open }"
                  :style="{ '--i': i }"
                  role="button"
                  tabindex="0"
                  @click="onRowClick(c, $event)"
                  @keydown.enter.prevent="onRowClick(c, $event)"
                  @keydown.space.prevent="onRowClick(c, $event)"
                >
                  <FileIcon :path="c.path" :size="15" />
                  <span
                    class="peek__path selectable"
                    :class="{ 'peek__path--del': c.deleted }"
                    :title="c.path"
                  >{{ c.name }}</span>
                  <span
                    class="peek__bar"
                    :class="{ 'peek__bar--new': c.isNew && c.added === 0 && c.removed === 0 }"
                    aria-hidden="true"
                  >
                    <i class="peek__bar-add" :style="{ flex: addRatio(c) }" />
                    <i class="peek__bar-del" :style="{ flex: 1 - addRatio(c) }" />
                  </span>
                  <span class="peek__stat">
                    <span v-if="c.added > 0" class="peek__add">+{{ c.added }}</span>
                    <span v-if="c.removed > 0" class="peek__del">−{{ c.removed }}</span>
                    <span v-if="c.isNew && c.added === 0" class="peek__new">new</span>
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.peek {
  position: fixed;
  inset: 0 0 0 auto; /* pinned to the right edge, full height */
  width: 420px;
  z-index: 21; /* below the stage (z-30) */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Square and flush to the screen edge — the curve of this reveal lives on the
     sliding page (its edge facing the drawer), mirroring how the settings page
     carries the curve on the edge facing its drawer. */
  background-color: var(--sunken);
}

/* ── masthead ───────────────────────────────────────────────────────────── */
.peek__head {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* Top matches the settings drawer's pt-5 so the two mirrored surfaces start
     their content at the same line. The stage's 18px corner sits on this panel's
     left edge (slide = 420 − 18), so the left pad is the visible gutter plus
     that overlap — otherwise the right wall looks twice as wide. */
  padding: 20px 24px 14px 42px;
}
.peek__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* Shared prefix on the left, the sole group's bulk actions on the right — the
   row that lets the list start straight into folders. */
.peek__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 22px;
}
.peek__meta-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-inline-start: auto;
  /* The trailing action carries its own 6px inner padding, so its label ends
     short of the wall — overhang the cluster by that much so "Discard" aligns to
     the right edge "apps/" hangs on at the left. */
  margin-inline-end: -6px;
}
.peek__title {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
}
.peek__name {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
  text-wrap: balance;
  text-box: trim-both cap alphabetic;
  color: var(--ink);
  white-space: nowrap;
}
.peek__count {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.1;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.peek__diff {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-inline-start: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* The folder every change shares, named once here so the rows below don't. */
.peek__root {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.25;
  color: var(--muted);
}
.peek__root-slash {
  color: color-mix(in srgb, var(--faint) 55%, transparent);
}
.peek__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  /* The 15px glyph sits centred in a 24px box, so it lands ~5px short of the
     content wall — pull the box out by that much so the × optically aligns to
     the same right edge "Changes" hangs on at the left. */
  margin-inline-end: -5px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
}
.peek__close:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.peek__close:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
/* The masthead rises in with the drawer — a beat ahead of the rows. */
@keyframes peek-head-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.peek--open .peek__head {
  animation: peek-head-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* ── scroll region ──────────────────────────────────────────────────────── */
.peek__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 24px 28px 42px;
  /* No visible bar — the edge-fade mask (bound from useEdgeFade) smokes the
     top/bottom exactly like the settings panes, so the two mirrored surfaces
     scroll identically. */
  scrollbar-width: none;
}
.peek__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* ── staging groups ─────────────────────────────────────────────────────── */
.peek__group {
  display: flex;
  flex-direction: column;
  /* Label-to-content gap matches the settings groups' gap-1.5. */
  gap: 6px;
}
.peek__group + .peek__group {
  margin-top: 22px;
}
.peek__group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  padding-inline: 4px;
}
.peek__label {
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1.1;
  color: var(--muted);
  white-space: nowrap;
}
.peek__group-count {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.1;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.peek__sweep {
  margin-inline-start: auto;
  padding: 3px 6px;
  border-radius: 7px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.1;
  text-box: trim-both cap alphabetic;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.16s ease;
}
.peek__sweep:hover {
  color: var(--ink);
}
.peek__sweep:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

/* ── folder sections ────────────────────────────────────────────────────── */
.peek__folders {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.peek__folder-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border-radius: 7px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: start;
  transition: background-color 0.14s ease;
}
.peek__folder-head:hover {
  background-color: var(--hover);
}
.peek__folder-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent);
}
.peek__folder-chev {
  flex-shrink: 0;
  color: var(--faint);
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.peek__folder-chev--open {
  transform: rotate(90deg);
}
.peek__folder-path {
  /* Shrink-to-fit, never grow — so the count tucks right up against the folder
     name rather than being flung to the far wall across an empty gulf. */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.25;
  color: var(--muted);
}
.peek__folder-head:hover .peek__folder-path {
  color: var(--ink-soft);
}
.peek__folder-count {
  flex-shrink: 0;
  /* A hair off the name so it reads as its tally, not a column entry. */
  margin-inline-start: 1px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.25;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* Fold body — the row list clips to nothing on collapse, same grid-rows tween
   the lanes use, so folders open and close without a layout jump. */
.peek__folder-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.peek__folder-body--open {
  grid-template-rows: 1fr;
}
.peek__folder-body > .peek__list {
  overflow: hidden;
  min-height: 0;
}

/* ── rows ───────────────────────────────────────────────────────────────── */
.peek__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  padding-inline-start: 14px; /* indent under the folder chevron */
  list-style: none;
}
.peek__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 7px 8px;
  border-radius: 10px; /* the settings nav-row radius */
  cursor: pointer;
  outline: none;
  opacity: 0;
  transition:
    background-color 0.14s ease,
    opacity 0.2s ease;
}
.peek__row:hover,
.peek__row:focus-visible {
  background-color: var(--hover);
}
.peek__row:focus-visible {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent);
}
/* Rows cascade in when the drawer opens — same cadence as the change lanes.
   `both` holds the final opacity so the rows stay visible once the entrance
   (and its delay) finish. */
@keyframes peek-row-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.peek__row--in {
  animation: peek-row-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: calc(min(var(--i, 0) * 20ms, 300ms));
}
.peek__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.25;
  color: var(--ink-soft);
  transition: color 0.14s ease;
}
.peek__row:hover .peek__path {
  color: var(--ink);
}
.peek__path--del {
  text-decoration-line: line-through;
  text-decoration-thickness: from-font;
  text-decoration-skip-ink: auto;
  color: var(--muted);
}
/* Magnitude bar — the add/remove split of the file's churn, so the shape of a
   change reads before the numbers do. Sits on a faint track and fades to full
   presence on row hover. */
.peek__bar {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  width: 34px;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
  opacity: 0.72;
  transition: opacity 0.14s ease;
}
.peek__row:hover .peek__bar {
  opacity: 1;
}
.peek__bar-add { background-color: var(--diff-add); }
.peek__bar-del { background-color: var(--diff-del); }
/* A brand-new empty file has no churn to split — show a quiet full track. */
.peek__bar--new {
  background-color: color-mix(in srgb, var(--diff-add) 40%, transparent);
}
.peek__bar--new .peek__bar-add,
.peek__bar--new .peek__bar-del { background: transparent; }
.peek__stat {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-shrink: 0;
  min-width: 46px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.peek__add { color: var(--diff-add); }
.peek__del { color: var(--diff-del); }
.peek__new {
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  line-height: 1.1;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .peek__row {
    opacity: 1;
    animation: none;
  }
  .peek__folder-body,
  .peek__folder-chev {
    transition: none;
  }
}
</style>
