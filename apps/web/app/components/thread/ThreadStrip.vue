<script setup lang="ts">
// The thread strip — a project's live conversations as columns on one
// infinitely-wide, horizontally scrollable rail. Modelled on niri (the
// scrollable-tiling Wayland compositor): columns tile from the left edge once
// there's more than one, each has a fixed pixel width preset, the strip extends
// rightward as you open threads. A lone thread is centred in the panel; opening
// a second pushes it left and tiles out niri-style.
//
// Navigation, all of it niri's vocabulary:
//   · ⌘⌥← / ⌘⌥→ ....... focus the column left / right (clamped, never wraps)
//   · ⌘⌥⇧← / ⌘⌥⇧→ ..... carry the focused column along the strip
//   · ⌘⇧R ............. cycle the focused column's width preset
//   · ⌘⌥↑ / ⌘⌥↓ ....... widen / narrow the focused column one preset step
//   · ← / → ........... same as focus left/right when you aren't typing
//   · two-finger swipe . free-scroll the rail; the column nearest centre takes
//                        focus when you let go (snap-on-release)
//
// This component owns only the strip's own geometry — column order, focus, and
// closing are registry operations, so they go up to ProjectView as events. Column
// *width* is purely presentational, so it lives here.

import { computed, ref } from "vue";
import { usePreferredReducedMotion } from "@vueuse/core";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon, ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon, Exchange01Icon, Link05Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { SolarChatRoundLineBrokenIcon } from "~/utils/solarChatIcons";
import { ClosingPlasma } from "~/components/ui/closing-plasma";
import { Magnet } from "~/components/ui/magnet";
import type { Pane, StudioDestination } from "~/types/studio";
import { paneKindMeta } from "~/utils/paneKinds";
import { isBlankThread } from "~/utils/panes";
// The scroll rule the centring modes name, and the geometry it reads. Shared with
// SettingsThreadStripPane so the settings preview runs the board's own maths rather
// than a copy of it — see the header of that module.
import {
  JOINT_PX,
  LADDER_PX,
  padEndFor,
} from "~/utils/stripScroll";
import { brandOf, buildCompactBySession, columnLabel, handoffSourceBrand, hasScratchpadPane, isHandoff, readCompactProps, threadHands } from "~/utils/stripColumnLabels";
import ContextWindowMeter from "~/components/thread/ContextWindowMeter.vue";
import ThreadInfoPanel from "~/components/thread/ThreadInfoPanel.vue";
import ThreadWorkspaceMark from "~/components/thread/ThreadWorkspaceMark.vue";
import { type ThreadSession } from "~/composables/useAgent";
import { useAgentProviders } from "~/composables/useAgentProviders";
import type { MeterCompactProps } from "~/utils/compactAvailability";
import { useStripChooser } from "~/composables/useStripChooser";
import { useStripInfo } from "~/composables/useStripInfo";
import { useStripKeyboard } from "~/composables/useStripKeyboard";
import { useStripLinking } from "~/composables/useStripLinking";
import { useStripPaneActions } from "~/composables/useStripPaneActions";
import { useStripRail } from "~/composables/useStripRail";
import { useStripOverview } from "~/composables/useStripOverview";
import { useStripPresets } from "~/composables/useStripPresets";
import { useStripSeams } from "~/composables/useStripSeams";
import StripProjectSwitch from "~/components/thread/StripProjectSwitch.vue";
import StripChooserHead from "~/components/thread/StripChooserHead.vue";
import { useStripUnread } from "~/composables/useStripUnread";
import type { GitRemote } from "~/types/desktop";

const props = defineProps<{
  /** Live panes in strip order (left to right). A pane's session may be null
   *  (dormant) — every read here is null-safe. */
  panes: Pane[];
  /** The focused pane's stable id. */
  focusedId: string;
  /** Ticking clock from useAgent, so every column's "working · Xs" counts up. */
  now: number;
  /** Briefly pulse a pad column's index dash after a thread → pad append. */
  pulseKey?: string | null;
  /** Whether the board surface is the visible one. The strip stays mounted while
   *  hidden (so panes and scroll positions survive), but a hidden rail measures
   *  zero width — so re-centre once it's revealed, not while it's hidden. */
  visible?: boolean;
  /** The desktop is bare — zero panes — so there's no column to hang an insert
   *  affordance off. Show the centered "new column" chooser over the rail.
   *  Picking a kind emits `choose`; ProjectView acts on it. A lone *blank thread*
   *  is deliberately NOT this case: that column shows plainly, with its trailing
   *  seam pill offering terminal / scratchpad. */
  chooser?: boolean;
  /** The project's folder name — handed to a thread's info panel. */
  repo?: string;
  /** The project's absolute path — the chooser pill shows the directories
   *  before the folder name, faded, so two same-named projects still read apart. */
  projectPath?: string;
  /** The project's current git branch, if any — handed to a thread's info
   *  panel, where it marks the thread as living in a git project. */
  branch?: string;
  /** The project's origin remote — handed to a thread's info panel, where it
   *  names the hosted repo the thread's work belongs to. */
  origin?: GitRemote | null;
  /** Studio-wide 2D overview mode. When provided, controls this strip's overview state. */
  overview?: boolean;
  /** Every project the plane can travel to, in the camera's own top-to-bottom
   *  order — handed straight to the project switcher, which drops this row's
   *  own project from it. */
  destinations?: StudioDestination[];
}>();

const emit = defineEmits<{
  /** Focus this column (a click, or the rail settling on it after a swipe). */
  focus: [key: string];
  /** A column was picked/selected in overview mode — parent coordinates zoom. */
  "select-column": [key: string];
  /** Step focus this many columns along the strip. */
  shift: [delta: number];
  /** Carry the focused column this many places along the strip. */
  move: [delta: number];
  close: [key: string];
  /** Archive this thread and close its column. Carries the provider thread id (so
   *  the store/history row can be stamped archived) and the pane key (so the
   *  column can be closed). Only ever fired for a non-blank thread column. */
  archive: [threadId: string, key: string];
  /** Fork a side chat off this thread's column (the per-host-thread "add panel"
   *  creator). Carries the source pane id; ProjectView opens the child beside it. */
  "side-chat": [paneId: string];
  /** Hand this thread's column to another provider/model (the per-thread
   *  handoff creator). Carries the source pane id; the row asks for the
   *  target and opens the handoff beside the source. */
  handoff: [paneId: string];
  /** Fork this thread's column at an earlier user block (edit-and-resend of
   *  that message). Carries the source pane id, the edited block id and the
   *  edited text; the row forks via IPC and opens the child beside the source. */
  "edit-fork": [paneId: string, blockId: string, text: string];
  /** Branch this thread's column off a settled assistant reply. Carries the
   *  source pane id and that reply's block id; the row asks for the target
   *  model and opens the branch beside the source. */
  "branch-fork": [paneId: string, blockId: string];
  /** Jump to a thread linked from a column's handoff footer. Carries the
   *  linked thread id; the row opens (or focuses) it. */
  "open-thread": [threadId: string];
  /** Insert a blank thread to the right of seam `seamIndex`. */
  "insert-column": [seamIndex: number, kind: "thread" | "terminal" | "scratchpad"];
  /** Write terminal input data. Keyed by the terminal *session* key, not the pane
   *  id: these three go straight to useTerminal, which keys its registry by
   *  session. Every other emit here carries a pane id, so the mismatch is easy
   *  to reintroduce — the strip has the session in hand (`c.session.key`), so it
   *  passes that. */
  "terminal-write": [sessionKey: string, data: string];
  /** Resize terminal PTY. Session-keyed, same as `terminal-write`. */
  "terminal-resize": [sessionKey: string, cols: number, rows: number];
  /** Restart terminal PTY in place. Session-keyed, same as `terminal-write`. */
  "terminal-restart": [sessionKey: string];
  /** Append assistant reply markdown to a scratchpad. */
  "to-scratchpad": [text: string, sourceKey: string];
  "scratchpad-flush": [key: string];
  /** A column's width preset index changed — persist it onto the pane entry. */
  width: [key: string, index: number];
  /** A column's maximized (zen) state changed — persist it onto the pane entry. */
  zen: [key: string, zen: boolean];
  /** The empty-board chooser picked a kind — start the board with that pane
   *  (or, for a thread, just reveal the waiting blank column). */
  choose: [kind: "thread" | "terminal" | "scratchpad"];
  /** Overview (Exposé) turned on or off. */
  "update:overview": [value: boolean];
  /** Request studio-wide overview toggle. */
  "toggle-overview": [];
  /** Travel to another project's row, picked from the project drop-down. */
  "switch-row": [projectPath: string];
}>();

const { cue } = useSound();
// Provider surface rows (capabilities included) — the meter's Compact control
// gates on the thread's provider advertising manual compaction.
const agentProviders = useAgentProviders();
// niri's `center-focused-column`, shared with the settings drawer through a
// module-scope ref (see useStripPrefs) so flipping it there steers the scroll
// maths below live, with no prop threaded in and no reload.
const { centerMode } = useStripPrefs();

const rail = ref<HTMLElement | null>(null);
const railWidth = ref(0);
const reducedMotion = usePreferredReducedMotion();

function reducedMotionOn(): boolean {
  return reducedMotion.value === "reduce";
}

const {
  PRESETS,
  DEFAULT_PRESET,
  widthAnim,
  isSideChatPane,
  presetIndexFor,
  clampPreset,
  zenPreset,
  isZen,
  presetFor,
  flagWidthAnim,
  setPreset,
  cycleWidth,
  growWidth,
  shrinkWidth,
  toggleZen,
} = useStripPresets({
  panes: () => props.panes,
  focusedId: () => props.focusedId,
  railWidth,
  reducedMotionOn,
  onWidthEmit: (id, index) => emit("width", id, index),
  onZenEmit: (id, zen) => emit("zen", id, zen),
  // The rail cluster is wired below; the arrow defers the read to call time.
  onScrollToColumn: (id) => stripRail.scrollToColumn(id),
});

const overviewState = useStripOverview({
  rail,
  railWidth,
  reducedMotionOn,
});
const { overview, plane, scalerStyle, planeStyle, isZooming } = overviewState;

const isSolo = computed(() => props.panes.length === 1);

/** Leading pad centres the lone thread; trailing pad lets the last column scroll
 *  to centre when there are two or more. */
const soloPadStart = computed(() => {
  if (!isSolo.value || !railWidth.value) return 0;
  const s = props.panes[0];
  if (!s) return 0;
  const colW = Math.min(presetFor(s.id).px, railWidth.value);
  // Pull the pad in by the leading seam's width so the column itself — not the
  // seam+column pair — sits centred, exactly as it did before the seam existed.
  // (The leading seam mirrored before the first column is a real element in the
  // plane, so it would otherwise shift the lone column right of centre.)
  return Math.max(0, (railWidth.value - colW) / 2 - JOINT_PX);
});
const railPads = computed(() => {
  // In overview nothing centre-scrolls, so the half-screen trailing pad would just be
  // dead space on the right and — because it's inside the scaled plane, so it counts
  // toward naturalWidth — it would drag k toward the floor even with only a few
  // columns. Flatten both pads to a symmetric gutter instead: equal breathing room on
  // each side, and with k fitting the plane to the full rail width that reads as a
  // centred plane. (The pads stay in the plane; they just get small, matching values.)
  if (overview.value) {
    return {
      "--rail-pad-start": `${OVERVIEW_GUTTER}px`,
      "--rail-pad-end": `${OVERVIEW_GUTTER}px`,
    };
  }
  // The trailing pad only exists so the *last* column can reach the centre of the
  // viewport. In `never` we never centre, so that pad would just be scrollable
  // emptiness past the end of the strip — you'd swipe into nothing and nearestKey
  // (which picks by viewport centre) would start answering out there. Shrink it to
  // a peek. `on-overflow` still centres when it moves, so it keeps the half-screen.
  const padEnd = padEndFor(centerMode.value, railWidth.value);
  return {
    "--rail-pad-start": isSolo.value ? `${soloPadStart.value}px` : "0px",
    "--rail-pad-end": isSolo.value ? "0px" : `${padEnd}px`,
  };
});

// ── the rail ──────────────────────────────────────────────────────────────────
// Column geometry, programmatic scrolling, overview zoom, swipe settle,
// pinch-zoom and resize. The four timing latches that tell programmatic
// scrolls apart from user scrolls stay inside the composable; the seam card's
// close travels in (the rail shuts it on any scroll) and the template bindings
// plus the zoom controls come back out.
const stripRail = useStripRail({
  rail,
  railWidth,
  panes: () => props.panes,
  focusedId: () => props.focusedId,
  visible: () => props.visible,
  controlledOverview: () => props.overview,
  isSolo,
  reducedMotionOn,
  presetFor,
  flagWidthAnim,
  closeJoint: () => closeJoint(),
  ov: overviewState,
  emits: {
    updateOverview: (value) => emit("update:overview", value),
    toggleOverview: () => emit("toggle-overview"),
    focus: (key) => emit("focus", key),
  },
});
const {
  isResizing,
  setCol,
  scrollToColumn,
  enterOverview,
  exitOverview,
  toggleOverview,
  onScroll,
} = stripRail;

// The thread-info drop-down: clicking a column title toggles a panel anchored
// beneath it. We keep the opening title's viewport rect as the anchor and the
// session itself (its refs stay live while the panel is open).
const { infoPaneId, infoAnchor, infoSession, toggleInfo, closeInfo } = useStripInfo();

// ── pane event forwarding ───────────────────────────────────────────────────
// Column intents relayed to their sessions (or re-emitted to the row). The
// overview ref and the info session travel in as refs; the emitters as one
// callbacks object, so the forwarding never names the component's events.
const {
  onColumnClick,
  onCardKeydown,
  onTerminalWrite,
  onTerminalResize,
  onTerminalRestart,
  onClose,
  onArchive,
  onRetryTurn,
  onResendTurn,
  onRetryLoad,
  onLoadOlder,
  anchoredThreadId,
  onRename,
} = useStripPaneActions({
  focusedId: () => props.focusedId,
  overview,
  exitOverview,
  infoSession,
  emits: {
    focus: (key) => emit("focus", key),
    selectColumn: (key) => emit("select-column", key),
    close: (key) => emit("close", key),
    archive: (threadId, key) => emit("archive", threadId, key),
    terminalWrite: (sessionKey, data) => emit("terminal-write", sessionKey, data),
    terminalResize: (sessionKey, cols, rows) => emit("terminal-resize", sessionKey, cols, rows),
    terminalRestart: (sessionKey) => emit("terminal-restart", sessionKey),
  },
});

function onInsertColumn(seamIndex: number, kind: "thread" | "terminal" | "scratchpad"): void {
  cue("press");
  emit("insert-column", seamIndex, kind);
}

// ── seam insert flyout ────────────────────────────────────────────────────────
const { openSeam, menuAnchor, closeJoint, toggleJoint, onInsertPick } = useStripSeams({
  onInsert: (seamIndex, kind) => onInsertColumn(seamIndex, kind),
});

// ── keyboard ──────────────────────────────────────────────────────────────────
// niri-style focus/carry/width shortcuts plus bare arrows. The window listener
// lives inside the composable; the preset/zen controls and the overview state
// travel in, the template's key-hint readers come back out.
const { matchesShortcut, bindingFor, displayTokens } = useStripKeyboard({
  focusedId: () => props.focusedId,
  overview,
  exitOverview,
  isZen,
  cycleWidth,
  growWidth,
  shrinkWidth,
  toggleZen,
  emits: {
    shift: (delta) => emit("shift", delta),
    move: (delta) => emit("move", delta),
  },
});

/** The meter's Compact control per live session, memoized by session key — one
 *  shared rule decides, the session runs the call. A computed map (the inbox
 *  live pane's pattern, fanned out) so a re-render reuses the props object
 *  instead of minting a fresh one per column per frame. */
const compactBySession = computed(() =>
  buildCompactBySession(props.panes, agentProviders.statuses.value),
);

/** Spread onto ContextWindowMeter with v-bind. */
function compactProps(s: ThreadSession): MeterCompactProps {
  return readCompactProps(compactBySession.value, s.key);
}

/** The project's single scratchpad is on the strip — the seam menu greys its row. */
const hasScratchpad = computed(() => hasScratchpadPane(props.panes));

// ── bare-board chooser ──────────────────────────────────────────────────────
// The same pane-kind registry the seam menu offers, laid out as a centered pick
// for a desktop with no windows at all. The shortcut-chip readers come from
// the keyboard cluster; the pick leaves as `choose`.
const { plasmaOpacity, chooserActions, onChoose } = useStripChooser({
  bindingFor,
  displayTokens,
  emits: {
    choose: (kind) => emit("choose", kind),
  },
});

// ── linking + blank-pane predicates ──────────────────────────────────────────
// Side-chat seam joints, the seam menu's greyed rows, and the read-stamp
// watcher (which moves with the panes it watches).
const { canClose, hasBlankThread, isLinkedToNext, paneThreadId } = useStripLinking({
  panes: () => props.panes,
  visible: () => props.visible,
});

// ── unread marks ──────────────────────────────────────────────────────────────
// Background threads with unseen activity wear a solid accent dash beside the
// breathing live one. Same visit timestamps the inbox reads, refreshed from
// the store on turn events.
const { isUnread } = useStripUnread({
  panes: () => props.panes,
  paneThreadId,
  projectPath: () => props.projectPath,
  focusedId: () => props.focusedId,
  visible: () => props.visible,
});
</script>

<template>
  <div class="strip" :class="{ 'is-resizing': isResizing, 'is-overview': overview }">
    <!-- Overview is a mode, not a dialog — announce it politely for screen readers
         rather than trapping focus. Empty (not removed) when off so the region
         stays in the tree and the change is what's announced. -->
    <span class="sr-only" aria-live="polite">{{
      overview ? `Overview — ${panes.length} columns` : ""
    }}</span>
    <nav v-if="!chooser && (panes.length > 1 || repo)" class="index" aria-label="Columns">
      <div v-if="panes.length > 1" class="index__dashes">
        <button
          v-for="(c, i) in panes"
          :key="c.id"
          type="button"
          class="index__dash"
          :class="[
            paneKindMeta(c.kind).dashClass,
            {
              'is-focused': c.id === focusedId,
              'is-dormant': !c.session && c.id !== focusedId,
              'is-live': c.kind === 'thread' && !!c.session && c.session.busy.value && c.id !== focusedId,
              'is-unread': isUnread(c),
              'is-pulse': c.id === props.pulseKey,
              'is-sidechat': c.kind === 'thread' && !!c.session?.isSideChat.value,
            },
          ]"
          :aria-label="`Column ${i + 1}: ${columnLabel(c)}${isUnread(c) ? ', unread' : ''}`"
          :aria-current="c.id === focusedId"
          @click="onColumnClick(c.id)"
        />
      </div>
      <StripProjectSwitch
        v-if="repo"
        :repo="repo"
        :project-path="projectPath"
        :destinations="destinations"
        @switch="(path) => emit('switch-row', path)"
      />
    </nav>

    <!-- Solo: leading pad centres the thread. Multi: tile from the left, trailing
         pad lets the rightmost column scroll to centre when focused. -->
    <div
      ref="rail"
      class="rail"
      :class="{ 'is-solo': isSolo, 'is-overview': overview, 'is-zooming': isZooming }"
      :style="railPads"
      @scroll="onScroll"
    >
      <!-- Two-element wrap so the scaled plane and the layout footprint it occupies
           are separate boxes: the scaler carries the shrunken width (so the rail's
           scrollWidth shrinks with k), the plane is the real flex row we scale in
           place. Keep the plane's x-origin at 0 — no position, no padding-inline —
           or every offsetLeft the scroll maths reads silently changes meaning. -->
      <div class="rail__scaler" :style="scalerStyle">
        <div ref="plane" class="rail__plane" :style="planeStyle">
          <div class="rail__pad rail__pad--start" aria-hidden="true" />

          <template v-for="(c, i) in panes" :key="c.id">
            <!-- Leading seam — first column only. Every column carries a trailing
                 seam (below) that inserts to its right; without borders that seam is
                 also the one visible mark of a column's right edge. The leftmost
                 column's left edge — the board's own left bound — has no such mark, so
                 mirror a seam there. Insert index -1 → `seamIndex + 1` = 0, the left
                 edge (useStudio clamps `at` to [0, length]). -->
            <button
              v-if="i === 0"
              type="button"
              class="col-joint col-joint--lead"
              aria-label="Insert column at start"
              aria-haspopup="dialog"
              :aria-expanded="openSeam === -1"
              :inert="overview"
              @click.stop="toggleJoint(-1, $event.currentTarget)"
            >
              <span class="col-joint__pill" aria-hidden="true" />
            </button>
            <section
              :ref="(el) => setCol(c.id, el)"
              class="col"
              :data-column-key="c.id"
              :class="{
                'is-focused': c.id === focusedId,
                'is-width-anim': widthAnim[c.id],
                'is-sidechat': c.kind === 'thread' && !!c.session?.isSideChat.value,
              }"
              :style="{ '--col-w': presetFor(c.id).width }"
              :role="overview ? 'button' : undefined"
              :tabindex="overview ? 0 : undefined"
              :aria-label="overview ? columnLabel(c) : undefined"
              @click="onColumnClick(c.id)"
              @keydown="onCardKeydown(c.id, $event)"
            >
              <!-- In overview the card is a single button; `inert` (not just the visual
                   opacity: 0 on the tools) removes its inner controls from tab order and
                   the a11y tree, so tabbing steps card → card and the outer role="button"
                   no longer wraps focusable descendants (which would be invalid ARIA). -->
              <header class="col__head" :inert="overview">
                <!-- Fork actions live left, column management right. The split
                     is by what the button acts on: the left group acts on the
                     thread itself (panel off it, hand it elsewhere, put it
                     away — or restart the terminal session) while the right
                     group acts on the column frame (width, zoom, close). Both
                     groups reveal on hover so the header stays a title. -->
                <div class="col__fork">
                  <button
                    v-if="
                      c.kind === 'thread' &&
                      c.session &&
                      !isBlankThread(c) &&
                      !c.session.isSideChat.value
                    "
                    type="button"
                    class="col__tool"
                    aria-label="Open a side chat"
                    title="Open a side chat"
                    @click.stop="emit('side-chat', c.id)"
                  >
                    <HugeiconsIcon :icon="SolarChatRoundLineBrokenIcon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <button
                    v-if="
                      c.kind === 'thread' &&
                      c.session &&
                      !isBlankThread(c) &&
                      !c.session.isSideChat.value
                    "
                    type="button"
                    class="col__tool"
                    aria-label="Hand off to another provider"
                    title="Hand off to another provider"
                    @click.stop="emit('handoff', c.id)"
                  >
                    <HugeiconsIcon :icon="Exchange01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <button
                    v-if="c.kind === 'thread' && c.session && !isBlankThread(c)"
                    type="button"
                    class="col__tool"
                    aria-label="Archive conversation"
                    title="Archive conversation"
                    @click.stop="onArchive(c)"
                  >
                    <HugeiconsIcon :icon="Archive02Icon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                </div>
                <div class="col__title-wrap">
                  <template v-if="c.kind === 'thread' && c.session">
                    <!-- A handoff wears where it came from: old mark → live
                         mark as one tight unit, then the title. The source
                         reads dimmer — history, not the engine running this
                         column. -->
                    <span v-if="isHandoff(c)" class="col__handoff">
                      <ProviderLogo :brand="handoffSourceBrand(c)" :size="15" class="col__handoff-from" />
                      <span class="col__handoff-arrow" aria-hidden="true">→</span>
                      <ProviderLogo :brand="brandOf(c)" :size="15" />
                    </span>
                    <!-- Changed hands in place: the hands it has been through,
                         earlier ones dimmer. No arrow — nothing moved, so
                         nothing points anywhere. -->
                    <span v-else-if="threadHands(c).length > 0" class="col__hands">
                      <ProviderLogo
                        v-for="(brand, hi) in threadHands(c)"
                        :key="`${brand}-${hi}`"
                        :brand="brand"
                        :size="15"
                        :class="{ 'col__hands-past': hi < threadHands(c).length - 1 }"
                      />
                    </span>
                    <ProviderLogo v-else :brand="brandOf(c)" :size="15" />
                    <span
                      v-if="c.session.isSideChat.value"
                      class="col__sidechat"
                      :title="'Side chat — forked from a conversation'"
                    >
                      <HugeiconsIcon :icon="SolarChatRoundLineBrokenIcon" :size="11" :stroke-width="2" aria-hidden="true" />
                    </span>
                    <!-- Works in a folder of its own rather than the project's
                         checkout. The icon is the whole signal; which folder is
                         the tooltip, and the info panel opens it. -->
                    <ThreadWorkspaceMark
                      class="col__worktree"
                      icon-only
                      :worktree-path="c.session.worktreePath.value"
                      :env-mode="c.session.envMode.value"
                    />
                    <!-- The title opens the info panel — which is also where it
                         gets renamed, so the header itself stays a read-out. -->
                    <h2
                      class="col__title col__title--btn"
                      :title="c.session.title.value || 'New thread'"
                      role="button"
                      tabindex="0"
                      :aria-expanded="infoPaneId === c.id"
                      @click.stop="toggleInfo(c, $event)"
                      @keydown.enter.prevent="toggleInfo(c, $event)"
                      @keydown.space.prevent="toggleInfo(c, $event)"
                    >{{ c.session.title.value || "New thread" }}</h2>
                    <ContextWindowMeter
                      v-if="c.session.tokenUsage.value"
                      :usage="c.session.tokenUsage.value"
                      v-bind="compactProps(c.session)"
                    />
                  </template>
                  <template v-else>
                    <HugeiconsIcon :icon="paneKindMeta(c.kind).icon" :size="15" :stroke-width="2" class="text-muted" />
                    <h2 class="col__title">{{ columnLabel(c) }}</h2>
                    <!-- A terminal's live subprocess (vim, `npm run dev`): one
                         quiet dot + dim command name. Deliberately tiny and
                         muted — it must not fight the terminal for attention. -->
                    <span
                      v-if="c.kind === 'terminal' && c.session?.hasRunningSubprocess"
                      class="col__busy"
                      :title="c.session.childCommandLabel ? `Running: ${c.session.childCommandLabel}` : 'Running a command'"
                    >
                      <span class="col__busy-dot" aria-hidden="true" />
                      <span v-if="c.session.childCommandLabel" class="col__busy-label">{{ c.session.childCommandLabel }}</span>
                    </span>
                  </template>
                </div>
                <div class="col__tools">
                  <button
                    v-if="!isSideChatPane(c.id)"
                    type="button"
                    class="col__tool col__tool--width"
                    :disabled="isZen(c.id)"
                    :aria-label="isZen(c.id) ? 'Width — maximized' : `Cycle width (currently ${presetFor(c.id).px}px)`"
                    :title="isZen(c.id) ? 'Maximized' : `Width: ${presetFor(c.id).px}px`"
                    @click.stop="cycleWidth(c.id)"
                  >
                    {{ presetFor(c.id).label }}
                  </button>
                  <button
                    v-if="c.kind === 'terminal' && c.session"
                    type="button"
                    class="col__tool"
                    aria-label="Restart terminal"
                    title="Restart terminal"
                    @click.stop="onTerminalRestart(c)"
                  >
                    <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <button
                    v-if="c.id === focusedId && !isSideChatPane(c.id)"
                    type="button"
                    class="col__tool"
                    :aria-label="isZen(c.id) ? 'Restore column' : 'Maximize column'"
                    :title="isZen(c.id) ? 'Restore column' : 'Maximize column'"
                    @click.stop="toggleZen()"
                  >
                    <HugeiconsIcon
                      :icon="isZen(c.id) ? ArrowShrink01Icon : ArrowExpand01Icon"
                      :size="13"
                      :stroke-width="2"
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    v-if="canClose()"
                    type="button"
                    class="col__tool"
                    aria-label="Close column"
                    title="Close column"
                    @click.stop="onClose(c.id)"
                  >
                    <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
                  </button>
                </div>
              </header>

              <div
                class="col__body selectable"
                :class="paneKindMeta(c.kind).bodyClass"
                :data-column-type="c.kind"
                :inert="overview"
              >
                <template v-if="c.kind === 'thread' && c.session">
                  <ConversationThread
                    :blocks="c.session.timelineBlocks.value"
                    :compactions="c.session.compactions.value"
                    :checkpoints="c.session.checkpoints.value"
                    :now="now"
                    :source-key="c.id"
                    :thread-id="anchoredThreadId(c)"
                    :load-failed="c.session.transcriptLoadFailed.value"
                    :agent-seed="c.session.threadId.value"
                    :loading="c.session.sessionState.value === 'starting'"
                    :busy="c.session.busy.value"
                    :has-older="c.session.hasOlder.value"
                    :loading-older="c.session.loadingOlder.value"
                    :older-error="c.session.olderError.value"
                    :fork-context="c.session.forkContext?.value ?? null"
                    :link-handoffs="true"
                    :allow-branch="true"
                    :hand-ins="c.session.handInRecords.value"
                    @to-scratchpad="(text) => emit('to-scratchpad', text, c.id)"
                    @retry="(text) => onRetryTurn(c, text)"
                    @resend="(text) => onResendTurn(c, text)"
                    @edit-fork="(blockId, text) => emit('edit-fork', c.id, blockId, text)"
                    @branch-fork="(blockId) => emit('branch-fork', c.id, blockId)"
                    @retry-load="() => onRetryLoad(c)"
                    @load-older="() => onLoadOlder(c)"
                    @open-thread="(id) => emit('open-thread', id)"
                  />
                </template>
                <template v-else-if="c.kind === 'terminal' && c.session">
                  <TerminalPane
                    :session="c.session"
                    @write="(data) => onTerminalWrite(c, data)"
                    @resize="(cols, rows) => onTerminalResize(c, cols, rows)"
                  />
                </template>
                <template v-else-if="c.kind === 'scratchpad' && c.session">
                  <ScratchpadPane
                    :session="c.session"
                    @flush="emit('scratchpad-flush', c.id)"
                  />
                </template>
                <!-- Dormant: the pane is restored but nothing has attached yet.
                     Threads attach when the board is shown (and on focus if they
                     were evicted past the resident cap) — "Opening…" is that
                     brief load, not a resting state. A dormant scratchpad shows
                     nothing (its empty-state idiom is an empty page); a terminal
                     invites the click that starts its PTY. -->
                <template v-else-if="c.kind === 'terminal'">
                  <p class="col__dormant">Terminal ready — click to open a shell.</p>
                </template>
                <template v-else-if="c.kind === 'thread'">
                  <p class="col__dormant">Opening…</p>
                </template>
              </div>

              <!-- Focused-column overlay: the host's ask (mid-turn question /
                   tool approval) rendered inside the focused thread column, so
                   its scrim dims only that thread and its card lands
                   bottom-centre in it — the same contained shell the inbox
                   thread wears. Suppressed in overview, where a column is a
                   map card, not a document. -->
              <slot
                v-if="c.id === focusedId && !overview"
                name="focused-overlay"
                :pane="c"
              />

              <!-- The card's true-size caption. Card content scaled to k is illegible
                   mush; a crisp label under each card is what makes the zoom read as a
                   designed overview and not a broken shrink. It lives *inside* the scaled
                   plane, so counter-scaling by 1/k (via --inv-k, published once on the
                   plane) parks it back at ~12.5px on screen — rendering it outside the
                   plane would need manual x-positioning that desyncs during the zoom. -->
              <span
                v-if="overview"
                class="col__map-label"
                aria-hidden="true"
              >
                <ProviderLogo
                  v-if="c.kind === 'thread'"
                  :brand="brandOf(c)"
                  :size="13"
                  class="col__map-logo"
                />
                <span class="col__map-text">{{ columnLabel(c) }}</span>
              </span>
            </section>

            <template v-if="isLinkedToNext(i)">
              <div
                class="col-joint col-joint--linked"
                aria-label="Linked to conversation"
                title="Linked to conversation"
                :inert="overview"
              >
                <span class="col-joint__link" aria-hidden="true">
                  <HugeiconsIcon :icon="Link05Icon" :size="12" :stroke-width="2.2" />
                </span>
              </div>
            </template>
            <button
              v-else
              type="button"
              class="col-joint"
              aria-label="Insert column"
              aria-haspopup="dialog"
              :aria-expanded="openSeam === i"
              :inert="overview"
              @click.stop="toggleJoint(i, $event.currentTarget)"
            >
              <span class="col-joint__pill" aria-hidden="true" />
            </button>
          </template>

          <div class="rail__pad rail__pad--end" aria-hidden="true" />
        </div>
      </div>
    </div>



    <!-- Bare desktop — every window closed, zero panes. Offer the same pick the
         seam menu gives (thread / terminal / scratchpad), centered. The rail
         stays mounted behind this so it keeps measuring. -->
    <div v-if="chooser" class="chooser" role="dialog" aria-label="Start a column">
      <!-- Ambient close: the warm plasma glow from the projects-list empty
           state rises off the bare board's floor and dissolves into the ground,
           giving the empty desktop depth without a hard edge. Purely
           decorative — never intercepts pointer events, sits behind the pick. -->
      <motion.div
        class="chooser__plasma pointer-events-none"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :transition="{ duration: 1.4, delay: 0.2, ease: 'easeOut' }"
      >
        <ClosingPlasma
          class="size-full"
          :interactive="false"
          :speed="0.55"
          :turbulence="0.85"
          :grain="0.4"
          :sparkle="0.35"
          :opacity="plasmaOpacity"
        />
      </motion.div>
      <div class="chooser__panel">
        <!-- The row this empty board belongs to, named above the pick — the
             chooser covers the whole surface, so without it nothing says
             which project you'd be starting a column in. -->
        <StripChooserHead :project-path="projectPath" :repo="repo" :branch="branch" />
        <div class="chooser__actions">
          <!-- Each row leans gently toward the cursor as it approaches, then
               eases back — the same magnet pull the app's other action rows
               ride (start actions, lane actions, folder rows). -->
          <Magnet
            v-for="action in chooserActions"
            :key="action.kind"
            class="block w-full"
            inner-class="w-full"
            :padding="12"
            :magnet-strength="9"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              class="chooser__row"
              @click="onChoose(action.kind)"
            >
              <span class="chooser__row-lead">
                <HugeiconsIcon :icon="action.icon" :size="16" :stroke-width="1.9" aria-hidden="true" />
              </span>
              <span class="chooser__row-label">{{ action.label }}</span>
              <span v-if="action.keys.length" class="chooser__keys" aria-hidden="true">
                <kbd v-for="(k, ki) in action.keys" :key="ki" class="chooser__key">{{ k }}</kbd>
              </span>
            </button>
          </Magnet>
        </div>
      </div>
    </div>

    <ThreadInsertMenu
      :open="openSeam !== null"
      :x="menuAnchor.x"
      :y="menuAnchor.y"
      :side="openSeam === -1 ? 'right' : 'left'"
      :scratchpad-open="hasScratchpad"
      :blank-thread-open="hasBlankThread"
      @close="closeJoint"
      @pick="onInsertPick"
    />

    <ThreadInfoPanel
      v-if="infoSession && infoAnchor"
      :session="infoSession"
      :anchor="infoAnchor"
      :repo="repo"
      :project-path="projectPath"
      :branch="branch"
      :origin="origin"
      :worktree-path="infoSession.worktreePath.value"
      :env-mode="infoSession.envMode.value"
      @close="closeInfo"
      @rename="onRename"
    />
  </div>
</template>

<style scoped>
.strip {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  height: 100%;
  overflow: hidden;
  /* Entering overview dips the backdrop (see .strip.is-overview); ease it so the
     mode change settles rather than flashing. */
  transition: background-color 0.4s ease;
}

.index {
  position: absolute;
  top: 1.7rem;
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  align-items: center;
  pointer-events: none;
  transition: opacity 0.28s ease;
}
/* Frameless shells: the strip only renders inside the studio plane, which
   paints over the project page's titlebar band, so the dashes keep their own
   line. The plane's top edge is the window drag band (see AppStudio); every
   control on this line opts back out so it stays clickable. */
.frameless .index__dash {
  -webkit-app-region: no-drag;
}
.index__dashes {
  display: flex;
  align-items: center;
  gap: 6px;
}
.index__dash {
  pointer-events: auto;
  cursor: pointer;
  position: relative;
  width: 13px;
  height: 2px;
  border-radius: 999px;
  -webkit-tap-highlight-color: transparent;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.3s ease;
}
/* A 2px hairline is not a pointer target. Expand the clickable box off-layout —
   half the 6px gutter on each side, so neighbouring dashes meet without
   overlapping — leaving the mark itself the size it wants to be. */
.index__dash::after {
  content: "";
  position: absolute;
  inset: -8px -3px;
}
.index__dash:hover {
  background: color-mix(in srgb, var(--ink) 34%, transparent);
}
/* Keyboard arrival has to be visible: the strip's nav is otherwise a row of
   near-identical hairlines. */
.index__dash:focus-visible {
  outline: none;
  width: 24px;
  background: var(--accent);
}
.index__dash.is-focused {
  width: 24px;
  background: var(--ink);
}
.index__dash.is-pad {
  width: 10px;
  height: 2px;
}
/* A dormant pane (restored, not yet attached) reads even quieter than a resting
   dash — present, but clearly "asleep". */
.index__dash.is-dormant {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.index__dash.is-dormant:hover {
  background: color-mix(in srgb, var(--ink) 22%, transparent);
}
.index__dash.is-pulse {
  animation: dash-pulse 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes dash-pulse {
  0%,
  100% {
    background: color-mix(in srgb, var(--ink) 16%, transparent);
  }
  40% {
    background: var(--accent);
    width: 18px;
  }
}
.index__dash.is-live {
  background: var(--accent);
  animation: dash-breathe 1.9s ease-in-out infinite;
}
@keyframes dash-breathe {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
/* An unseen reply waits as a solid accent dash — the same accent the live
   dash breathes in, held still. Wider than rest so it carries at a glance,
   narrower than focused so focus still wins the row. Live keeps its breath
   when both land together; dormant yields to it. */
.index__dash.is-unread {
  width: 18px;
  background: var(--accent);
}
.index__dash.is-unread:hover {
  background: var(--accent);
}
.index__dash.is-unread.is-focused {
  width: 24px;
  background: var(--accent);
}

/* Empty-board chooser — an opaque layer over the rail, its pick stack centred.
   Borderless and soft, in keeping with the rest of the board (no card, no
   divider, no heavy shadow). */
.chooser {
  position: absolute;
  inset: 0;
  z-index: 15;
  display: grid;
  place-items: center;
  background: var(--ground);
  padding: 3.5rem 1rem 1rem;
  overflow: hidden;
}
/* The ambient plasma — same floor glow as the projects-list empty state:
   anchored to the chooser's bottom edge, masked so it dissolves into the
   ground. Sits behind the pick stack, never takes pointer events. */
.chooser__plasma {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  z-index: 0;
  height: 42vh;
  max-height: 380px;
  min-height: 220px;
  mask-image: linear-gradient(to bottom, transparent, black 55%);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 55%);
}
.chooser__panel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: min(16rem, 100%);
}
.chooser__actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
}
.chooser__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: var(--ink-soft);
  background: transparent;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.chooser__row:hover {
  background: var(--hover);
  color: var(--ink);
}
.chooser__row-lead {
  display: inline-flex;
  flex: none;
  color: var(--muted);
}
.chooser__row:hover .chooser__row-lead {
  color: var(--ink-soft);
}
.chooser__row-label {
  min-width: 0;
  flex: 1;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.chooser__keys {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
.chooser__row:hover .chooser__keys {
  opacity: 1;
}
.chooser__key {
  display: inline-grid;
  place-items: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}

.rail {
  /* Just the scroll container now — the flex layout moved down onto the plane so a
     transform on the plane can shrink what this scrolls against (see rail__scaler). */
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  /* Scroll anchoring is a fight we can only lose here. Entering overview changes the
     scroll extent and the struts in the same frame we assign scrollLeft ourselves; the
     browser's anchor node then "helpfully" adjusts the offset again on top of that, and
     the two corrections beat against each other for a few frames as visible judder. */
  overflow-anchor: none;
}
.rail.is-solo {
  overflow-x: hidden;
}
.rail::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* The layout footprint. Resting it's `max-content` — exactly the width the flex row
   used to size the rail to, so the non-overview layout is pixel-identical to before
   this wrapper existed. In overview it becomes the scaled width (naturalWidth × k),
   which is what shrinks the rail's scrollWidth so there's no dead scroll region. */
/* Deliberately *not* transitioned. Animating this width would animate the rail's scroll
   extent, and a scroll container whose extent shrinks under a scrollLeft that's near the
   end clamps that offset again on every single frame — which is felt as the whole plane
   juddering sideways through the zoom. The footprint snaps to its final value instead and
   the motion is carried entirely by the plane's transform (see animateZoom). Left-anchored
   in both modes: centring, when the scaled plane doesn't fill the rail, is a transform too
   (see centerShift) so it can interpolate with the scale rather than stepping on frame 0. */
.rail__scaler {
  /* no width transition — see above */
}
/* The real, unscaled flex row. In overview it keeps its true width and is scaled into
   the (smaller) scaler from its left edge. Its x-origin must stay at 0.

   `transform` isn't transitioned here either: the zoom is a FLIP driven from script
   (animateZoom), because the scroll remap that goes with it isn't animatable and a plain
   CSS transition would glide the scale while the scroll jumped. What *is* transitioned is
   the part of the change a transform can't express — the struts opening between cards —
   plus `--inv-k`, so the card chrome counter-scales continuously instead of snapping to
   its final size on the first frame. Same duration and curve as the zoom, so the three
   read as one motion. */
.rail__plane {
  display: flex;
  align-items: stretch;
  gap: 0;
  height: 100%;
  transform-origin: 0 50%;
}
.rail.is-overview .rail__plane {
  gap: 28px;
}
.rail.is-zooming .rail__plane {
  pointer-events: none;
}
.rail__pad {
  flex: none;
}
.rail__pad--start {
  width: var(--rail-pad-start, 0px);
}
.rail__pad--end {
  width: var(--rail-pad-end, 0px);
}
.strip.is-resizing .rail__pad--start,
.strip.is-resizing .rail__pad--end {
  transition: none;
}

.col {
  position: relative; /* containing block for the overview caption; inert otherwise */
  display: flex;
  min-width: 0;
  flex: 0 0 var(--col-w);
  flex-direction: column;
  height: 100%;
  padding-top: 3.5rem;
  transition:
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s ease;
}
.col.is-width-anim {
  transition:
    flex-basis 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s ease;
}
.strip.is-resizing .col {
  transition: none;
}
.col:not(.is-focused) {
  cursor: pointer;
  opacity: 0.34;
  filter: saturate(0.7);
  transform: scale(0.985);
}
.col:not(.is-focused):hover {
  opacity: 0.52;
}

/* Seam trigger — fixed footprint; the insert menu floats above the rail. */
.col-joint {
  flex: none;
  align-self: center;
  z-index: 8;
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 14px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
}
.col-joint__pill {
  width: 5px;
  height: 18px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 32%, transparent);
  transition:
    background-color 0.2s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.col-joint:hover .col-joint__pill,
.col-joint[aria-expanded="true"] .col-joint__pill {
  background: color-mix(in srgb, var(--ink) 48%, transparent);
  transform: scaleY(1.08);
}

.col-joint--linked {
  cursor: default;
  pointer-events: none;
  width: 14px;
}
.col-joint__link {
  display: grid;
  place-items: center;
  width: 14px;
  height: 18px;
  color: color-mix(in srgb, var(--accent) 76%, var(--ink-soft));
  background: transparent;
  transition: color 0.25s ease;
}

.col__head {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  min-width: 0;
  padding: 0 0.4rem 0.85rem;
}
.col__title-wrap {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  justify-self: center;
}
.col__title-wrap :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.col__title {
  margin: 0;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--muted);
  transition: color 0.3s ease;
}
.col.is-focused .col__title {
  color: var(--ink);
}

.col__title--btn {
  cursor: pointer;
}
.col__title--btn:hover {
  color: var(--ink);
}
.col__title--btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 2px;
  border-radius: 6px;
}

/* ── side chats: the temporary look ────────────────────────────────────────────
   A side chat is a forked, throwaway conversation — a question asked on the
   side. It reads as provisional chrome: the side-chat icon beside the title, an
   italic accent-tinted title and a faint accent wash over the body. No text, no
   borders — the icon carries the signal. Deliberately distinct from a main
   thread column — the user should never wonder whether this column is a real
   conversation. */
.col__sidechat {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: color-mix(in srgb, var(--accent) 72%, var(--ink-soft));
}
/* Muted like the title beside it: a worktree is where a thread lives, not a
   state to be alarmed by. */
.col__worktree {
  display: inline-flex;
  flex: none;
  align-items: center;
  /* Half the header's gap: the mark belongs to the title it qualifies, not to
     the provider logo on its other side. */
  margin-inline-end: -4px;
  color: var(--muted);
}
/* Handoff provenance in the header: the source mark, a quiet arrow and the
   live mark as one tight, vertically-centred unit ahead of the title. */
.col__handoff {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
}
.col__handoff-from {
  flex: none;
  opacity: 0.55;
}
.col__hands {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* The hands it passed through read quieter than the ones holding it now —
   the live engine is what the eye should land on. */
.col__hands-past {
  opacity: 0.45;
}
.col__handoff-arrow {
  display: inline-flex;
  flex: none;
  align-items: center;
  line-height: 1;
  font-size: 10px;
  color: var(--muted);
  opacity: 0.8;
}
.col.is-sidechat .col__title {
  color: color-mix(in srgb, var(--accent) 58%, var(--muted));
  font-style: italic;
  font-weight: 560;
}
.col.is-focused .col.is-sidechat .col__title,
.col.is-sidechat.is-focused .col__title {
  color: color-mix(in srgb, var(--accent) 66%, var(--ink));
}
.col.is-sidechat .col__body {
  background: color-mix(in srgb, var(--accent) 2.5%, transparent);
}
.index__dash.is-sidechat {
  background: color-mix(in srgb, var(--accent) 40%, transparent);
}
.index__dash.is-sidechat.is-focused {
  background: color-mix(in srgb, var(--accent) 82%, transparent);
}

/* Dormant body — a single muted line, centred, no chrome. */
.col__dormant {
  margin: 0;
  padding: 2.5rem 0.4rem 0;
  text-align: center;
  font-family: var(--font-sans);
  font-size: 12.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  opacity: 0.7;
}

.col__tools {
  grid-column: 3;
  grid-row: 1;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  justify-self: end;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.col:hover .col__tools,
.col__tools:focus-within {
  opacity: 1;
}
/* The thread-action group mirrors the tools: same buttons, same hover reveal,
   other end of the header (see the template note for what goes where). */
.col__fork {
  grid-column: 1;
  grid-row: 1;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  justify-self: start;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.col:hover .col__fork,
.col__fork:focus-within {
  opacity: 1;
}
.col__tool {
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--muted);
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}
.col__tool:hover {
  background: var(--hover);
  color: var(--ink);
}
/* In zen the width rung is meaningless (the column is filling the rail), so the
   width tool sits disabled showing `max` rather than a pixel figure. Dim it and
   drop its pointer target, but keep it in the row — hiding it would reflow the
   tools every time you toggle zen. */
.col__tool:disabled {
  cursor: default;
  opacity: 0.4;
  pointer-events: none;
}
.col__tool--width {
  width: auto;
  min-width: 20px;
  padding-inline: 4px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* A terminal's busy pill — the subprocess dot + command name in the column
   header. Quiet by design: a soft tinted capsule, a plain muted dot (no pulse,
   no glow), and the label clamped so a long command can't shove the title. */
.col__busy {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  max-width: 8rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.col__busy-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.col__busy-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 620;
  letter-spacing: 0.01em;
  color: var(--muted);
}

.col__body {
  --fade-top: 0px;
  --fade-end: 14px;

  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  /* `.selectable` carries a prose measure cap for text that opts into it. This
     is the column's scroll host, not prose: capped, it would sit at the
     measure's width against the column's left edge and leave the rest of a wide
     column empty, instead of the transcript centring in it. The measure belongs
     to the transcript's own column (.thread), which sets it. */
  max-width: none;
  overflow-x: hidden;
  overflow-y: auto;
  /* The floor and the smoke-fade ride --dock-clear / --dock-fade, published by
     the row measuring its floating composer dock — so the open card and the
     pills above it never cover the last turns. The fallbacks are the resting
     floor, for a strip mounted without a row to publish them: they mirror
     STRIP_DOCK_RESTING (208) and STRIP_DOCK_RESTING − STRIP_DOCK_FLOAT (176)
     in composables/useDockClearance.ts — change them together. */
  padding: var(--fade-end) 0.4rem var(--dock-clear, 208px);
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent var(--fade-top),
    #000 var(--fade-end),
    #000 calc(100% - var(--dock-fade, 176px)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent var(--fade-top),
    #000 var(--fade-end),
    #000 calc(100% - var(--dock-fade, 176px)),
    transparent 100%
  );
  scrollbar-width: none;
}
.col__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* A transcript opens on the same 34px rhythm it keeps between its own rows, so
   the first thing in it — a day divider, a routing mark — clears the column
   header by the same distance those rows clear each other. --fade-end already
   pays part of that, and this pays the rest; the fade still ends where it did,
   the first row simply no longer rests inside it. */
.col__body[data-column-type="thread"] {
  padding-top: calc(var(--fade-end) + 20px);
}

/* A terminal column is a PTY, not a chat log: it must NOT inherit the thread
 * body's tall top/bottom padding, its top/bottom mask fade, or its own scroll
 * container — all of which fade out, mis-size and clip xterm (which manages its
 * own viewport + scrollback). Give it a clean full-height box so FitAddon can
 * measure the real height. */
.col__body--terminal {
  padding: 0.5rem 0.65rem 0.65rem;
  overflow: hidden;
  -webkit-mask-image: none;
  mask-image: none;
}

/* Scratchpad columns are prose editors, not chat logs: drop the thread body's
 * tall bottom padding and its col-level mask — the pane's own scroll box owns
 * the top/bottom smoke now (ScratchpadPane `.pad__body`), where the mask can
 * anchor to the true scroll viewport instead of this padding-only frame. */
.col__body--scratchpad {
  padding: 0.65rem 0.4rem 1.25rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── overview (Exposé) ─────────────────────────────────────────────────────────
   Everything below applies *only* in overview. The plane's scale does the zoom;
   these turn the shrunk columns into a legible map — cards to float, a soft
   backdrop to float them on, captions at true size, and every in-card affordance
   silenced so the card reads as a single button. */

/* A soft backdrop dip so the cards have something to sit on. Transitioned, so
   entering overview settles rather than flashes. */
.strip.is-overview {
  background: color-mix(in srgb, var(--ink) 3.5%, var(--ground));
}
/* A minimap on top of a map is noise — the cards *are* the index now. Faded, not cut:
   it sits right where the eye is during the zoom-out. */
.strip.is-overview .index {
  opacity: 0;
  pointer-events: none;
}

/* Columns become cards — a clean radius over a ground fill with subtle hairline definition.
   The opacity/filter/transform overrides undo the resting unfocused dim so the map shows
   every column evenly with crisp clarity. */
.rail.is-overview .col {
  border-radius: 12px;
  background: var(--ground);
  opacity: 1;
  filter: none;
  transform: none;
  padding-top: 0;
  cursor: pointer;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 4%, transparent);
  transition:
    background-color 0.18s ease,
    box-shadow 0.18s ease,
    opacity 0.2s ease;
}
/* The focused card gets presence with a clean accent ring. */
.rail.is-overview .col.is-focused {
  box-shadow:
    0 0 0 1.5px var(--accent),
    0 3px 12px color-mix(in srgb, var(--accent) 18%, transparent);
}
/* A side chat's overview card carries its provisional tint. */
.rail.is-overview .col.is-sidechat {
  background: color-mix(in srgb, var(--accent) 4.5%, var(--ground));
}
/* Clean, stationary hover — illuminates the card's boundary and surface wash
   without physical translateY shift or caption jumping. */
.rail.is-overview .col:hover {
  background: color-mix(in srgb, var(--hover) 45%, var(--ground));
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent),
    0 4px 16px color-mix(in srgb, var(--ink) 7%, transparent);
}
.rail.is-overview .col.is-focused:hover {
  background: color-mix(in srgb, var(--accent) 3.5%, var(--ground));
  box-shadow:
    0 0 0 2px var(--accent),
    0 4px 18px color-mix(in srgb, var(--accent) 26%, transparent);
}
.rail.is-overview .col.is-sidechat:hover {
  background: color-mix(in srgb, var(--accent) 7.5%, var(--ground));
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--accent) 40%, transparent),
    0 4px 16px color-mix(in srgb, var(--accent) 12%, transparent);
}

/* In overview the card is a pure snapshot button: silence everything inside it so
   a click anywhere on it lands as "focus this column", never as an inner scroll, text selection,
   or tool interaction. */
.rail.is-overview .col {
  user-select: none !important;
  -webkit-user-select: none !important;
  touch-action: pan-x !important;
}
.rail.is-overview .col__body,
.rail.is-overview .col__head,
.rail.is-overview :deep(.thread),
.rail.is-overview :deep(.terminal),
.rail.is-overview :deep(.scratchpad),
.rail.is-overview :deep(.xterm),
.rail.is-overview :deep(.xterm-screen),
.rail.is-overview :deep(.xterm-viewport) {
  pointer-events: none !important;
  user-select: none !important;
  -webkit-user-select: none !important;
  overflow: hidden !important;
  overscroll-behavior: none !important;
  touch-action: none !important;
}
.rail.is-overview .col__body *,
.rail.is-overview .col__head *,
.rail.is-overview :deep(.thread *),
.rail.is-overview :deep(.terminal *),
.rail.is-overview :deep(.scratchpad *) {
  pointer-events: none !important;
  user-select: none !important;
  -webkit-user-select: none !important;
  overflow: hidden !important;
  overscroll-behavior: none !important;
  touch-action: none !important;
}
.rail.is-overview .col__body {
  overflow: hidden !important;
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
  -webkit-mask-image: none;
  mask-image: none;
}
.rail.is-overview .col__tools,
.rail.is-overview .col-joint {
  display: none !important;
}

/* The caption. Counter-scaled by 1/k (--inv-k, inherited from the plane) so it stays
   crisp at ~12.5px on screen while its parent plane is scaled down to k. */
.col__map-label {
  position: absolute;
  left: 50%;
  bottom: -32px;
  transform: translateX(-50%) scale(var(--inv-k, 1));
  transform-origin: top center;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 12.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  transition: color 0.2s ease;
  animation: map-label-in 200ms cubic-bezier(0.22, 1, 0.36, 1) 100ms both;
}
@keyframes map-label-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.col__map-logo {
  flex: none;
}
.rail.is-overview .col:hover .col__map-label,
.col.is-focused .col__map-label {
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .index__dash,
  .col,
  .col.is-width-anim,
  .col__tools,
  .col-joint__pill,
  .strip,
  .rail__plane,
  .rail__scaler,
  .col__map-label,
  .rail.is-overview .col {
    transition: none;
  }
  /* No lift, no glide — the zoom is instant. */
  .rail.is-overview .col:hover,
  .rail.is-overview .col.is-focused:hover {
    transform: none;
  }
  .index__dash.is-live,
  .index__dash.is-pulse,
  .col__map-label {
    animation: none;
  }
}
</style>
