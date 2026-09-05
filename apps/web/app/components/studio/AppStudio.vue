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
import { recordsStanding, resolveLandingProject, resolveRowFocus } from "~/utils/rowFocus";
import { useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import type { Project } from "~/composables/useProject";

const props = defineProps<{
  /** The plane is summoned. Hidden with `visibility`, never unmounted. */
  open: boolean;
  /** The project whose page is showing underneath, if any. It earns a row of its
   *  own even before it has any work on it — see `renderRows`. */
  activeProject: Project | null;
  /** Another portal is over the plane. While set, Escape and plane shortcuts
   *  belong to it, so the plane stays quiet underneath. */
  suspended?: boolean;
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
}>();

const { cue } = useSound();
// The app's known projects, most-recently-opened first — the fallback for which
// row to land in when no project page is open.
const { byRecency } = useRecentProjects();
const { matchesShortcut } = useShortcuts();
const plane = useStudioPlane();
const rowRegistry = useStudioRowRegistry();

const reducedMotion = usePreferredReducedMotion();
function reducedMotionOn(): boolean {
  return reducedMotion.value === "reduce";
}

// ── 2D Studio Overview (Exposé) ───────────────────────────────────────────────
// Pulls the camera back across both axes to show all active project workspace rows
// stacked vertically, with each row displaying its horizontal strip of columns.
const studioOverview = ref(false);
const cameraEl = ref<HTMLElement | null>(null);
let cameraAnim: Animation | null = null;

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

// Which project the studio should land in when it holds no work for one yet.
// The project whose page is open, if there is one — that is where you already
// are. Otherwise the one you touched last, because summoning the studio from the
// launcher should put you back in what you were doing rather than nowhere. Null
// only when the app knows of no projects at all, which is the one case where
// there is no studio to enter.
// The rule lives in utils/rowFocus with the focus rule, where all three of its
// cases are stated once and checked.
const landingProject = computed<Project | null>(() =>
  resolveLandingProject(props.activeProject ?? null, byRecency.value),
);

// The persisted rows, plus — when the landing project has none — one transient
// row for it. Without that, summoning the plane with no work anywhere would land
// on nothing at all, when the whole reason to summon it is to start working. It
// is never persisted empty (a row with no panes is dropped on save), so it
// appears and disappears on its own as the first pane opens and the last one
// closes.
const renderRows = computed<RenderRow[]>(() => {
  const rows: RenderRow[] = plane.rows.value.map((r) => ({
    projectPath: r.projectPath,
    name: r.name,
    transient: false,
  }));
  const landing = landingProject.value;
  if (landing && !rows.some((r) => r.projectPath === landing.path)) {
    rows.push({ projectPath: landing.path, name: landing.name, transient: true });
  }
  return rows;
});

/** Nothing to show and nothing to start: summoning is a no-op rather than a
 *  With no project in the app at all there is nowhere for a row to be and
 *  nothing to start, so summoning stays a no-op rather than a flash of an empty
 *  layer. Note that this is a statement about *projects*, not about work: a
 *  project with no panes still gets a row (see renderRows), so the studio opens
 *  for it. */
const empty = computed(() => renderRows.value.length === 0);

// The axis owns focus among *persisted* rows; the transient row is not one of
// them, so the plane tracks that case itself rather than teaching the axis about
// a row it can neither move nor remember.
const transientFocus = ref<string | null>(null);

// The row the camera was last deliberately landed on. A persisted row that loses
// its last pane stops being persisted, so the axis drops it and falls back to
// whichever project slid into its index — which would send you into someone
// else's work for the crime of tidying up your own. The project you were in
// still has a row on screen at that moment (the transient one `renderRows` adds
// for the open project), so this is what lets the camera find it: standing still
// is the answer, not a handoff.
const standing = ref<string | null>(null);

// The rule itself lives in utils/rowFocus, where it can be exercised without
// driving the whole app — see the note there on why.
const focusedPath = computed<string | null>(() =>
  resolveRowFocus({
    rows: renderRows.value,
    transientFocus: transientFocus.value,
    standing: standing.value,
    axisPath: plane.focusedPath.value,
  }),
);

// Keep `standing` current however focus was reached — travel, a summon that
// resolved it, or a newly-born row taking it — but only ever record a row that
// is still persisted. That last condition is what makes the pin above stable:
// the moment a row goes transient this stops updating, so it still names the row
// the camera was in when its last pane closed.
watch(focusedPath, (path) => {
  if (recordsStanding(renderRows.value, path)) standing.value = path;
});

const cameraIndex = computed(() => {
  const at = renderRows.value.findIndex((r) => r.projectPath === focusedPath.value);
  return at < 0 ? 0 : at;
});

const displayRows = computed<RenderRow[]>(() => {
  if (!studioOverview.value) return renderRows.value;
  const withPanes = plane.rows.value.filter((r) => r.paneCount > 0);
  if (withPanes.length > 0) {
    return withPanes.map((r) => ({
      projectPath: r.projectPath,
      name: r.name,
      transient: false,
    }));
  }
  return renderRows.value;
});

const overviewIndex = computed(() => {
  const at = displayRows.value.findIndex((r) => r.projectPath === focusedPath.value);
  return at < 0 ? 0 : at;
});

const cameraTransform = computed(() => {
  if (!studioOverview.value) {
    return `translateY(${-cameraIndex.value * 100}%)`;
  }
  const count = displayRows.value.length;
  if (count <= 1) {
    return "translateY(0%)";
  }
  if (count === 2) {
    return "translateY(0%)";
  }
  const i = overviewIndex.value;
  return `translateY(calc(29vh - (${i} * (42vh + 24px))))`;
});

function enterStudioOverview(): void {
  if (empty.value) return;
  const el = cameraEl.value;
  const fromTransform = cameraTransform.value;
  studioOverview.value = true;
  if (!el || reducedMotionOn()) return;
  cameraAnim?.cancel();
  cameraAnim = el.animate(
    { transform: [fromTransform, cameraTransform.value] },
    { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

function exitStudioOverview(): void {
  const el = cameraEl.value;
  const fromTransform = cameraTransform.value;
  studioOverview.value = false;
  if (!el || reducedMotionOn()) return;
  cameraAnim?.cancel();
  cameraAnim = el.animate(
    { transform: [fromTransform, cameraTransform.value] },
    { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

function toggleStudioOverview(): void {
  if (empty.value) return;
  cue("toggle");
  if (studioOverview.value) {
    exitStudioOverview();
  } else {
    enterStudioOverview();
  }
}

function onSelectRowPane(projectPath: string, paneId: string): void {
  if (projectPath !== focusedPath.value) {
    focusRow(projectPath);
  }
  rowRegistry.rowFor(projectPath)?.focusPane?.(paneId);
  exitStudioOverview();
}

function focusRow(projectPath: string): boolean {
  const row = renderRows.value.find((r) => r.projectPath === projectPath);
  if (!row) return false;
  standing.value = projectPath;
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

function stepOverviewRow(delta: number): boolean {
  const list = displayRows.value;
  if (list.length <= 1) return false;
  const from = list.findIndex((r) => r.projectPath === focusedPath.value);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return false;
  const next = list[to];
  if (!next) return false;
  focusRow(next.projectPath);
  return true;
}

let wheelAccumulator = 0;
let wheelCooldownUntil = 0;
let wheelResetTimer: ReturnType<typeof setTimeout> | null = null;

function onStudioWheel(e: WheelEvent): void {
  if (!studioOverview.value || displayRows.value.length <= 1) return;

  const dy = e.deltaMode === 1 ? e.deltaY * 36 : e.deltaMode === 2 ? e.deltaY * 360 : e.deltaY;
  const dx = e.deltaMode === 1 ? e.deltaX * 36 : e.deltaX;

  // Only handle if predominantly vertical
  if (Math.abs(dy) <= Math.abs(dx) || Math.abs(dy) < 3) return;

  e.preventDefault();

  const now = Date.now();
  if (now < wheelCooldownUntil) return;

  wheelAccumulator += dy;

  if (wheelResetTimer) clearTimeout(wheelResetTimer);
  wheelResetTimer = setTimeout(() => {
    wheelAccumulator = 0;
    wheelResetTimer = null;
  }, 100);

  const THRESHOLD = 24;
  if (wheelAccumulator >= THRESHOLD) {
    if (stepOverviewRow(1)) cue("select");
    wheelAccumulator = 0;
    wheelCooldownUntil = now + 90;
  } else if (wheelAccumulator <= -THRESHOLD) {
    if (stepOverviewRow(-1)) cue("select");
    wheelAccumulator = 0;
    wheelCooldownUntil = now + 90;
  }
}

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

// ── travel & 2D overview navigation ──────────────────────────────────────────
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!props.open || props.suspended || e.defaultPrevented) return;

  if (matchesShortcut("toggle-overview", e)) {
    e.preventDefault();
    toggleStudioOverview();
    return;
  }

  if (studioOverview.value) {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      exitStudioOverview();
      return;
    }
    if (e.key === "ArrowUp" || matchesShortcut("focus-row-up", e)) {
      e.preventDefault();
      if (stepOverviewRow(-1)) cue("select");
      else cue("error");
      return;
    }
    if (e.key === "ArrowDown" || matchesShortcut("focus-row-down", e)) {
      e.preventDefault();
      if (stepOverviewRow(1)) cue("select");
      else cue("error");
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (focusedPath.value) {
        rowRegistry.rowFor(focusedPath.value)?.shiftPaneFocus?.(-1);
      }
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (focusedPath.value) {
        rowRegistry.rowFor(focusedPath.value)?.shiftPaneFocus?.(1);
      }
      return;
    }
    return;
  }

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

// ── keyboard shortcuts for panes ──────────────────────────────────────────────
function resolveTargetProjectPath(): string | null {
  if (props.open) {
    // In studio: currently showing project row
    return focusedPath.value;
  }
  if (props.activeProject?.path) {
    // In project detail/overview: the project's studio row
    return props.activeProject.path;
  }
  // Anywhere else (e.g. launcher/home): last project row opened in the studio
  return plane.focusedPath.value ?? landingProject.value?.path ?? null;
}

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (props.suspended || e.defaultPrevented) return;

  if (matchesShortcut("new-thread", e)) {
    const targetPath = resolveTargetProjectPath();
    if (!targetPath) return;
    e.preventDefault();
    if (targetPath !== focusedPath.value) {
      focusRow(targetPath);
    }
    rowRegistry.rowFor(targetPath)?.newThread();
    return;
  }

  if (matchesShortcut("new-terminal", e)) {
    const targetPath = resolveTargetProjectPath();
    if (!targetPath) return;
    e.preventDefault();
    if (targetPath !== focusedPath.value) {
      focusRow(targetPath);
    }
    rowRegistry.rowFor(targetPath)?.openTerminal();
    return;
  }

  if (matchesShortcut("new-scratchpad", e)) {
    const targetPath = resolveTargetProjectPath();
    if (!targetPath) return;
    e.preventDefault();
    if (targetPath !== focusedPath.value) {
      focusRow(targetPath);
    }
    rowRegistry.rowFor(targetPath)?.openScratchpad();
    return;
  }

  if (matchesShortcut("send-selection-to-scratchpad", e)) {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || text.length <= 2) return;
    const targetPath = resolveTargetProjectPath();
    if (!targetPath) return;
    e.preventDefault();
    rowRegistry.rowFor(targetPath)?.captureText?.(text);
    return;
  }

  if (matchesShortcut("play-demo", e)) {
    const targetPath = resolveTargetProjectPath();
    if (!targetPath) return;
    e.preventDefault();
    if (targetPath !== focusedPath.value) {
      focusRow(targetPath);
    }
    rowRegistry.rowFor(targetPath)?.playDemo?.();
    return;
  }
});

const refusal = ref(false);
let refusalTimer: ReturnType<typeof setTimeout> | null = null;
function refuse(): void {
  cue("error");
  refusal.value = true;
  if (refusalTimer) clearTimeout(refusalTimer);
  refusalTimer = setTimeout(() => (refusal.value = false), 2600);
}

// Escape closes one layer at a time. Anything inside a row owns it first and
// marks the event handled, so reaching here means the plane itself is the
// frontmost thing — unless it is suspended, in which case the portal over it
// owns Escape and one press must not dismiss both.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!props.open || e.key !== "Escape" || e.defaultPrevented) return;
  if (props.suspended) return;
  if (studioOverview.value) {
    exitStudioOverview();
    return;
  }
  close();
});

function close(): void {
  cue("collapse");
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
  <div
    class="plane portal-fade"
    :class="{
      'portal-fade--hidden': !open || empty,
      // Covered by the inbox: cut instead of fading (see .portal-fade--covered
      // in main.css). The plane only ever opens under cover during a downward
      // portal switch, where a fade would play out unseen and still be
      // mid-flight when the inbox lifts.
      'portal-fade--covered': suspended,
      'is-overview': studioOverview,
      'is-multi-row': studioOverview && displayRows.length > 1,
      'is-two-row': studioOverview && displayRows.length === 2,
    }"
    :inert="!open || empty"
    @wheel="onStudioWheel"
  >
    <div
      ref="cameraEl"
      class="plane__camera"
      :class="{ 'is-normal': !studioOverview }"
      :style="{ transform: cameraTransform }"
    >
      <!-- One slot per row. The slot is the fixed frame and the row scrolls
           inside it, so a row's own chrome can sit still while its columns
           travel past. -->
      <div
        v-for="row in displayRows"
        :key="row.projectPath"
        class="plane__slot"
        :class="{ 'is-focused-row': row.projectPath === focusedPath }"
        @click="studioOverview && row.projectPath !== focusedPath ? focusRow(row.projectPath) : undefined"
      >
        <div v-if="studioOverview" class="plane__row-header">
          <span class="plane__row-name">{{ row.name }}</span>
        </div>

        <StudioRow
          :project="{ path: row.projectPath, name: row.name }"
          :visible="open && (studioOverview || row.projectPath === focusedPath)"
          :blocked="false"
          :branch="row.projectPath === focusedPath ? g.branch.value : null"
          :origin="row.projectPath === focusedPath ? g.origin.value : null"
          :overview="studioOverview"
          @summon="onSummon(row.projectPath)"
          @open-branch="onOpenBranch"
          @open-file="onOpenFile"
          @toggle-overview="toggleStudioOverview"
          @select-pane="(paneId) => onSelectRowPane(row.projectPath, paneId)"
        />
      </div>
    </div>

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
  /* Hide/show timing lives with .portal-fade in assets/css/main.css. */
  --portal-fade-extra: background-color var(--portal-fade-ms, 220ms) ease;
}
.plane.is-overview {
  background: color-mix(in srgb, var(--ink) 3.5%, var(--ground));
}
/* The camera holds every row stacked vertically and moves in whole viewport heights. */
.plane__camera {
  position: absolute;
  inset: 0;
}
.plane__camera.is-normal {
  transition: transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.plane__slot {
  position: relative;
  height: 100%;
  width: 100%;
  /* Load-bearing no-op. A `position: fixed` descendant resolves against its
     nearest transformed ancestor, and the camera above is transformed — so
     without this every fixed dock inside a row (the composer, the Changes/Tasks
     stack, the Subagents corner, the attention beacon, the archive notice)
     anchors to the camera and is dragged off-screen with it the moment the
     camera leaves the first row. Giving each slot its own containing block
     re-anchors that chrome to its own row, which is exactly the viewport
     whenever that row is the one on camera. */
  transform: translate(0);
}

/* Multi-row layout in overview */
.plane.is-overview.is-multi-row .plane__camera {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px 0;
  height: max-content;
  min-height: 100%;
  box-sizing: border-box;
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.plane.is-overview.is-multi-row .plane__slot {
  flex: 0 0 42vh;
  height: 42vh;
  min-height: 280px;
  max-height: 460px;
  box-sizing: border-box;
}

.plane.is-overview.is-two-row .plane__slot {
  flex: 0 0 calc(47vh - 12px);
  height: calc(47vh - 12px);
  min-height: 280px;
  max-height: 480px;
}

.plane__row-header {
  position: absolute;
  top: 8px;
  left: 48px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  user-select: none;
}

.plane__row-name {
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1;
  color: var(--ink-soft);
  transition: color 0.18s ease;
}

.is-focused-row .plane__row-name {
  color: var(--ink);
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
  .plane__camera,
  .plane-refusal-enter-active,
  .plane-refusal-leave-active {
    transition-duration: 0.01s;
    transition-delay: 0s;
  }
}
</style>
