<script setup lang="ts">
// AppStudio — the plane every project's work happens on.
//
// A row is a project and a column within it is a pane, so travelling sideways
// moves through one project's work and travelling down moves to another
// project's. The plane is summoned over whatever page is showing and dismissed
// back to it; the page is never unmounted, which is what makes the gesture cheap
// enough to be reflexive.
//
// It is mounted once, unkeyed, for the life of the app. That is the whole point:
// the project pages under it are keyed on their path and unmount on a switch,
// while the rows up here keep their turns folding and their PTYs running. A row
// only pays for itself when it is looked at — a hidden row's panes stay dormant
// and attach on reveal.
//
// Travel is discrete, like a tiling window manager's workspaces: one row fills
// the viewport and the camera moves in whole rows. Nothing wraps — the plane
// grows with the number of projects you have work in, and a camera that jumped
// from the last row back to the first would lose you your place in a way a hard
// end never does.

import { computed, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import type { Project } from "~/composables/useProject";
import type { PlaneRow } from "~/composables/useStudioPlane";

const props = defineProps<{
  /** The plane is summoned. Hidden with `visibility`, never unmounted. */
  open: boolean;
  /** The project whose page is showing underneath, if any. It earns a row of its
   *  own even before it has any work on it — see `renderRows`. */
  activeProject: Project | null;
}>();

const emit = defineEmits<{
  /** A row asked to be brought forward while the plane was away — its first
   *  turn, a new thread, a terminal. Opening the plane is the page's call. */
  summon: [];
  close: [];
  /** Both of these belong to the page under the plane, so asking for one
   *  dismisses the plane on the way — an opaque layer can't have a page's modal
   *  or detail view show through it. */
  openFile: [path: string, rect: DOMRect | null];
  openBranch: [];
  /** Leaving the plane on a different project's row than the one whose page is
   *  underneath: the page follows. Only ever on exit — rows move freely while
   *  the plane is open. */
  exitTo: [project: Project];
}>();

const { cue } = useSound();
const { matchesShortcut } = useShortcuts();
const plane = useStudioPlane();
const rowRegistry = useStudioRowRegistry();

// The plane reads the document. Each row loads its own row, but a row only
// exists because the document said so — so with nothing rendered yet there was
// nobody to do the first read, and a cold start could never populate. The read
// is idempotent and cached for the run, so doing it here costs one call.
const store = useStudioPersistence(() => props.activeProject?.path ?? "");
onMounted(() => void store.loadPlane());

/** A row as the plane renders it. `transient` marks the one that exists only
 *  because a project is open with no work on it yet. */
interface RenderRow {
  projectPath: string;
  name: string;
  transient: boolean;
}

// The persisted rows, plus — when the open project has none — one transient row
// for it. Without that, summoning the plane from a fresh project would land on
// someone else's work or on nothing at all, when the whole reason to summon it
// is to start working here. It is never persisted empty (a row with no panes is
// dropped on save), so it appears and disappears on its own as the first pane
// opens and the last one closes.
const renderRows = computed<RenderRow[]>(() => {
  const rows: RenderRow[] = plane.rows.value.map((r) => ({
    projectPath: r.projectPath,
    name: r.name,
    transient: false,
  }));
  const active = props.activeProject;
  if (active && !rows.some((r) => r.projectPath === active.path)) {
    rows.push({ projectPath: active.path, name: active.name, transient: true });
  }
  return rows;
});

/** Nothing to show and nothing to start: summoning is a no-op rather than a
 *  flash of an empty layer. */
const empty = computed(() => renderRows.value.length === 0);

// The axis owns focus among *persisted* rows; the transient row is not one of
// them, so the plane tracks that case itself rather than teaching the axis about
// a row it can neither move nor remember.
const transientFocus = ref<string | null>(null);

const focusedPath = computed<string | null>(() => {
  const pinned = transientFocus.value;
  if (pinned && renderRows.value.some((r) => r.projectPath === pinned && r.transient)) {
    return pinned;
  }
  const fromAxis = plane.focusedPath.value;
  if (fromAxis && renderRows.value.some((r) => r.projectPath === fromAxis)) return fromAxis;
  // No persisted row is focused (an empty plane, or the focused row just died):
  // fall to the last row, which is where a newly-born or transient one sits.
  return renderRows.value[renderRows.value.length - 1]?.projectPath ?? null;
});

const cameraIndex = computed(() => {
  const at = renderRows.value.findIndex((r) => r.projectPath === focusedPath.value);
  return at < 0 ? 0 : at;
});

function focusRow(projectPath: string): boolean {
  const row = renderRows.value.find((r) => r.projectPath === projectPath);
  if (!row) return false;
  if (row.transient) {
    transientFocus.value = projectPath;
    return true;
  }
  transientFocus.value = null;
  return plane.focusRow(projectPath);
}

function stepRow(delta: number): boolean {
  const list = renderRows.value;
  const from = list.findIndex((r) => r.projectPath === focusedPath.value);
  if (from < 0) return false;
  const to = from + delta;
  if (to < 0 || to >= list.length) return false; // the plane has ends
  const next = list[to];
  return next ? focusRow(next.projectPath) : false;
}

function onRailFocus(projectPath: string): void {
  if (projectPath === focusedPath.value) return;
  cue("select");
  focusRow(projectPath);
}

// The rail wants the axis's own view of a row; the transient one has no persisted
// counterpart, so it is described here.
const railRows = computed<PlaneRow[]>(() =>
  renderRows.value.map((r) => {
    const persisted = plane.rows.value.find((p) => p.projectPath === r.projectPath);
    return (
      persisted ?? { projectPath: r.projectPath, name: r.name, paneCount: 0, focusedId: null }
    );
  }),
);

// ── the focused row's repository ─────────────────────────────────────────────
// One watcher for the whole plane, following focus. A watcher per row would put
// a git subprocess and an fs watch behind every project you have ever worked in,
// for chrome you cannot see; the row you are looking at is the only one whose
// branch is on screen.
const focusedProject = computed<Project>(() => {
  const row = renderRows.value.find((r) => r.projectPath === focusedPath.value);
  if (row) return { path: row.projectPath, name: row.name };
  // Nothing focused — keep the watcher pointed at the open project rather than
  // at an empty path, so it never issues a read against nowhere.
  return props.activeProject ?? { path: "", name: "" };
});
const g = useProjectGit(focusedProject);

// ── travel ───────────────────────────────────────────────────────────────────
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!props.open) return;

  if (matchesShortcut("focus-row-up", e)) {
    e.preventDefault();
    if (stepRow(-1)) cue("select");
    else cue("error"); // the top of the plane; say so rather than swallow it
    return;
  }
  if (matchesShortcut("focus-row-down", e)) {
    e.preventDefault();
    if (stepRow(1)) cue("select");
    else cue("error");
    return;
  }

  // Carrying a column to another row is the one gesture this plane refuses, and
  // it is caught literally rather than registered as a shortcut: a shortcut list
  // must not advertise something that never happens, but the horizontal
  // move-thread pair trains exactly this reach one axis over, so it earns a
  // stated refusal instead of silence.
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    refuse();
    return;
  }
});

// Arriving on the plane from a project page puts you on that project's row —
// summoning is "show me my work here", not "show me wherever I last was". While
// the plane stays open the camera is yours to move.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const active = props.activeProject?.path;
    if (active && active !== focusedPath.value) focusRow(active);
  },
);

const refusal = ref(false);
let refusalTimer: ReturnType<typeof setTimeout> | null = null;
function refuse(): void {
  cue("error");
  refusal.value = true;
  if (refusalTimer) clearTimeout(refusalTimer);
  refusalTimer = setTimeout(() => (refusal.value = false), 2600);
}

// ── leaving ──────────────────────────────────────────────────────────────────
// Escape closes the plane, but only when nothing inside a row owns it: a row's
// approval sheet, its model picker and the strip's own overlays all answer
// Escape first. They stop the event at their own handlers, so reaching here at
// all means the plane itself is the frontmost thing.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!props.open || e.key !== "Escape" || e.defaultPrevented) return;
  close();
});

function close(): void {
  cue("collapse");
  // The page follows the row you were last standing in — decided on exit only,
  // so travelling the axis never yanks the page around underneath.
  //
  // Only when a project page was already showing, though. Summoned from the
  // launcher there is no page to follow the plane, and opening whichever row the
  // camera happened to rest on would mean you could never look at the plane and
  // come back to where you were.
  const active = props.activeProject;
  const row = renderRows.value.find((r) => r.projectPath === focusedPath.value);
  if (active && row && row.projectPath !== active.path) {
    emit("exitTo", { path: row.projectPath, name: row.name });
  }
  emit("close");
}

/** A row asked for something the page owns. Step off the plane first, or it
 *  would open behind an opaque layer. */
function onOpenFile(path: string, rect: DOMRect | null): void {
  emit("close");
  emit("openFile", path, rect);
}
function onOpenBranch(): void {
  emit("close");
  emit("openBranch");
}

// A row asks to be brought forward — its first turn, a new thread, a terminal.
// From a row that is already the focused one this is just "summon the plane";
// from any other it is also a step of the camera.
function onSummon(projectPath: string): void {
  if (projectPath !== focusedPath.value) focusRow(projectPath);
  if (!props.open) emit("summon");
}

defineExpose({
  /** Bring a project's row forward and open the plane on it — the path a pill
   *  click takes from the page underneath. */
  reveal(projectPath: string): void {
    focusRow(projectPath);
  },
  flushAll: rowRegistry.flushAll,
});
</script>

<template>
  <!-- Opaque and full-bleed inside the stage, so it is clipped by the stage and
       rides the settings-drawer slide for free. Hidden with `visibility` rather
       than `v-if`: every layout box below has to stay measurable while the plane
       is away, or a terminal's fit() and the strip's width maths read zero. -->
  <div class="plane" :class="{ 'plane--hidden': !open || empty }" :inert="!open || empty">
    <div class="plane__camera" :style="{ transform: `translateY(${-cameraIndex * 100}%)` }">
      <!-- One slot per row. The slot is the fixed frame and the row scrolls
           inside it, so a row's own chrome can sit still while its columns
           travel past. -->
      <div v-for="row in renderRows" :key="row.projectPath" class="plane__slot">
        <StudioRow
          :project="{ path: row.projectPath, name: row.name }"
          :visible="open && row.projectPath === focusedPath"
          :blocked="false"
          :branch="row.projectPath === focusedPath ? g.branch.value : null"
          :origin="row.projectPath === focusedPath ? g.origin.value : null"
          @summon="onSummon(row.projectPath)"
          @open-branch="onOpenBranch"
          @open-file="onOpenFile"
        />
      </div>
    </div>

    <StudioRowRail :rows="railRows" :focused-path="focusedPath" @focus="onRailFocus" />

    <Transition name="plane-refusal">
      <p v-if="refusal" class="plane__refusal" role="status">
        A column can’t cross the vertical axis — a row is a project, and a thread
        is bound to its repo.
      </p>
    </Transition>
  </div>
</template>

<style scoped>
.plane {
  position: absolute;
  inset: 0;
  z-index: 40;
  overflow: hidden;
  background: var(--ground);
  transition: opacity 0.22s ease;
}
.plane--hidden {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}

/* The camera holds every row stacked vertically and moves in whole viewport
   heights. Its own box is one row tall; each slot below is the full height of
   it, so translating by -100% lands exactly on the next row. */
.plane__camera {
  position: absolute;
  inset: 0;
  transition: transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}

.plane__slot {
  position: relative;
  height: 100%;
  width: 100%;
}

/* Centred near the foot of the plane, where the eye already is after a failed
   gesture — and clear of the rail in the opposite corner. */
.plane__refusal {
  position: absolute;
  left: 50%;
  bottom: 2.125rem;
  z-index: 6;
  max-width: 30rem;
  transform: translateX(-50%);
  text-align: center;
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--muted);
  pointer-events: none;
}

.plane-refusal-enter-active,
.plane-refusal-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.plane-refusal-enter-from,
.plane-refusal-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(0.375rem);
}

@media (prefers-reduced-motion: reduce) {
  .plane,
  .plane__camera,
  .plane-refusal-enter-active,
  .plane-refusal-leave-active {
    transition-duration: 0.01s;
  }
}
</style>
