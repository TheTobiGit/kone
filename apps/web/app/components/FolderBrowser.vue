<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { motion } from "motion-v";
import { Magnet } from "~/components/ui/magnet";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowUp01Icon,
  ArrowTurnBackwardIcon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";

// The folder browser proper — header address bar, the FLIP-choreographed listing,
// and the confirm footer — with NO shell of its own. Two hosts wrap it:
//
//   • FolderPickerModal — the standalone open-a-project overlay (scrim + card).
//   • GitHubCloneModal   — as a swappable view INSIDE the clone card, so choosing
//     a destination morphs in place (same card, same scrim) instead of swapping
//     to a second modal. `embedded` picks that mode: the host owns the card,
//     the height, the scrim, and the Escape/focus-trap keyboard; here we only
//     render the body and report `select` / `cancel`.
//
// All navigation, git enrichment, and the focus-stack FLIP live in
// `useFolderPicker`, shared with both hosts.

const props = withDefaults(
  defineProps<{
    confirmVerb?: string;
    cancelLabel?: string;
    embedded?: boolean;
  }>(),
  { confirmVerb: "Open", cancelLabel: "Cancel", embedded: false },
);

const emit = defineEmits<{
  select: [folder: { path: string; name: string }];
  cancel: [];
  // Fired once the first listing has settled — the standalone shell waits for
  // this to size + reveal its card. The clone host measures on its own, so it
  // just ignores it.
  ready: [];
}>();

const {
  current,
  currentGit,
  rows,
  childIndent,
  rowIndent,
  scrollEl,
  maskImage,
  measure,
  settle,
  enter,
  itemHidden,
  itemShown,
  metaHidden,
  metaShown,
  metaEnter,
  navigating,
  TRANSITION_MS,
  canAscend,
  parentName,
  ascend,
  descend,
  climbTo,
  goToPath,
  childDirs,
  homePath,
  init,
  entries,
  error,
  readError,
} = useFolderPicker();

// Root of the browser body — the focus-trap boundary in standalone mode.
const rootEl = ref<HTMLElement | null>(null);

// ── header address bar ──────────────────────────────────────────────────────
// The header shows the focused folder's path as an editable field, with the
// home directory shown as `~`. It tracks `current` while the user browses;
// typing autocompletes the folder name against the parent's children, Enter
// jumps to the path, and a failed jump (or Escape) restores it.
const pathInput = ref<HTMLInputElement | null>(null);
const pathDraft = ref("");

// `~/…` for display; expanded back to absolute for filesystem calls. (goToPath
// re-expands on its own, but autocomplete needs the absolute parent too.)
function collapse(path: string): string {
  const home = homePath.value;
  if (!home) return path;
  if (path === home) return "~/"; // home itself always keeps the trailing slash
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
function expand(display: string): string {
  const home = homePath.value;
  if (!home) return display;
  if (display === "~") return home;
  if (display.startsWith("~/")) return home + display.slice(1);
  return display;
}

watch(current, (folder) => (pathDraft.value = collapse(folder?.path ?? "")), {
  immediate: true,
});

// Autocomplete: on each keystroke (not deletions, caret at end), find the first
// child of the parent directory that the trailing segment prefixes, append the
// remainder, and select it — so continued typing overwrites it and Tab / → / /
// accept it.
async function onType(event: Event) {
  const el = event.target as HTMLInputElement;
  const value = el.value;
  pathDraft.value = value;
  const inputType = (event as InputEvent).inputType ?? "";
  if (inputType.startsWith("delete")) return;
  if (el.selectionStart !== value.length) return;

  const frag = value.slice(value.lastIndexOf("/") + 1);
  if (!frag) return;
  const expanded = expand(value);
  const cut = expanded.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : expanded.slice(0, cut);
  const names = await childDirs(parent);
  if (el.value !== value) return; // field moved on while we listed
  const match = names.find(
    (n) =>
      n.length > frag.length && n.toLowerCase().startsWith(frag.toLowerCase()),
  );
  if (!match) return;

  // frag + match share display/absolute form (only the home prefix differs),
  // so we can splice the completion straight onto the displayed value.
  const completed = value + match.slice(frag.length);
  el.value = completed;
  pathDraft.value = completed;
  el.setSelectionRange(value.length, completed.length);
}

// Tab / → accept the selected completion; `/` accepts it then descends.
function onFieldKeydown(event: KeyboardEvent) {
  const el = pathInput.value;
  if (!el || el.selectionStart === el.selectionEnd) return;
  if (event.key === "Tab" || event.key === "ArrowRight") {
    event.preventDefault();
  } else if (event.key !== "/") {
    return;
  }
  const end = el.value.length;
  el.setSelectionRange(end, end); // collapse selection to the end (accept)
  pathDraft.value = el.value;
}

// Flips true briefly to drive the address bar's shake + error tint (see
// `.picker-path-input.is-error` below), then clears itself.
const pathError = ref(false);
let pathErrorTimer: number | null = null;
function triggerPathError() {
  if (pathErrorTimer) window.clearTimeout(pathErrorTimer);
  pathError.value = false;
  // Re-trigger the animation even if it's already mid-shake from a previous
  // attempt: drop the class a frame before reapplying it.
  requestAnimationFrame(() => {
    pathError.value = true;
    pathErrorTimer = window.setTimeout(() => {
      pathError.value = false;
    }, 600);
  });
}

async function submitPath() {
  const result = await goToPath(pathDraft.value);
  if (result === "ok") {
    pathInput.value?.blur();
  } else if (result === "invalid") {
    pathDraft.value = collapse(current.value?.path ?? ""); // bad path — restore
    triggerPathError();
  }
  // "busy" (a navigation was already in flight): leave the field exactly as
  // the user left it — don't restore it, don't blur it out from under them.
}

function resetPath() {
  pathDraft.value = collapse(current.value?.path ?? "");
  pathInput.value?.blur();
}

// ── terminal actions ─────────────────────────────────────────────────────────
// One report per lifetime: the first select/cancel wins. The exit animation and
// unmount belong to the host (the standalone shell fades its card; the clone
// card morphs this view out), so here we only report intent.
const done = ref(false);

function openFolder(folder: { path: string; name: string } | null) {
  if (done.value || !folder) return;
  done.value = true;
  emit("select", { path: folder.path, name: folder.name });
}

function open() {
  openFolder(current.value);
}

function cancel() {
  if (done.value) return;
  done.value = true;
  emit("cancel");
}

// ── single-click-descend vs. double-click-open ──────────────────────────────
// A single click on an entry descends into it (see `descend`), a double-click
// opens it directly. We descend on the first click at once (no stall) and
// detect the double-click after the fact.
//
// Descending reflows the list: the clicked folder keeps its `:key`, so it's the
// same DOM node — it just turns from an entry into the newest (current) crumb.
// A double-click's second click therefore lands on that same node, but which
// handler it hits depends on whether the descend's listing has re-rendered yet:
//   • not yet  → still an entry → `onEntryClick` with `event.detail >= 2`
//   • already  → now a crumb    → `onCrumbClick`, recognised by `recentDescend`
// Either way we open the folder instead of descending/climbing again.
const DOUBLE_CLICK_MS = 260;
let recentDescend: { path: string; at: number } | null = null;

function onEntryClick(row: Row, event: MouseEvent) {
  if (event.detail >= 2 && recentDescend?.path === row.path) {
    // Double-click whose second click beat the descend's re-render: open it.
    recentDescend = null;
    openFolder({ path: row.path, name: row.name });
    return;
  }
  recentDescend = { path: row.path, at: Date.now() };
  descend(row);
}

function onCrumbClick(row: Extract<Row, { kind: "crumb" }>) {
  // Double-click on the folder we just descended into (now the current crumb):
  // open it directly rather than climbing back out.
  if (
    row.current &&
    recentDescend?.path === row.path &&
    Date.now() - recentDescend.at < DOUBLE_CLICK_MS
  ) {
    recentDescend = null;
    openFolder({ path: row.path, name: row.name });
    return;
  }
  climbTo(row.index);
}

// ── keyboard (standalone only) ───────────────────────────────────────────────
// When embedded, the host card owns Escape (→ back to the clone form) and the
// focus trap, so we don't touch the window — element-level handlers on the
// address bar (type / Enter / Esc) and the rows still work.
function focusableEls(): HTMLElement[] {
  const root = rootEl.value;
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function onKeydown(event: KeyboardEvent) {
  // Type-to-focus: a printable key while the address bar is unfocused jumps
  // into it, seeded with the current path plus a trailing slash.
  const field = pathInput.value;
  if (
    field &&
    document.activeElement !== field &&
    event.key.length === 1 &&
    event.key !== " " &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    field.focus();
    const base = collapse(current.value?.path ?? "");
    const seed = base.endsWith("/") ? base : base + "/";
    field.value = seed;
    pathDraft.value = seed;
    field.setSelectionRange(seed.length, seed.length);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }

  if (event.key === "Enter") {
    if (document.activeElement instanceof HTMLButtonElement) return;
    event.preventDefault();
    open();
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const rowEls = Array.from(
      scrollEl.value?.querySelectorAll<HTMLButtonElement>(".picker-row") ?? [],
    );
    if (rowEls.length === 0) return;
    const idx = rowEls.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    if (event.key === "ArrowDown") {
      rowEls[idx === -1 ? 0 : Math.min(idx + 1, rowEls.length - 1)]?.focus();
    } else if (idx <= 0) {
      field?.focus();
    } else {
      rowEls[idx - 1]?.focus();
    }
    return;
  }

  if (event.key === "Tab") {
    const els = focusableEls();
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    const inTrap = active != null && els.includes(active);
    const atEdge = event.shiftKey ? active === first : active === last;
    if (atEdge || !inTrap) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
}

// Expose the address bar so a host can move focus into the browser when it
// morphs into view (the clone card does this on "Choose…").
function focusPath() {
  pathInput.value?.focus();
}
defineExpose({ focusPath });

onMounted(async () => {
  if (!props.embedded) window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", measure);
  try {
    await init();
  } finally {
    await settle();
    emit("ready");
    requestAnimationFrame(() => {
      pathInput.value?.focus();
    });
    window.setTimeout(() => {
      navigating.value = false;
      measure();
    }, TRANSITION_MS);
  }
});

onBeforeUnmount(() => {
  if (!props.embedded) window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", measure);
});
</script>

<template>
  <!-- Vertical + left padding only, both hosts, so the scroll area (and its
       scrollbar) runs to the card's right edge. Standalone insets 4; embedded
       insets 5 to match the clone card's px-5 form. `shrink-0` keeps the block
       at its natural height inside the host's bottom-anchored flex column. -->
  <div
    ref="rootEl"
    class="folder-browser flex shrink-0 flex-col"
    :class="embedded ? 'py-4 pl-5' : 'py-4 pl-4'"
  >
    <!-- Header: the focused folder's full path as an editable address bar, in a
         curved band that mirrors the footer. Type a path + Enter to jump. -->
    <div
      class="picker-header -mt-4 mb-4 flex items-center gap-4"
      :class="embedded ? '-ml-5' : '-ml-4'"
    >
      <input
        ref="pathInput"
        :value="pathDraft"
        class="picker-path-input"
        :class="{ 'is-error': pathError }"
        type="text"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        aria-label="Directory path — edit and press Enter to go there"
        @input="onType"
        @keydown="onFieldKeydown"
        @keydown.enter.stop.prevent="submitPath"
        @keydown.esc.stop.prevent="resetPath"
      />
      <button
        type="button"
        class="picker-action shrink-0 text-muted"
        @click="cancel"
      >
        {{ cancelLabel }}
      </button>
    </div>

    <!-- Breadcrumbs + focused level as one keyed list. Persisting rows keep
         their :key (no re-animate, stay crisp) and ride the FLIP; incoming
         rows fade in; outgoing rows simply drop from the list. -->
    <div
      ref="scrollEl"
      class="picker-scroll relative flex max-h-[48vh] w-full flex-col items-start overflow-x-hidden py-1"
      :class="navigating ? 'overflow-y-hidden' : 'overflow-y-auto'"
      :style="{ maskImage, WebkitMaskImage: maskImage }"
      @scroll="measure"
    >
      <template v-if="error">
        <p class="picker-label px-3 py-2.5 text-muted">{{ error }}</p>
      </template>

      <template v-else>
        <button
          v-if="canAscend"
          type="button"
          class="picker-row group text-muted"
          style="margin-left: 0"
          :aria-label="`Go up to ${parentName}`"
          @click="ascend"
        >
          <span class="picker-travel">
            <span
              class="pointer-events-none inline-flex w-5 shrink-0 items-center opacity-55 transition-opacity group-hover:opacity-100"
            >
              <HugeiconsIcon
                :icon="ArrowUp01Icon"
                :size="16"
                :stroke-width="2"
                aria-hidden="true"
              />
            </span>
            <span class="picker-label" :title="parentName">{{ parentName }}</span>
          </span>
        </button>

        <Magnet
          v-for="row in rows"
          :key="row.path"
          class="w-fit"
          inner-class="w-fit"
          :padding="12"
          :magnet-strength="9"
          :disabled="navigating"
          active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
          inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          :style="{ marginLeft: `${rowIndent(row)}px` }"
        >
          <motion.button
            :data-path="row.path"
            type="button"
            class="picker-row group"
            :class="
              row.kind === 'crumb'
                ? row.current
                  ? 'text-ink-soft'
                  : 'text-muted'
                : 'text-ink'
            "
            :initial="itemHidden"
            :animate="itemShown"
            :transition="enter"
            @click="
              row.kind === 'crumb'
                ? onCrumbClick(row)
                : onEntryClick(row, $event)
            "
          >
            <span class="picker-travel">
              <span
                v-if="row.kind === 'crumb'"
                class="pointer-events-none inline-flex w-5 shrink-0 items-center opacity-55 transition-opacity group-hover:opacity-100"
              >
                <HugeiconsIcon
                  :icon="ArrowTurnBackwardIcon"
                  :size="16"
                  :stroke-width="2"
                  aria-hidden="true"
                />
              </span>
              <span
                v-else
                class="pointer-events-none inline-flex w-5 shrink-0 items-center opacity-45 transition-opacity group-hover:opacity-80"
              >
                <HugeiconsIcon
                  :icon="Folder01Icon"
                  :size="16"
                  :stroke-width="1.5"
                  aria-hidden="true"
                />
              </span>
              <span class="picker-label" :title="row.name">{{ row.name }}</span>
              <span v-if="row.repo" class="picker-git">
                <span
                  class="picker-repo"
                  :class="{ 'is-loading': !row.git }"
                  title="Git repository"
                >
                  <HugeiconsIcon
                    :icon="GitBranchIcon"
                    :size="13"
                    :stroke-width="2"
                    aria-hidden="true"
                  />
                  <span class="sr-only">Git repository</span>
                </span>
                <motion.span
                  v-if="row.git"
                  class="picker-meta"
                  :initial="metaHidden"
                  :animate="metaShown"
                  :transition="metaEnter"
                >
                  <span class="picker-branch">{{
                    row.git.branch ?? "detached"
                  }}</span>
                  <span
                    v-if="row.git.added || row.git.removed"
                    class="picker-diff"
                  >
                    <span class="picker-add">+{{ row.git.added }}</span>
                    <span class="picker-del">−{{ row.git.removed }}</span>
                  </span>
                </motion.span>
              </span>
            </span>
          </motion.button>
        </Magnet>

        <p
          v-if="entries.length === 0"
          class="picker-label px-3 py-2.5 text-muted"
          :style="{ marginLeft: `${childIndent + 20}px` }"
        >
          {{ readError ? "Can’t read this folder" : "No subfolders" }}
        </p>
      </template>
    </div>

    <!-- Footer: open/confirm the folder currently in focus. Breaks out of the
         content padding to sit as a full-bleed band clipped to the card's
         rounded bottom corners. -->
    <div
      class="picker-footer -mb-4 mt-4 flex items-center justify-end gap-6"
      :class="embedded ? '-ml-5' : '-ml-4'"
    >
      <button
        type="button"
        class="picker-action min-w-0 text-ink"
        :disabled="!current"
        @click="open"
      >
        <span class="picker-open-label"
          >{{ confirmVerb }}
          <span class="text-ink-soft">“{{ current?.name }}”</span></span
        >
        <span v-if="current?.repo" class="picker-git picker-git-inline">
          <span
            class="picker-repo"
            :class="{ 'is-loading': !currentGit }"
            title="Git repository"
          >
            <HugeiconsIcon
              :icon="GitBranchIcon"
              :size="13"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span class="sr-only">Git repository</span>
          </span>
          <motion.span
            v-if="currentGit"
            class="picker-meta"
            :initial="metaHidden"
            :animate="metaShown"
            :transition="metaEnter"
          >
            <span class="picker-branch">{{
              currentGit.branch ?? "detached"
            }}</span>
          </motion.span>
        </span>
        <span class="picker-submit-arrow" aria-hidden="true">→</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The band vars are self-contained here so the browser looks right in any host
   card (the standalone shell or the clone card). */
.folder-browser {
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
  --band-arc: 14px;
}

.picker-row {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  width: fit-content;
  max-width: 100%;
  cursor: pointer;
  border-radius: 10px;
  padding: 0.5rem 0.75rem;
  text-align: left;
  transition:
    background-color 0.18s ease,
    color 0.25s ease;
}
.picker-row:hover {
  background-color: var(--hover);
}
.picker-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.picker-travel {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  max-width: 100%;
  will-change: transform;
}
.picker-label {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.1;
}

/* Git metadata: a branch glyph, the branch name, and a line diffstat. The whole
   group is `flex: none` so it stays put while a long folder name truncates. */
.picker-git {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  flex: none;
  margin-left: 0.5rem;
  min-width: 0;
}

.picker-repo {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--accent);
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
.group:hover .picker-repo {
  opacity: 1;
}
.picker-repo.is-loading {
  animation: repoPulse 1.5s ease-in-out infinite;
}

.picker-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  will-change: transform, opacity, filter;
}

.picker-branch {
  min-width: 0;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
}

.picker-diff {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.picker-add {
  color: #5f9e6a;
}
.picker-del {
  color: #c2745c;
}
@media (prefers-color-scheme: dark) {
  .picker-add {
    color: #7fb98a;
  }
  .picker-del {
    color: #dc8a6f;
  }
}

@keyframes repoPulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.8;
  }
}

.picker-git-inline {
  flex: 0 1 auto;
  min-width: 0;
}
.picker-git-inline .picker-repo {
  opacity: 0.85;
}
.picker-action:hover .picker-git-inline .picker-repo {
  opacity: 1;
}

/* Top + bottom bands — full-bleed recessed surfaces set off from the list, each
   with a flat inner edge that arcs into the side walls at both ends. The header
   scoops DOWN; the footer scoops UP. */
.picker-header,
.picker-footer {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}

.picker-header::before,
.picker-header::after,
.picker-footer::before,
.picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}

.picker-footer::before,
.picker-footer::after {
  bottom: 100%;
}
.picker-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-header::before,
.picker-header::after {
  top: 100%;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* Full path of the current selection as an editable address bar — quiet mono
   at rest, firming to full ink while focused. Borderless. */
.picker-path-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  outline: none;
  transition: color 0.18s ease;
}
.picker-path-input:hover {
  color: var(--ink-soft);
}
.picker-path-input:focus {
  color: var(--ink);
  text-overflow: clip;
}
.picker-path-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

.picker-path-input.is-error {
  animation: pathShake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97);
  color: #c2745c;
}
@media (prefers-color-scheme: dark) {
  .picker-path-input.is-error {
    color: #dc8a6f;
  }
}
@keyframes pathShake {
  0%,
  100% {
    transform: translateX(0);
  }
  20%,
  60% {
    transform: translateX(-4px);
  }
  40%,
  80% {
    transform: translateX(4px);
  }
}

.picker-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-open-label {
  flex: none;
}
.picker-action:hover {
  opacity: 0.7;
}
.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}
/* Forward cue on the confirm action — the accent arrow eases right on hover,
   matching the clone submit button. */
.picker-submit-arrow {
  flex: none;
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.picker-action:not(:disabled):hover .picker-submit-arrow {
  transform: translateX(3px);
}

/* Subtle, self-effacing scrollbar that firms up on hover. The stable gutter
   reserves its width whether or not it's showing, so the list never shifts. */
.picker-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 10px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.picker-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>
