<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SettingsPane } from "~/composables/useSettingsSurface";
import type { SettingsGlyphKind } from "./SettingsGlyph.vue";
import { CENTER_MODES } from "~/utils/stripScroll";

// The settings / personalization panel, in the spirit of X's account drawer.
// It doesn't float over the launcher — it sits pinned to the left edge, and the
// launcher itself slides aside (see index.vue's stage) to reveal it. So this is
// just the panel surface; the reveal lives upstream.
//
// The panel is a small navigable drawer: a root list of section groups that
// pushes into detail panes. Those panes are *pages* — the drawer widens and
// hands the whole surface to SettingsProfilePane, SettingsShortcutsPane,
// SettingsProvidersPane, SettingsThreadStripPane, and the rest. Which panes are
// pages is declared in useSettingsSurface, since the launcher's slide is measured
// from the same value.

const props = defineProps<{ open: boolean; surfaceTop: SurfaceId }>();
const emit = defineEmits<{ close: [] }>();

const { muted, toggleMuted, cue } = useSound();
const { resolve: resolveProfile } = useProfile();

// ── thread strip (niri's center-focused-column) ─────────────────────────────────
// The same module-scope ref ThreadStrip.vue reads, so setting it here steers the
// board's scroll behaviour live — no reload, no prop threaded across.
const { centerMode } = useStripPrefs();

// The active option, shown trailing the root row so the current choice reads
// without opening the page. The labels come from CENTER_MODES rather than a copy
// kept here, so the row and the page can't disagree about what a mode is called.
const currentCenterOption = computed(
  () => CENTER_MODES.find((o) => o.value === centerMode.value)?.label ?? "",
);

// ── providers ────────────────────────────────────────────────────────────────
// The row only summarises; the surface itself is SettingsProvidersPane, which the
// drawer widens for (see useSettingsSurface) because a provider's install,
// version, channel and executable don't belong in a 320px column.
//
// What the row owes the user is the one fact worth knowing without opening it:
// how far the picker actually reaches, or that something is behind.
const providers = useAgentProviders();
const providerSettings = useProviderSettings();
const upkeep = useProviderMaintenance();

const readyEnabledCount = computed(
  () =>
    providers.statuses.value.filter(
      (s) => s.readiness === "ready" && providerSettings.isEnabled(s.provider),
    ).length,
);

// An available update outranks the ready count: it's the only one of the two
// that's asking for something. Only populated once the pane has looked (the
// lookup is a network call), so a session that never opened it just reads "ready".
const providerSummary = computed(() => {
  const behind = upkeep.outdated.value.length;
  if (behind) return `${behind} update${behind === 1 ? "" : "s"}`;
  return readyEnabledCount.value ? `${readyEnabledCount.value} ready` : "";
});

// ── agents ───────────────────────────────────────────────────────────────────
// The row names who answers rather than counting the roster: with one agent a
// count says nothing, and even with eight the useful fact is which of them the
// composer is pointed at. No agent means the next turn goes to a guest, which is
// worth stating outright rather than leaving the row blank.
const { selected: selectedAgent } = useAgentRoster();
const agentSummary = computed(() => selectedAgent.value?.name ?? GUEST_LABEL);

function onSoundToggle() {
  toggleMuted();
  // If we just switched sound back on, confirm it with a soft cue (a no-op the
  // other way, since cues stay silent while muted).
  cue("toggle");
}

import type { SurfaceId } from "~/utils/surfaceTop";

// ── pane navigation ──────────────────────────────────────────────────────────
// Root lists the section groups; each detail pane is reached by tapping its row.
// The drawer always reopens at root so the user lands somewhere predictable.
//
// The pane lives in useSettingsSurface rather than here because the launcher
// slides aside by exactly this drawer's width, and most panes are pages rather
// than a column — so the stage upstream has to know which pane is open to know
// how far to move.
const { pane, isPage, revealWidth } = useSettingsSurface();

// Any pane built on SettingsPageShell owns its own frame — padding, scroll smoke,
// the lot — so the aside must not pad it a second time. That's every page. Only
// the root list (and the strip pane) let the aside do the padding and the edge smoke.
const shellFramed = computed(() => isPage.value);

// The narrow column (the root list) scrolls the aside itself. It smokes its
// top/bottom edges exactly like the pages do rather than showing a scrollbar.
// Shell-framed panes manage their own inner smoke and are overflow-hidden here,
// so the mask only rides the column state.
const drawerScroll = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(drawerScroll);
const asideStyle = computed(() =>
  shellFramed.value
    ? { width: `${revealWidth.value}px` }
    : { width: `${revealWidth.value}px`, ...maskStyle.value },
);
watch(pane, () => void nextTick(measure));

function openSection(target: SettingsPane) {
  pane.value = target;
  cue("press");
}

// ── the root list ────────────────────────────────────────────────────────────
// Rows as data: each names the pane it opens, the glyph that acts it out, and
// the one fact (if any) worth reading without opening it. The order within a
// group is deliberate —
//   · Personalization runs from hands (keys) to eyes (strip, turns, theme, type).
//   · Ecosystem puts the people before the machinery: which agent answers is a
//     bigger choice than which CLI carries them. Sub-agents sit under Agents
//     (a standing definition an agent invokes, not a CLI it runs on); Workspace
//     sits above Providers because it's the choice you make most.
type RootRow = {
  pane: SettingsPane;
  label: string;
  glyph: SettingsGlyphKind;
  /** Trailing summary, muted. */
  summary?: string;
  /** Draws the summary as something asking for attention rather than a fact. */
  alert?: boolean;
};

const groups = computed<{ title: string; rows: RootRow[] }[]>(() => [
  {
    title: "Personalization",
    rows: [
      { pane: "shortcuts", label: "Keyboard shortcuts", glyph: "shortcuts" },
      { pane: "motion", label: "Thread strip", glyph: "strip", summary: currentCenterOption.value },
      { pane: "conversation", label: "Conversation", glyph: "conversation" },
      { pane: "appearance", label: "Appearance", glyph: "appearance" },
      { pane: "typography", label: "Typography", glyph: "typography" },
    ],
  },
  {
    title: "Ecosystem",
    rows: [
      { pane: "agentRoster", label: "Agents", glyph: "agents", summary: agentSummary.value },
      { pane: "agentPresets", label: "Sub-agents", glyph: "subagents" },
      { pane: "studio", label: "Workspace", glyph: "workspace" },
      {
        pane: "providers",
        label: "Providers",
        glyph: "providers",
        summary: providerSummary.value,
        alert: upkeep.outdated.value.length > 0,
      },
      { pane: "agentSkills", label: "Skills", glyph: "skills" },
      { pane: "agentsUsage", label: "Usage", glyph: "usage" },
      { pane: "providerLimits", label: "Provider limits", glyph: "limits" },
    ],
  },
]);

// Each row's place in the whole list, for the entrance stagger. The hero card
// is 0, so the first row enters just behind it, and the foot takes the beat
// after the last row, so adding a row can't leave it entering early.
const stagger = computed(() => {
  const at = new Map<SettingsPane, number>();
  let i = 1;
  for (const g of groups.value) {
    i += 0.5; // a beat for the group's heading
    for (const r of g.rows) at.set(r.pane, i++);
  }
  return { at, foot: i };
});
const rowIndex = computed(() => stagger.value.at);

// ── the travelling highlight ─────────────────────────────────────────────────
// One wash for the whole list, not one per row. It slides from row to row
// under the pointer (or the focus), so running down the list reads as one
// continuous movement. Leaving the list lets it fade where it stands.
const hot = ref<SettingsPane | null>(null);
const listEl = ref<HTMLElement>();
const glow = ref({ y: 0, h: 0, shown: false, instant: true });

function light(target: SettingsPane, row: EventTarget | null) {
  hot.value = target;
  const list = listEl.value;
  if (!(row instanceof HTMLElement) || !list) return;
  const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  // Arriving from nowhere, it appears in place; only a move between rows slides.
  const instant = !glow.value.shown;
  glow.value = { y: top, h: row.offsetHeight, shown: true, instant };
  if (instant) requestAnimationFrame(() => (glow.value = { ...glow.value, instant: false }));
}

// Focus moving row to row passes through focusout; only leaving the list counts.
function onListFocusOut(e: FocusEvent) {
  const next = e.relatedTarget;
  if (!(next instanceof Node) || !listEl.value?.contains(next)) unlight();
}

function unlight() {
  hot.value = null;
  glow.value = { ...glow.value, shown: false };
}

const glowStyle = computed(() => ({
  transform: `translateY(${glow.value.y}px)`,
  height: `${glow.value.h}px`,
  opacity: glow.value.shown ? 1 : 0,
  transition: glow.value.instant ? "opacity 160ms ease" : undefined,
}));

// Every open remounts the root list, so the stagger and the glyphs' draw-in
// play each time the drawer is revealed rather than only the first time.
const openEpoch = ref(0);

function backToRoot() {
  pane.value = "root";
  cue("toggle");
}

// Esc is a natural "up": from a detail pane → back to root; from root → close.
// A rebind capture on the shortcuts page owns Esc first (capture-phase listener
// there), so one Esc leaves capture and a second walks back. And the drawer
// only answers while it is the topmost surface — a portal or a modal standing
// over it owns the press instead, so one Esc never dismisses two layers.
function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (props.surfaceTop !== "settings") return;
  e.preventDefault();
  if (pane.value !== "root") {
    backToRoot();
    return;
  }
  emit("close");
}
onMounted(() => {
  resolveProfile();
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// Always reopen at the top level.
watch(
  () => props.open,
  (open) => {
    if (!open) pane.value = "root";
    else openEpoch.value++;
    unlight();
  },
);
</script>

<template>
  <aside
    ref="drawerScroll"
    class="settings-scroll fixed inset-y-0 left-0 z-0 flex flex-col bg-sunken"
    :class="[
      shellFramed ? 'overflow-hidden' : 'overflow-y-auto px-5 pt-5 pb-7',
      { 'is-asleep': !open },
    ]"
    :style="asideStyle"
    :aria-hidden="!open"
    @scroll.passive="measure"
    role="dialog"
    aria-label="Settings and personalization"
  >
    <!-- Providers is a page, not a column: it takes the whole widened
         aside and lays itself out (masthead, rail, panel). The width change is
         deliberately not animated here — the stage sliding over the top of this
         panel is what uncovers it, so animating both would be two springs
         racing to describe one movement. -->
    <SettingsProfilePane v-if="pane === 'profile'" :open="open" @back="backToRoot" />

    <SettingsShortcutsPane v-if="pane === 'shortcuts'" :open="open" @back="backToRoot" />

    <SettingsAppearancePane v-if="pane === 'appearance'" :open="open" @back="backToRoot" />

    <SettingsTypographyPane v-if="pane === 'typography'" :open="open" @back="backToRoot" />

    <SettingsStudioPane v-if="pane === 'studio'" :open="open" @back="backToRoot" />

    <SettingsConversationPane v-if="pane === 'conversation'" :open="open" @back="backToRoot" />

    <SettingsProvidersPane v-if="pane === 'providers'" :open="open" @back="backToRoot" />

    <SettingsAgentsUsagePane v-if="pane === 'agentsUsage'" :open="open" @back="backToRoot" />

    <SettingsProviderLimitsPane v-if="pane === 'providerLimits'" :open="open" @back="backToRoot" />

    <SettingsAgentSkillsPane v-if="pane === 'agentSkills'" :open="open" @back="backToRoot" />

    <SettingsAgentsPane v-if="pane === 'agentRoster'" :open="open" @back="backToRoot" />

    <SettingsSubagentsPane v-if="pane === 'agentPresets'" :open="open" @back="backToRoot" />

    <!-- Root list (and Thread strip, which still mounts from here). Pages above
         take the widened aside themselves. -->
    <div
      v-if="pane === 'root' || pane === 'motion'"
      class="grid min-h-0 flex-1 content-start"
    >
      <!-- Root pane: the identity card, then the section groups. One wash
           travels between the rows instead of each row lighting its own. -->
      <section
        v-if="pane === 'root'"
        :key="`root-${openEpoch}`"
        ref="listEl"
        class="root col-start-1 row-start-1 relative flex flex-col gap-6"
        aria-label="Settings"
        @pointerleave="unlight"
        @focusout="onListFocusOut"
      >
        <span class="glow" :style="glowStyle" aria-hidden="true" />

        <SettingsHero
          class="enter"
          style="--i: 0"
          :tabbable="open"
          @pointerenter="unlight"
          @focus="unlight"
          @open="openSection('profile')"
        />

        <div v-for="group in groups" :key="group.title" class="flex flex-col gap-0.5">
          <p
            class="group-title enter flex items-center gap-2.5 px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted"
            :style="{ '--i': (rowIndex.get(group.rows[0]!.pane) ?? 1) - 0.5 }"
          >
            {{ group.title }}
            <span class="rule" aria-hidden="true" />
          </p>

          <button
            v-for="row in group.rows"
            :key="row.pane"
            type="button"
            class="nav-row enter relative z-[1] flex w-full cursor-pointer items-center gap-3 rounded-[12px] py-1.5 pr-2.5 pl-1.5 text-left focus-visible:outline-none"
            :class="{ 'is-hot': hot === row.pane }"
            :style="{ '--i': rowIndex.get(row.pane) }"
            :tabindex="open ? 0 : -1"
            :aria-label="`Open ${row.label.toLowerCase()} settings`"
            @pointerenter="light(row.pane, $event.currentTarget)"
            @focus="light(row.pane, $event.currentTarget)"
            @click="openSection(row.pane)"
          >
            <SettingsGlyph
              :kind="row.glyph"
              :live="hot === row.pane"
              :style="{ '--row-delay': `${(rowIndex.get(row.pane) ?? 0) * 32}ms` }"
            />
            <span class="label min-w-0 flex-1 truncate text-[15px] leading-tight text-ink">
              {{ row.label }}
            </span>
            <span
              v-if="row.summary"
              class="summary shrink-0 max-w-[42%] truncate text-[12px] leading-tight"
              :class="row.alert ? 'summary--alert' : 'text-muted'"
            >
              <i v-if="row.alert" class="beacon" aria-hidden="true" />
              {{ row.summary }}
            </span>
            <svg class="chev" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
          </button>
        </div>
      </section>

      <SettingsThreadStripPane v-else-if="pane === 'motion'" :open="open" @back="backToRoot" />

    </div>

    <!-- Controls sit at the foot of the panel. Sound is the first. Only the
         switch itself toggles — the label and icon are inert. It lives on the
         root pane only; a detail pane fills the panel. The speaker is drawn:
         its waves ripple out when sound is on and fold into a cross when off. -->
    <div
      v-if="pane === 'root'"
      :key="`foot-${openEpoch}`"
      class="foot enter mt-auto flex items-center justify-between gap-4 pt-6 pl-1.5"
      :style="{ '--i': stagger.foot }"
    >
      <span class="flex items-center gap-3">
        <span class="speaker" :class="{ 'speaker--muted': muted }" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path class="cone" d="M4 9.5h3l4.5-4v13L7 14.5H4z" />
            <path class="wave w1" d="M15 9.5a3.5 3.5 0 0 1 0 5" />
            <path class="wave w2" d="M17.5 7a7 7 0 0 1 0 10" />
            <path class="x" d="M16 10l4 4M20 10l-4 4" />
          </svg>
        </span>
        <span class="text-[15px] leading-tight text-ink">Interaction sounds</span>
      </span>

      <!-- Track + knob. On (audible) fills with ink; off rests quiet. -->
      <button
        type="button"
        role="switch"
        aria-label="Interaction sounds"
        :aria-checked="!muted"
        :tabindex="open ? 0 : -1"
        class="switch relative inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-none"
        :style="{
          backgroundColor: muted
            ? 'color-mix(in srgb, var(--ink) 14%, transparent)'
            : 'var(--ink)',
        }"
        @click="onSoundToggle"
      >
        <span class="knob absolute size-[16px] rounded-full bg-ground" :class="{ 'knob--on': !muted }" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* No visible bar — the drawer column smokes its top/bottom edges (mask bound from
   useEdgeFade) exactly like the settings pages, so the root list fades out of
   view instead of hard-cutting under a scrollbar. */
.settings-scroll {
  scrollbar-width: none;
}
.settings-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* Closed, the drawer stays mounted under the stage and keeps the root list up,
   so everything in it that loops (the hero's contours and orbit, a beacon, the
   speaker's waves) holds still until the drawer is revealed again. */
.settings-scroll.is-asleep :deep(*),
.settings-scroll.is-asleep :deep(*)::after {
  animation-play-state: paused !important;
}

/* The thread-strip options fade colour and hover-wash at the same soft pace the
   rest of the drawer's rows use — colour carries the active state (no weight to
   lean on), so the transition is on colour and background only. */
.center-opt {
  transition:
    color 0.18s ease,
    background-color 0.18s ease;
}

/* ── entrance ───────────────────────────────────────────────────────────────
   Every piece of the root list rises in on its own beat (--i), so opening the
   drawer reads as the list being dealt out rather than switched on. */
.enter {
  animation: deal 560ms cubic-bezier(0.22, 1, 0.36, 1) calc(var(--i, 0) * 32ms + 60ms) backwards;
}
@keyframes deal {
  from {
    opacity: 0;
    transform: translate(-14px, 6px);
    filter: blur(3px);
  }
}

/* A group's heading trails a hairline that draws out to the edge. */
.group-title .rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--ink) 12%, transparent), transparent);
  transform-origin: left;
  animation: rule 800ms cubic-bezier(0.22, 1, 0.36, 1) calc(var(--i, 0) * 32ms + 200ms) both;
}
@keyframes rule {
  from {
    transform: scaleX(0);
  }
}

/* ── the travelling wash ──────────────────────────────────────────────────── */
.glow {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 0;
  border-radius: 12px;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 9%, transparent),
    color-mix(in srgb, var(--ink) 4%, transparent) 70%
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 5%, transparent);
  transition:
    transform 420ms cubic-bezier(0.3, 1.35, 0.5, 1),
    height 420ms cubic-bezier(0.3, 1.35, 0.5, 1),
    opacity 200ms ease;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
.nav-row .label {
  transition: transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.nav-row.is-hot .label {
  transform: translateX(2px);
}
.nav-row:active .label {
  transform: translateX(4px);
}
.chev {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  margin-left: -4px;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transform: translateX(-6px);
  transition:
    opacity 180ms ease,
    transform 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.nav-row.is-hot .chev {
  opacity: 1;
  transform: none;
}

/* A summary that wants something (an update waiting) wears the accent and a
   beacon that pings, so it's findable from across the list. */
.summary--alert {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-weight: 500;
}
.beacon {
  position: relative;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}
.beacon::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--accent);
  animation: ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes ping {
  75%,
  100% {
    transform: scale(2.6);
    opacity: 0;
  }
}

/* ── sound ────────────────────────────────────────────────────────────────── */
.speaker {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--ink-soft);
}
.speaker svg {
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.speaker svg * {
  transform-box: fill-box;
  transform-origin: left center;
}
.speaker .cone {
  fill: color-mix(in srgb, currentColor 16%, transparent);
}
.speaker .wave {
  transition:
    transform 360ms cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 200ms ease;
  animation: broadcast 2.4s ease-in-out infinite;
}
.speaker .w2 {
  animation-delay: 220ms;
}
@keyframes broadcast {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.speaker .x {
  stroke: var(--muted);
  transform-origin: center;
  transform: scale(0) rotate(-90deg);
  transition: transform 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.speaker--muted .wave {
  animation: none;
  opacity: 0;
  transform: scale(0.2);
}
.speaker--muted .x {
  transform: none;
}

/* The knob rides the sunken surface; a hairline keeps it legible in both themes
   without a heavy shadow. It springs across and stretches on the way. */
.switch .knob {
  left: 0;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
  transform: translateX(2px);
  transition: transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.switch .knob--on {
  transform: translateX(16px);
}
.switch:active .knob {
  transform: translateX(2px) scaleX(1.25);
  transform-origin: left;
}
.switch:active .knob--on {
  transform: translateX(16px) scaleX(1.25);
  transform-origin: right;
}
/* Keyboard focus gets the same ring the pages use — the switch's hit target is
   small, so a pointer user leans on the fill, a keyboard user on this. */
.switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The root list rows navigate on click; the travelling wash answers the pointer,
   but a keyboard user needs a ring — the same one the pages and shortcut chips wear. */
.nav-row:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .enter,
  .group-title .rule,
  .beacon::after,
  .speaker .wave {
    animation: none;
  }
  .glow,
  .nav-row .label,
  .chev,
  .switch .knob {
    transition: none;
  }
}
</style>
