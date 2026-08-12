<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  usePreferredReducedMotion,
  useIntervalFn,
  useWindowSize,
} from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { PauseIcon, PlayIcon, ReplayIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import {
  CENTER_MODES,
  JOINT_PX,
  LADDER_PX,
  columnLeftFor,
  columnsInView,
  maxScrollFor,
  MIN_ANIMATED_PX,
  planeWidthFor,
  resolveScrollTarget,
  VISIBILITY_EPS,
  type CenterMode,
} from "~/utils/stripScroll";

// The thread strip's scroll-feel page. One setting today — niri's
// center-focused-column — but the choice is genuinely hard to describe in a
// sentence, because what each mode does depends on where the strip already sits
// and on how much of it your window can show at once. So the page doesn't
// describe it: it runs it. Every option carries a live miniature of the strip, and
// all three miniatures are driven by the *same* focus changes at the same time, so
// the difference between the modes is the only thing moving on the page.
//
// Two things make the miniatures trustworthy rather than decorative:
//
//   1. They aren't animations. Each one calls `resolveScrollTarget` — the very
//      function the board calls — over a modelled plane built by that module's own
//      `columnLeftFor` / `planeWidthFor`. Same branches, same constants, same
//      clamps, no copy to drift. The columns you see are *positioned* by those
//      functions too, so the picture and the maths can't disagree.
//   2. The viewport they run against is this window. The board is full-bleed — the
//      rail is `width: 100%` of a layer with no horizontal padding, so its
//      `clientWidth` is the window's inner width — which means the page can predict
//      what these settings will do on the display you're actually sitting at,
//      including the cases where two of them do nothing different at all.
//
// That second point carries most of the honesty here. `on-overflow` can only
// differ from `always` when a column is able to sit fully in view without
// scrolling; below two columns' worth of width it has no room to hold, and the two
// settings become the same setting. Rather than let the page imply a distinction
// the user's window can't deliver, it runs a dry lap and folds the finding into the
// one line under the title.
//
// The page carries almost no prose, and that's the design rather than an omission.
// A sentence explaining a mode would be a slower, vaguer version of the caption
// already sitting on that row — which names what the strip just did and how far it
// moved — so the modes' written descriptions go to assistive technology as the
// radio's accessible label and stay off the screen. What's visible is a title, one
// line of measured fact, three rows that demonstrate themselves, and the transport
// that drives them.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

// The preview scroller carries the shared edge-fade smoke, not a visible bar, so
// it matches every other settings page (see useEdgeFade).
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

const { cue } = useSound();
const { centerMode } = useStripPrefs();

// ── the modelled strip ────────────────────────────────────────────────────────
// Five columns at the default rung. Five is enough for the strip to overflow at
// any window width while still fitting as a legible miniature, and the default
// rung is what a new column actually opens at.
const COUNT = 5;
const COLUMN = LADDER_PX[0];

const { width: windowWidth } = useWindowSize();
/** The rail's viewport. See the note above on why this is the window's own width.
 *  Floored well below any real window so a hidden or freshly-mounted layer can't
 *  divide the geometry by something near zero. */
const viewport = computed(() => Math.max(320, Math.round(windowWidth.value)));
const planeWidth = computed(() => planeWidthFor(COUNT, COLUMN));
const fitCount = computed(() => columnsInView(viewport.value, COLUMN));

// The stage isn't the viewport here — if it were, a line drawn at either edge
// would just trace the clip and show nothing. Instead the viewport is a centered
// *window* that takes part of the stage, and the strip runs past it on both sides,
// so a column is visibly outside the window (not yet viewable) before it crosses a
// guide in. `VIEWPORT_SHARE` is how much of the stage the window claims; the rest
// is context to measure the crossing against. The focused column still centres
// inside the window (offsetStyle compensates for the window's position), so the
// picture stays the board's own geometry.
const VIEWPORT_SHARE = 0.62;
const stageModel = computed(() => viewport.value / VIEWPORT_SHARE);
/** How far the window's left edge sits from the stage's left, in model px. */
const guideOffset = computed(() => (stageModel.value - viewport.value) / 2);

/** One column's decision, for one mode, from one scroll position. Everything the
 *  page shows is derived from this — the captions, the positions, and the dry lap
 *  that decides whether two modes are worth telling apart. */
interface Step {
  /** Where the rail ends up. */
  scroll: number;
  /** What it did, in the strip's own vocabulary. */
  verb: "held" | "nudged" | "centered" | "recentered";
  /** How far it travelled. Kept numeric-or-nothing so the three verdicts stack
   *  into one column of comparable figures; the reason it held is carried by the
   *  verb, not spelled out again in prose. */
  delta: string;
  /** Signature for comparing two modes' behaviour over a whole lap. */
  sig: string;
}

function step(mode: CenterMode, index: number, from: number): Step {
  const vp = viewport.value;
  const left = columnLeftFor(index, COLUMN);
  const target = resolveScrollTarget({
    mode,
    left,
    width: COLUMN,
    viewport: vp,
    scrollLeft: from,
    maxScroll: maxScrollFor(mode, COUNT, COLUMN, vp),
  });

  // Whether the column was *already* fully in view is a fact about the strip, not
  // about the mode — which is what makes it the fair basis for the captions. It's
  // the difference between `always` doing necessary work and `always` moving the
  // world for nothing, and it's the only way the page can say "recentered" and mean
  // something by it.
  const wasVisible =
    left >= from - VISIBILITY_EPS && left + COLUMN <= from + vp + VISIBILITY_EPS;

  if (target === null) return { scroll: from, verb: "held", delta: "—", sig: "held" };

  // The board declines to *animate* a move this small, and these rails glide, so a
  // caption reading "nudged +3px" would describe a scroll that never fires. Hold
  // the position as well as the verb: the rail genuinely doesn't move.
  const moved = Math.round(target - from);
  if (Math.abs(moved) < MIN_ANIMATED_PX)
    return { scroll: from, verb: "held", delta: "—", sig: "held" };

  // The distance is the honest number: how far the rail actually travelled. A
  // caption can't flatter a mode that moved the world when it didn't need to while
  // this is sitting next to it.
  const delta = `${moved > 0 ? "+" : "−"}${Math.abs(moved)}px`;
  const verb =
    mode === "never" ? "nudged" : mode === "on-overflow" ? "centered"
    : wasVisible ? "recentered" : "centered";
  return { scroll: target, verb, delta, sig: `${verb}${moved}` };
}

// ── the focus walk ────────────────────────────────────────────────────────────
// Out and back along the strip: column 2, 3, 4, 5, then home again. Chosen over a
// one-way sweep for two measured reasons. It's *periodic* — every mode ends a lap
// exactly where it started it, at every window width, so the loop repeats instead
// of quietly drifting into a second, different demo. And it's the walk that makes
// the modes disagree most: on a wide window all three do something different on
// every one of its eight steps, and it's the return leg that exposes it, because
// coming back is when `never` and `on-overflow` find the column already in view.
const WALK = [1, 2, 3, 4, 3, 2, 1, 0] as const;

const scrollOf = reactive<Record<CenterMode, number>>({
  "never": 0,
  "on-overflow": 0,
  "always": 0,
});
const stepOf = reactive<Record<CenterMode, Step>>({
  "never": { scroll: 0, verb: "held", delta: "—", sig: "" },
  "on-overflow": { scroll: 0, verb: "held", delta: "—", sig: "" },
  "always": { scroll: 0, verb: "held", delta: "—", sig: "" },
});
const focused = ref(0);
const cursor = ref(0);

function focusColumn(index: number) {
  focused.value = index;
  for (const meta of CENTER_MODES) {
    const next = step(meta.value, index, scrollOf[meta.value]);
    stepOf[meta.value] = next;
    scrollOf[meta.value] = next.scroll;
  }
}

function advance() {
  const next = WALK[cursor.value % WALK.length]!;
  cursor.value += 1;
  focusColumn(next);
}

/** Whether this frame is worth looking at: the modes have to be visibly doing
 *  different things, or the page is three identical pictures. */
function framesDisagree() {
  const verbs = new Set(CENTER_MODES.map((m) => stepOf[m.value].verb));
  if (verbs.size > 1) return true;
  const positions = CENTER_MODES.map((m) => scrollOf[m.value]);
  return Math.max(...positions) - Math.min(...positions) > JOINT_PX;
}

/** Open on a frame that already shows the disagreement. At rest on the first
 *  column every mode agrees that nothing needs to move, so a page seeded there
 *  opens on three identical strips and reads as though it were repeating itself.
 *  Walking forward to the first interesting frame — rather than animating into it
 *  on a timer — means the still picture is informative too, which is the whole
 *  case under a reduced-motion preference. */
function seed() {
  cursor.value = 0;
  for (const meta of CENTER_MODES) scrollOf[meta.value] = 0;
  focusColumn(0);
  for (let i = 0; i < WALK.length && !framesDisagree(); i += 1) advance();
}

function restart() {
  seed();
  cue("press");
}

seed();
// The geometry is a function of the window, so a resize invalidates every scroll
// position the lap has accumulated. Re-seed rather than carry them across.
watch(viewport, seed);

// ── what this window can actually show ────────────────────────────────────────
/** Run a full silent lap and collect each mode's behaviour, so the page can tell
 *  when two settings are indistinguishable *here* instead of asserting a
 *  difference the user's window is too narrow to deliver. Derived, not hardcoded:
 *  it compares the same `step` the visible simulation runs. */
const collapsed = computed(() => {
  const sigs = new Map<CenterMode, string>();
  for (const meta of CENTER_MODES) {
    let at = 0;
    const lap: string[] = [];
    for (const index of WALK) {
      const s = step(meta.value, index, at);
      at = s.scroll;
      lap.push(s.sig);
    }
    sigs.set(meta.value, lap.join("|"));
  }

  const anchored = sigs.get("never");
  const onOverflow = sigs.get("on-overflow");
  const always = sigs.get("always");
  if (anchored === onOverflow && onOverflow === always) return "all";
  if (onOverflow === always) return "centring";
  return null;
});

/** The page's one line of prose, and it earns its place by being measured rather
 *  than written: how much of the strip this window can hold, and — when a dry lap
 *  proves it — which of the three settings that width has flattened into each
 *  other. One line that upgrades itself into the finding, rather than a caption
 *  plus a separate notice saying the caption doesn't apply. */
const deck = computed(() => {
  const vp = viewport.value;
  if (collapsed.value === "all")
    return `A ${COLUMN}px column is wider than this ${vp}px window, so all three land in the same place.`;
  if (collapsed.value === "centring")
    return `Only one column fits this ${vp}px window, so “When needed” and “Always” behave identically here.`;
  return `${fitCount.value} of ${COUNT} columns fit this ${vp}px window.`;
});

// ── transport ─────────────────────────────────────────────────────────────────
// Auto-running motion is exactly what a reduced-motion preference is about, so it
// starts paused there — the control stays, the default just flips, and the seeded
// frame means a paused page still shows the difference. The walk also stops
// whenever the drawer isn't showing; nothing should animate behind a closed drawer.
const reduced = usePreferredReducedMotion();
const playing = ref(reduced.value !== "reduce");
const running = computed(() => props.open && playing.value);

const STEP_MS = 1600;
const walker = useIntervalFn(advance, STEP_MS, { immediate: false });

watch(
  running,
  (on) => {
    if (on) walker.resume();
    else walker.pause();
  },
  { immediate: true },
);

function toggleAuto() {
  playing.value = !playing.value;
  cue("press");
}

// Stepping by hand takes the wheel: the walk shouldn't yank the strip out from
// under someone driving it.
function pickColumn(index: number) {
  playing.value = false;
  if (index !== focused.value) focusColumn(index);
  cue("press");
}

// ── the setting ───────────────────────────────────────────────────────────────
function setCenterMode(mode: CenterMode) {
  if (centerMode.value === mode) return;
  centerMode.value = mode;
  cue("toggle");
}

// Roving focus, the way a native radiogroup behaves: arrows move the selection and
// the focus together. A modified arrow (⌘⌥← / → is the board's focus-thread chord)
// and any arrow while the drawer is shut must pass straight through — a radio that
// still holds focus mustn't swallow the app's shortcuts.
const radioEls = ref<HTMLElement[]>([]);
function setRadioEl(el: unknown, i: number) {
  if (el instanceof HTMLElement) radioEls.value[i] = el;
}

function onKeydown(e: KeyboardEvent, i: number) {
  if (!props.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    const option = CENTER_MODES[i];
    if (option) setCenterMode(option.value);
    return;
  }

  const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
  const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
  if (!forward && !back) return;
  e.preventDefault();
  const next = (i + (forward ? 1 : -1) + CENTER_MODES.length) % CENTER_MODES.length;
  const option = CENTER_MODES[next];
  if (!option) return;
  setCenterMode(option.value);
  radioEls.value[next]?.focus();
}

// ── drawing the miniature ─────────────────────────────────────────────────────
// The stage holds a centered *window* (the viewport) plus a little strip context on
// each side; the plane is laid out inside it at stage-relative percentages, and the
// window's edges — not the stage's clip — are what a column crosses to enter or
// leave view, so `never`'s peek sliver is the real 24px at the window edge. Every
// number below comes out of the geometry functions, so the picture is drawn from
// the same source as the behaviour rather than eyeballed to match it.
const pct = (n: number) => `${Math.round(n * 1e6) / 1e4}%`;

const railStyle = computed(() => ({
  width: pct(planeWidth.value / stageModel.value),
}));

const columns = computed(() =>
  Array.from({ length: COUNT }, (_, i) => ({
    n: i + 1,
    style: {
      left: pct(columnLeftFor(i, COLUMN) / planeWidth.value),
      width: pct(COLUMN / planeWidth.value),
    },
  })),
);

function offsetStyle(mode: CenterMode) {
  // Translate the rail by (guideOffset − scroll): the extra guideOffset parks the
  // window's centre where the viewport's centre belongs, so a column that the rule
  // centres ends up centred inside the window, not in the stage.
  return { transform: `translateX(${pct((guideOffset.value - scrollOf[mode]) / planeWidth.value)})` };
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Thread strip"
    label="Thread strip settings"
    :scroll="false"
    @back="emit('back')"
  >
    <div class="ts">
      <!-- Auto margins rather than `justify-content`: the three rows sit optically
           centred in whatever height the drawer has, and when there isn't enough the
           margins resolve to nothing and it scrolls from the top instead of clipping
           its first row out of reach. -->
      <div
        ref="scroller"
        class="pp__scroll"
        :style="maskStyle"
        @scroll.passive="measure"
      >
        <div class="pp__opts" role="radiogroup" aria-label="Center focused column">
        <div
          v-for="(opt, i) in CENTER_MODES"
          :key="opt.value"
          :ref="(el) => setRadioEl(el, i)"
          role="radio"
          class="pp__opt"
          :class="{ 'pp__opt--on': centerMode === opt.value }"
          :aria-checked="centerMode === opt.value"
          :tabindex="open ? (centerMode === opt.value ? 0 : -1) : -1"
          :aria-label="`${opt.label} — ${opt.description}`"
          @click="setCenterMode(opt.value)"
          @keydown="onKeydown($event, i)"
        >
          <div class="pp__head">
            <span class="pp__label">{{ opt.label }}</span>
            <HugeiconsIcon
              v-if="centerMode === opt.value"
              :icon="Tick02Icon"
              :size="13"
              :stroke-width="2"
              class="pp__tick"
              aria-hidden="true"
            />
            <!-- The outcome sits on the label's line, hard right, so the three
                 verdicts stack into one column of numbers. Comparing a column of
                 tabular distances is instant; comparing three sentences isn't. -->
            <span class="pp__verdict">
              <span
                class="pp__verb"
                :class="{ 'pp__verb--held': stepOf[opt.value].verb === 'held' }"
                >{{ stepOf[opt.value].verb }}</span
              >
              <span class="pp__delta">{{ stepOf[opt.value].delta }}</span>
            </span>
          </div>

          <!-- A rule with columns standing on it, not a card with boxes inside it.
               The rule runs the full width of the frame and stops where the frame
               does, so the clip at either end reads as the edge of your window. -->
          <div class="pp__stage" aria-hidden="true">
            <div class="pp__rail" :style="[railStyle, offsetStyle(opt.value)]">
              <i
                v-for="c in columns"
                :key="c.n"
                class="pp__col"
                :class="{ 'pp__col--on': focused === c.n - 1 }"
                :style="c.style"
              >
                <!-- A pane is a title over a body, so the miniature is too: a head
                     strip carrying the number where the board puts the title, then
                     the tall body below it. That internal hairline is what stops
                     these reading as a stack of chips. -->
                <span class="pp__col-head"><span class="pp__n">{{ c.n }}</span></span>
                <span class="pp__col-body" aria-hidden="true"></span>
              </i>
            </div>
            <!-- The window: a faint band for the viewable area, framed by a guide
                 at each edge — where the viewable area starts and ends. The strip
                 runs past both guides, so a column half in, half out is visibly
                 crossing a line, and the midpoint of the window is the aim the
                 centring modes go for. -->
            <i
              class="pp__window"
              aria-hidden="true"
              :style="{
                left: pct(guideOffset / stageModel),
                width: pct(viewport / stageModel),
              }"
            />
            <i
              class="pp__guide pp__guide--l"
              aria-hidden="true"
              :style="{ left: pct(guideOffset / stageModel) }"
            />
            <i
              class="pp__guide pp__guide--r"
              aria-hidden="true"
              :style="{ right: pct(guideOffset / stageModel) }"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- One transport, at the foot of the three things it drives. The numerals are
         the strip's columns: press one to send all three rails after it. -->
    <footer class="pp__transport">
      <div class="pp__pips">
        <button
          v-for="n in COUNT"
          :key="n"
          type="button"
          class="pp__pip"
          :class="{ 'pp__pip--on': focused === n - 1 }"
          :tabindex="open ? 0 : -1"
          :aria-pressed="focused === n - 1"
          :aria-label="`Focus column ${n}`"
          @click="pickColumn(n - 1)"
        >
          {{ n }}
        </button>
      </div>
      <div class="pp__actions">
        <button
          type="button"
          class="pp__btn"
          :tabindex="open ? 0 : -1"
          :aria-pressed="playing"
          :aria-label="playing ? 'Pause the preview' : 'Play the preview'"
          :title="playing ? 'Pause' : 'Play'"
          @click="toggleAuto"
        >
          <HugeiconsIcon
            :icon="playing ? PauseIcon : PlayIcon"
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="pp__btn"
          :tabindex="open ? 0 : -1"
          aria-label="Restart the preview"
          title="Restart"
          @click="restart"
        >
          <HugeiconsIcon
            :icon="ReplayIcon"
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
      </div>
    </footer>
    </div>

    <!-- The page's one line of prose, at the foot where the measured fact lives —
         the setting's name, then what this window can actually show. -->
    <template #foot>Center focused column — {{ deck }}</template>
  </SettingsPageShell>
</template>

<style scoped>
/* Same motion vocabulary as the providers page and the git space: things that
   arrive decelerate, things that move in place ease at both ends. */
/* Every child pads itself back out to the page's measure, so rows can take their
   hover wash right out to the gutter (the shell supplies the 1.5rem outer). The
   token vocabulary the interior draws on lives here — the same shape the git space
   and the providers page use. */
.ts {
  --pp-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --pp-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --pp-t-micro: 140ms;
  --pp-t-small: 220ms;
  --pp-t-enter: 320ms;
  --pp-t-scroll: 560ms;
  /* One slab recipe, resolved once: the neutral column and the accent it becomes on
     the row that's live, so a change of temperature is a change in one place. */
  --pp-slab: color-mix(in srgb, var(--ink) 13%, transparent);
  --pp-slab-live: color-mix(in srgb, var(--accent) 22%, transparent);
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

@keyframes pp-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── the three rows ───────────────────────────────────────────────────────── */
/* No visible bar — the edge-fade smoke (bound from useEdgeFade) stands in for it,
   the same as every other settings page. */
.pp__scroll {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: clip;
  scrollbar-width: none;
}
.pp__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pp__opts {
  display: flex;
  flex-direction: column;
  gap: clamp(2px, 1.4vh, 16px);
  /* Centres the comparison in the drawer's height when there's room, and gives way
     when there isn't. */
  margin-block: auto;
  padding-block: 1.5rem;
}
/* Borderless rows: the hover wash and the label's colour carry the state, the way
   the drawer's lists do. */
.pp__opt {
  display: flex;
  flex-direction: column;
  padding: 13px 1rem 15px;
  border-radius: 16px;
  cursor: pointer;
  transition: background-color var(--pp-t-micro) ease;
}
.pp__opt:hover {
  background-color: var(--hover);
}
.pp__opt:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.pp__head {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
/* Geist ships at one weight, so the selected option is marked in colour and by the
   tick — never by a heavier face, which would silently render as regular. */
.pp__label {
  font-size: 15px;
  letter-spacing: -0.1px;
  line-height: 1.2;
  color: var(--ink-soft);
  transition: color var(--pp-t-micro) ease;
}
.pp__opt--on .pp__label {
  color: var(--ink);
}
.pp__tick {
  color: var(--accent);
  flex-shrink: 0;
  /* Baseline-aligned rows put an icon a shade high; nudge it onto the text's line. */
  transform: translateY(1px);
}

/* ── the verdict ──────────────────────────────────────────────────────────── */
/* What the strip just did, in the strip's own numbers. Mono and tabular because the
   distance changes on every step and mustn't shuffle the line. */
.pp__verdict {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-inline-start: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}
.pp__verb {
  color: var(--ink-soft);
  transition: color var(--pp-t-micro) ease;
}
/* Holding still is the absence of an event, so it reads quieter than a move. */
.pp__verb--held {
  color: var(--muted);
}
.pp__delta {
  min-width: 7ch;
  text-align: end;
  color: var(--muted);
}

/* ── the miniature strip ──────────────────────────────────────────────────── */
/* The frame is the rail's viewport. Everything inside is the plane, clipped by it.
   No fill and no radius: three filled panels stacked up read as three cards, and
   what's being compared is the *movement*, which a card frames rather than shows. */
.pp__stage {
  position: relative;
  /* Tall enough that a column reads as a pane (a title over a body) rather than a
     squat card, and keyed to the window's height so the ratio of miniature to the
     real strip's full-height columns holds as the drawer itself grows and shrinks. */
  height: clamp(116px, 17vh, 200px);
  margin-top: 14px;
  overflow: hidden;
}
/* The rule the columns stand on — and the only thing on the page that draws the
   frame, which it does by running the frame's full width and stopping dead at both
   ends. */
.pp__stage::after {
  content: "";
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 1px;
  background-color: color-mix(in srgb, var(--ink) 11%, transparent);
}
.pp__guide {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 1px;
  /* A window's edge: assertive where it meets the rule, thinning to almost
     nothing higher up so it can cross a column without defacing it. */
  background-image: linear-gradient(
    to top,
    color-mix(in srgb, var(--ink) 34%, transparent) 0 14px,
    color-mix(in srgb, var(--ink) 9%, transparent) 14px 100%
  );
}
/* The viewable area itself, faintly — just enough to separate what's inside the
   window from the context the strip runs past on either side, without competing
   with the columns that cross it. */
.pp__window {
  position: absolute;
  top: 0;
  bottom: 0;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
}
.pp__rail {
  position: absolute;
  inset-block: 12px 1px;
  inset-inline-start: 0;
  transition: transform var(--pp-t-scroll) var(--pp-ease-move);
}
/* Positioned, not flowed: every column's left edge is placed by the same
   `columnLeftFor` the scroll maths reads, so the picture and the behaviour are
   drawn from one source. Square at the foot, rounded at the head — a column
   standing on the rule rather than a chip floating over it. */
.pp__col {
  position: absolute;
  inset-block: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 7px 7px 2px 2px;
  background-color: var(--pp-slab);
  /* The board doesn't highlight the focused column — it recedes every other one:
     `opacity: .34`, `saturate(.7)`, `scale(.985)`. The miniature quotes that rule
     instead of inventing a mark of its own, with the opacity floor lifted because
     these slabs are washes rather than the opaque cards it was tuned against, and
     the desaturation dropped because there's no colour in a neutral slab to take
     out. (The accent ring is a different thing, and belongs to the overview zoom.) */
  opacity: 0.42;
  transform: scale(0.985);
  transition:
    background-color var(--pp-t-small) ease,
    opacity var(--pp-t-small) ease,
    transform var(--pp-t-small) ease;
}
.pp__col--on {
  opacity: 1;
  transform: none;
}
/* The accent is reserved for the setting that's actually live, so a glance at the
   page answers "which one am I on?" before it answers anything else — and the
   comparison survives being monochrome on two rows out of three, because what the
   rows differ in is where they've moved to, not what colour they are. */
.pp__opt--on .pp__col--on {
  background-color: var(--pp-slab-live);
}
/* The head is the pane's title bar: a short strip at the top, with the hairline
   beneath it marking where the title gives way to the body — the same seam the
   board's columns carry between head and body. */
.pp__col-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 7px 8px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
}
/* The body fills the pane below its title, like the thread it would be showing. */
.pp__col-body {
  flex: 1;
}
/* Sat at the head of the column, where a pane's title sits on the real board —
   which is also the only other thing the board brightens on focus. */
.pp__n {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: color-mix(in srgb, var(--ink) 45%, transparent);
  transition: color var(--pp-t-small) ease;
}
.pp__col--on .pp__n {
  color: var(--ink);
}
.pp__opt--on .pp__col--on .pp__n {
  color: var(--accent);
}

/* ── transport ────────────────────────────────────────────────────────────── */
.pp__transport {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  padding: 0.75rem 1rem 0;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) backwards;
  animation-delay: 80ms;
}
.pp__pips {
  display: flex;
  gap: 2px;
  margin-inline-start: -7px;
}
/* Numerals that point at a moving target, so tabular — the row mustn't reflow as
   the walk advances. */
.pp__pip {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--pp-t-micro) ease,
    color var(--pp-t-micro) ease;
}
.pp__pip:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.pp__pip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pp__pip--on {
  background-color: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}
.pp__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-inline-end: -6px;
}
/* The app's one button recipe: bare until hovered, then a soft pill — squared off
   here because these carry a glyph rather than a word. */
.pp__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  border-radius: 8px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color var(--pp-t-micro) ease;
}
.pp__btn:hover {
  background-color: var(--hover);
}
.pp__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The walk is opt-in under a reduced-motion preference (it starts paused), but if
   it's switched on, let the steps cut rather than glide. */
@media (prefers-reduced-motion: reduce) {
  .pp__transport {
    animation: none;
  }
  .pp__rail {
    transition: none;
  }
}
</style>
