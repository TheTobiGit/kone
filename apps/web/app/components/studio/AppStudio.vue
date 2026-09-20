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

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  planeDestinations,
  recordsStanding,
  renderPlaneRows,
  resolveLandingProject,
  resolveRowFocus,
  type RenderRow,
  type StandingRow,
} from "~/utils/rowFocus";
import { useEventListener, usePreferredReducedMotion } from "@vueuse/core";
import type { Project } from "~/composables/useProject";
import type { PortalState } from "~/composables/usePortals";
import type { SurfaceId } from "~/utils/surfaceTop";
import type { StudioDestination } from "~/types/studio";
import { ownsKey } from "~/utils/surfaceKeys";

const props = defineProps<{
  /** Where the plane sits in the portal stack. `hidden` is away, `active` is
   *  the frontmost layer, `covered` is open underneath another portal. Hidden
   *  with `visibility`, never unmounted. */
  state: PortalState;
  /** Which viewport surface owns Escape, resolved once in the page. The plane
   *  answers only when named, so one press never dismisses two layers. */
  surfaceTop: SurfaceId;
  /** The project whose page is showing underneath, if any. It earns a row of its
   *  own even before it has any work on it — see `renderRows`. */
  activeProject: Project | null;
}>();

// The frontmost layer answers keys and holds focus; anything else stays quiet
// underneath, and a covered plane keeps its paint (so the cover fades over
// work) while taking no input.
const isActive = computed(() => props.state === "active");
const isCovered = computed(() => props.state === "covered");

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

// The rows on screen: the persisted ones plus, at most, the two transient ones
// the rule in utils/rowFocus describes — where it can be exercised without
// driving the whole app.
const renderRows = computed<RenderRow[]>(() =>
  renderPlaneRows(plane.rows.value, standing.value, landingProject.value),
);

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

// The row the camera was last deliberately landed on. A persisted row that
// loses its last pane stops being persisted, so the axis drops it and falls
// back to whichever project slid into its index — which would send you into
// someone else's work for the crime of tidying up your own. A project travelled
// to by name that has never held work has no row to drop in the first place.
// Both leave the camera somewhere the axis cannot name, and both are answered
// the same way: stand still, in the row `renderPlaneRows` conjures from this.
const standing = ref<StandingRow | null>(null);

// The rule itself lives in utils/rowFocus, where it can be exercised without
// driving the whole app — see the note there on why.
const focusedPath = computed<string | null>(() =>
  resolveRowFocus({
    rows: renderRows.value,
    transientFocus: transientFocus.value,
    standing: standing.value?.path ?? null,
    axisPath: plane.focusedPath.value,
  }),
);

// Keep `standing` current however focus was reached — travel, a summon that
// resolved it, or a newly-born row taking it — but only ever record a row that
// is still persisted. That last condition is what makes the pin above stable:
// the moment a row goes transient this stops updating, so it still names the row
// the camera was in when its last pane closed.
watch(focusedPath, (path) => {
  if (!recordsStanding(renderRows.value, path) || !path) return;
  const at = renderRows.value.findIndex((r) => r.projectPath === path);
  standing.value = {
    path,
    name: renderRows.value[at]?.name ?? "",
    index: at < 0 ? 0 : at,
  };
});

// Publish the camera's row, so surfaces that open over the plane (the intent
// menu) know which project a gesture here is about. The row the camera stands
// on is the only one those surfaces can mean — every other row is off-screen.
watch(
  () => renderRows.value.find((r) => r.projectPath === focusedPath.value) ?? null,
  (row) =>
    rowRegistry.publishFocusedRow(
      row ? { projectPath: row.projectPath, name: row.name } : null,
    ),
  { immediate: true },
);
onBeforeUnmount(() => rowRegistry.publishFocusedRow(null));

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
  const rows = renderRows.value;
  const at = rows.findIndex((r) => r.projectPath === projectPath);
  const row = rows[at];
  // One pin, two ways to need it — the same two `renderPlaneRows` conjures a
  // transient row from. A row on screen is pinned in the slot it already holds.
  // A project with no row has never had anything opened in it, and travel still
  // has to land somewhere: landing in an empty row is how work in a project
  // starts, so the pin conjures one at the foot of the plane and moving on
  // takes it away again, since the pin is what was holding it. A path the app
  // has never heard of is a caller's mistake, not an empty row.
  let pin: StandingRow | null = null;
  if (row) {
    pin = { path: projectPath, name: row.name, index: at };
  } else {
    const known = byRecency.value.find((p) => p.path === projectPath);
    if (known) pin = { path: known.path, name: known.name, index: rows.length };
  }
  if (!pin) return false;
  standing.value = pin;
  // A transient row is not on the axis, so there is nothing there to focus and
  // the camera is held here instead.
  if (!row || row.transient) {
    transientFocus.value = projectPath;
    return true;
  }
  transientFocus.value = null;
  return plane.focusRow(projectPath);
}

// Everywhere the camera can travel, for the strip's project drop-down. The
// shaping lives in utils/rowFocus beside the row rule it has to agree with —
// the order this lists is the order travelling down the axis would visit, and
// the foot of the plane is where `focusRow` lands a project with no row.
const destinations = computed<StudioDestination[]>(() =>
  planeDestinations(renderRows.value, plane.rows.value, byRecency.value),
);

/** A project was picked by name from a row's drop-down. Same landing as a step
 *  down the axis, so it sounds the same — and says so when the camera can't go. */
function onSwitchRow(projectPath: string): void {
  if (projectPath === focusedPath.value) return;
  if (focusRow(projectPath)) cue("select");
  else cue("error");
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


// ── keyboard shortcuts for panes ──────────────────────────────────────────────
/** Which project row a new column belongs to, given the surface the key came
 *  from. Takes the surface rather than re-deriving it: the caller has already
 *  established which of the two it is, and reading a visibility flag back here
 *  to re-answer the same question is how the two drift apart.
 *
 *  Only the two surfaces the plane owns can answer. On the stage that means a
 *  project page — the plane with one row pulled to the front. The launcher is
 *  also the stage and has no project open, and there the honest answer is none:
 *  falling back to the last row touched would put a thread in a project the
 *  user did not choose, from a surface that never asked for the key. */
function resolveTargetProjectPath(surface: SurfaceId): string | null {
  if (surface === "studio") return focusedPath.value;
  return props.activeProject?.path ?? null;
}

const refusal = ref(false);
let refusalTimer: ReturnType<typeof setTimeout> | null = null;
function refuse(): void {
  cue("error");
  refusal.value = true;
  if (refusalTimer) clearTimeout(refusalTimer);
  refusalTimer = setTimeout(() => (refusal.value = false), 2600);
}

// Every window-level key the plane answers, in one listener with one ownership
// test per family. Three listeners raced here before, each with its own idea of
// what "the plane is in front" meant, and the loosest of them answered ⌘N from
// surfaces the studio does not own.
//
// The two families differ in scope, which is why they stay separate blocks
// rather than collapsing further:
//
//   Travel, overview and Escape need the plane to be the portal in front. A
//   modal over the plane owns these, and one Escape closes one layer.
//
//   A new column — thread, terminal, scratchpad — also answers on the bare
//   stage. A project page is the plane with one row pulled to the front, so a
//   new column there belongs to that project and no other surface is asking for
//   the key.
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (ownsKey(props.surfaceTop, "studio", e)) {
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

    // Escape closes one layer at a time. Anything inside a row owns it first
    // and marks the event handled, so reaching here means the plane itself is
    // the frontmost thing. The overview is not tested again — the travel block
    // above already answers Escape while it is open.
    if (e.key === "Escape") {
      close();
      return;
    }
  }

  if (ownsKey(props.surfaceTop, ["studio", "stage"], e)) {
    if (matchesShortcut("new-thread", e)) {
      const targetPath = resolveTargetProjectPath(props.surfaceTop);
      if (!targetPath) return;
      e.preventDefault();
      if (targetPath !== focusedPath.value) {
        focusRow(targetPath);
      }
      rowRegistry.rowFor(targetPath)?.newThread();
      return;
    }

    if (matchesShortcut("new-terminal", e)) {
      const targetPath = resolveTargetProjectPath(props.surfaceTop);
      if (!targetPath) return;
      e.preventDefault();
      if (targetPath !== focusedPath.value) {
        focusRow(targetPath);
      }
      rowRegistry.rowFor(targetPath)?.openTerminal();
      return;
    }

    if (matchesShortcut("new-scratchpad", e)) {
      const targetPath = resolveTargetProjectPath(props.surfaceTop);
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
      const targetPath = resolveTargetProjectPath(props.surfaceTop);
      if (!targetPath) return;
      e.preventDefault();
      rowRegistry.rowFor(targetPath)?.captureText?.(text);
      return;
    }

    if (matchesShortcut("play-demo", e)) {
      const targetPath = resolveTargetProjectPath(props.surfaceTop);
      if (!targetPath) return;
      e.preventDefault();
      if (targetPath !== focusedPath.value) {
        focusRow(targetPath);
      }
      rowRegistry.rowFor(targetPath)?.playDemo?.();
      return;
    }
  }
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
// from any other it is also a step of the camera. Only a hidden plane needs
// summoning: a covered one is already open underneath and stays there.
function onSummon(projectPath: string): void {
  if (projectPath !== focusedPath.value) focusRow(projectPath);
  if (props.state === "hidden") emit("summon");
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
      'portal-fade--hidden': state === 'hidden' || empty,
      // Covered by the inbox: cut instead of fading (see .portal-fade--covered
      // in main.css). The plane only ever opens under cover during a downward
      // portal switch, where a fade would play out unseen and still be
      // mid-flight when the inbox lifts.
      'portal-fade--covered': isCovered,
      'is-overview': studioOverview,
      'is-multi-row': studioOverview && displayRows.length > 1,
      'is-two-row': studioOverview && displayRows.length === 2,
    }"
    :inert="!isActive || empty"
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
          :visible="isActive && (studioOverview || row.projectPath === focusedPath)"
          :blocked="isCovered"
          :branch="row.projectPath === focusedPath ? g.branch.value : null"
          :origin="row.projectPath === focusedPath ? g.origin.value : null"
          :overview="studioOverview"
          :destinations="destinations"
          @summon="onSummon(row.projectPath)"
          @switch-row="onSwitchRow"
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
