<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";

// "Project Home" boards). Three lines: a constant "Hey, {you}" welcome, then a
// leans on agents + token counts we haven't built yet, so lines 2–3 here are
// rebuilt entirely from the git signals we already read for the folder + rail.
//
// Copy is assembled as tone-tagged segments so the mono +/− counts and branch
// names can sit inline with the sans prose, exactly like the board.

type Tone = "ink" | "muted" | "add" | "del" | "num";
interface Seg {
  t: string;
  tone: Tone;
}

const props = defineProps<{
  projectName: string;
  /** false until the first git read resolves — keeps lines 2–3 from flashing a
   *  stale "all clean" before the working tree is known. */
  loading: boolean;
  /** Whether the folder is a git repository at all. */
  repo: boolean;
  /** Whether the repo has any commits (false on a fresh, unborn branch). */
  hasCommits: boolean;
  branch: string | null;
  clean: boolean;
  added: number;
  removed: number;
  /** Files with any change (staged + unstaged + untracked). */
  fileCount: number;
  staged: number;
  ahead: number;
  behind: number;
  /** When set, the leading project name (segment 0) becomes a switcher trigger
   *  that opens the project switcher on click. */
  switchable?: boolean;
}>();

const emit = defineEmits<{ switch: []; profile: [] }>();

// Only the leading segment (the project name) is the switcher trigger.
const isTrigger = (i: number) => props.switchable && i === 0;

const { name, initial, image, avatarStyle, resolve } = useProfile();
onMounted(resolve);

// ── segment helpers ───────────────────────────────────────────────────────
const ink = (t: string): Seg => ({ t, tone: "ink" });
const mut = (t: string): Seg => ({ t, tone: "muted" });
const add = (t: string): Seg => ({ t, tone: "add" });
const del = (t: string): Seg => ({ t, tone: "del" });
const num = (t: string | number): Seg => ({ t: String(t), tone: "num" });

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// The +A −R pair, joined by a non-breaking space so the diffstat never splits
// across a line wrap.
function diffSegs(): Seg[] {
  const out: Seg[] = [];
  if (props.added > 0) out.push(add(`+${props.added}`));
  if (props.removed > 0) {
    if (out.length) out.push(mut(" "));
    out.push(del(`−${props.removed}`));
  }
  return out;
}

// Optional "on {branch}" tail, skipped on a detached / unborn HEAD.
function onBranch(): Seg[] {
  return props.branch ? [mut(" on "), num(props.branch)] : [];
}

const lines = computed<{ headline: Seg[]; subline: Seg[] }>(() => {
  const name = props.projectName;

  // While the first read is in flight, show just the project name — no subline
  // that could momentarily contradict the real state.
  if (props.loading) {
    return { headline: [ink(name)], subline: [] };
  }

  // A — not a git repository.
  if (!props.repo) {
    return {
      headline: [ink(name), mut(" isn't a git repository yet")],
      subline: [
        mut("Initialize a repo to track changes, then start your first session"),
      ],
    };
  }

  const n = props.fileCount;
  const s = props.staged;

  // B — a repository with no commits yet (unborn branch).
  if (!props.hasCommits) {
    if (props.clean) {
      return {
        headline: [ink(name), mut(" is a fresh repository")],
        subline: [
          mut("Nothing committed yet — your first changes will show up here"),
        ],
      };
    }
    const headline = [ink(name), mut(" is ready for its first commit")];
    const subline =
      s > 0
        ? [
            num(s),
            mut(" of "),
            num(n),
            mut(plural(n, " file staged", " files staged")),
            mut(" — commit when you're ready"),
          ]
        : [
            num(n),
            mut(plural(n, " file", " files")),
            mut(" to stage for your first commit"),
          ];
    return { headline, subline };
  }

  // C — commits on record, working tree clean.
  if (props.clean) {
    const headline = [ink(name), mut(" is ready when you are")];
    let subline: Seg[];
    if (props.ahead > 0 && props.behind > 0) {
      subline = [
        mut("Working tree clean — "),
        num(props.ahead),
        mut(" ahead, "),
        num(props.behind),
        mut(" behind"),
        ...onBranch(),
      ];
    } else if (props.ahead > 0) {
      subline = [
        mut("Working tree clean — you're "),
        num(props.ahead),
        mut(plural(props.ahead, " commit ahead", " commits ahead")),
        ...onBranch(),
      ];
    } else if (props.behind > 0) {
      subline = [
        mut("Working tree clean — "),
        num(props.behind),
        mut(plural(props.behind, " commit behind", " commits behind")),
        ...onBranch(),
        mut(", pull when you're ready"),
      ];
    } else {
      subline = [mut("No changes — everything's committed"), ...onBranch()];
    }
    return { headline, subline };
  }

  // D — commits on record, with uncommitted work (the everyday state).
  const headline = [
    ink(name),
    mut(" has "),
    num(n),
    mut(plural(n, " file with changes", " files with changes")),
  ];

  const diff = diffSegs();
  const subline: Seg[] =
    diff.length > 0
      ? [mut("You have "), ...diff, mut(" uncommitted")]
      : [mut("You have "), num(n), mut(plural(n, " uncommitted change", " uncommitted changes"))];

  if (n > 0) {
    if (s === n) subline.push(mut(", all staged"));
    else if (s > 0) subline.push(mut(", "), num(s), mut(" staged"));
    else subline.push(mut(" — nothing staged yet"));
  }

  return { headline, subline };
});

// The state message reads as continuing prose, not stacked rows: the headline
// and subline flow into one paragraph joined by a sentence break, then wrap
// naturally against the greeting's max-width.
const body = computed<Seg[]>(() => {
  const { headline, subline } = lines.value;
  return subline.length ? [...headline, mut(". "), ...subline] : headline;
});

// Per-word reveal: each segment splits into words and the whitespace between
// them. Words animate; whitespace stays plain text so the prose still wraps at
// word boundaries. The switcher trigger animates as one unit (the name + its
// chevron).
const WORD_SPLIT = /(\S+|\s+)/g;
const parts = computed(() =>
  body.value.map((seg) =>
    (seg.t.match(WORD_SPLIT) ?? []).map((t) => ({ t, word: /\S/.test(t) })),
  ),
);

// Segments are keyed by content plus which occurrence of that content they
// are — not by position — so a segment that survives an update keeps its
// element (and stays still) even when an earlier part of the sentence changes
// length. Only segments that are genuinely new mount, and so only they animate.
const keys = computed(() => {
  const seen = new Map<string, number>();
  return body.value.map((seg) => {
    const base = `${seg.tone}:${seg.t}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
});

// Page-entrance delay applies to the first reveal only, not to later updates.
const settled = ref(false);
watch(body, () => (settled.value = true), { once: true });

// The stagger counts only the words that are new in this render, so the first
// changed word goes immediately and the rest follow it in reading order. The
// TransitionGroup already knows which segments are new — it calls
// `onBeforeEnter` for exactly those — so they're collected as they mount and
// ranked together once the update's mounts are done (mount order isn't reading
// order, hence `data-at`).
let entering: HTMLElement[] = [];
function onBeforeEnter(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  if (!entering.length) queueMicrotask(rankEntering);
  entering.push(el);
}
function rankEntering(): void {
  const batch = entering.sort((a, b) => Number(a.dataset.at) - Number(b.dataset.at));
  entering = [];
  let rank = 0;
  for (const seg of batch) {
    const words = seg.classList.contains("word") ? [seg] : seg.querySelectorAll<HTMLElement>(".word");
    for (const w of words) w.style.setProperty("--w", String(rank++));
  }
}
</script>

<template>
  <div class="greet">
    <!-- Line 1 — the welcome. Constant across states. Laid out as a centered
         flex row so the avatar chip aligns to the text, not the baseline. -->
    <p class="line line--hey">
      <span class="t-muted">Hey,</span>
      <button
        v-if="name"
        type="button"
        class="who"
        :aria-label="`Open settings for ${name}`"
        @click="emit('profile')"
      >
        <span class="chip" :style="avatarStyle" aria-hidden="true">
          <template v-if="!image">{{ initial }}</template>
        </span>
        <span class="t-ink">{{ name }}</span>
      </button>
      <span v-else class="t-ink">there</span>
    </p>

    <!-- The state message — one continuous, wrapping paragraph. Words rise in
         one after another (per-word crossfade), so the sentence assembles
         itself. Keyed by content (see `keys`) so on an update only the
         segments that changed animate; everything else holds still. -->
    <TransitionGroup
      tag="p"
      name="seg"
      class="line line--body"
      :class="{ 'line--settled': settled }"
      appear
      @before-enter="onBeforeEnter"
    >
      <component
        :is="isTrigger(i) ? 'button' : 'span'"
        v-for="(seg, i) in body"
        :key="keys[i]"
        class="seg"
        :class="[`t-${seg.tone}`, { 'proj word': isTrigger(i) }]"
        :data-at="i"
        :type="isTrigger(i) ? 'button' : undefined"
        :aria-haspopup="isTrigger(i) ? 'menu' : undefined"
        @click="isTrigger(i) && emit('switch')"
      >
        <template v-if="isTrigger(i)">
          {{ seg.t }}
          <HugeiconsIcon
            :icon="ArrowDown01Icon"
            :size="15"
            :stroke-width="2.2"
            class="proj__chev"
            aria-hidden="true"
          />
        </template>
        <template v-for="(part, j) in parts[i] ?? []" v-else :key="j">
          <span v-if="part.word" class="word">{{
            part.t
          }}</span>
          <template v-else>{{ part.t }}</template>
        </template>
      </component>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.greet {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-sans);
}

/* The welcome line settles up into place on mount; the state message below
   brings its own per-word reveal, so it doesn't ride this rise too. */
.line--hey {
  animation: greet-rise 400ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: var(--proj-enter-greet, 0ms);
}

@keyframes greet-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Per-word crossfade — each word fades up 6px into place, 35ms after the one
   before it, on a long ease-out so the sentence settles quickly but calmly. Words are
   inline-block (transforms don't apply to inline boxes); the whitespace between
   them stays plain text, so the paragraph still wraps as prose. */
.word {
  display: inline-block;
  animation: word-in 420ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: calc(var(--proj-enter-greet, 0ms) + var(--w, 0) * 35ms);
}
.line--settled .word {
  animation-delay: calc(var(--w, 0) * 35ms);
}
@keyframes word-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
/* A segment that drops out (a state change) lifts away fast and without a
   stagger, so the line never holds a stale word over its replacement. */
.seg-leave-active {
  position: absolute;
  transition:
    opacity 120ms cubic-bezier(0.7, 0, 0.84, 0),
    transform 120ms cubic-bezier(0.7, 0, 0.84, 0);
}
.seg-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.line {
  margin: 0;
  line-height: 1.1;
  letter-spacing: -0.01em;
}
/* Welcome row: chip + words share one centered lane. Sized down to a quiet
   secondary line so the project-state headline below reads as the hero. */
.line--hey {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* State message: the hero — a large statement that wraps as flowing prose.
   Heading-tight leading, slightly negative tracking, measure capped ~60ch. */
.line--body {
  max-width: 620px;
  line-height: 1.25;
  letter-spacing: -0.02em;
  text-wrap: pretty;
}

/* Sans prose — 30px, semibold. */
.t-ink,
.t-muted {
  font-size: 30px;
  font-weight: 600;
}
.t-ink {
  color: var(--ink);
}
.t-muted {
  color: var(--ink-soft);
}

/* The switchable project name — the name + a chevron that sits inline in the
   sentence (so the prose still flows) but reads as touchable: a soft pill warms
   in on hover. The chevron is the affordance, so the name carries no underline.
   It inherits the family/metrics and lets .t-ink supply the 30px prose size,
   matching the surrounding headline. */
.seg.proj {
  /* inline-block, not inline-flex: an inline-block's baseline is the baseline of
     its own text ("kone"), so it lines up with the surrounding prose for free —
     where inline-flex reports the wrong baseline and drags the unit below the
     line. (A <button> ignores display:inline and scatters its children across
     lines, so inline-block is also what keeps icon + name + chevron together.) */
  display: inline-block;
  vertical-align: baseline;
  white-space: nowrap;
  /* Pull the pill's padding back out of the line so the name keeps its place in
     the sentence rather than shifting the following words right. */
  margin: 0 -4px;
  padding: 1px 5px;
  border: none;
  border-radius: 9px;
  background: transparent;
  font-family: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  color: var(--ink);
  cursor: pointer;
  transition: background-color 0.18s ease;
}
.seg.proj:hover {
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.seg.proj:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 1px;
}
/* The chevron is the sole affordance now — an inline SVG centred on the name.
   The explicit inline-block overrides the global `svg { display: block }` reset,
   which would otherwise drop it onto its own line inside the trigger. */
.proj__chev {
  display: inline-block;
  vertical-align: middle;
  margin-top: -0.1em;
  margin-left: 3px;
  color: var(--ink-soft);
  transition:
    color 0.2s ease,
    transform 0.2s ease;
}
.seg.proj:hover .proj__chev {
  color: var(--ink);
  transform: translateY(1px);
}

/* Mono figures — 26px, bold, baseline-aligned with the prose. Tabular so the
   counts don't reflow the line as they update between reads. */
.t-add,
.t-del,
.t-num {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.t-add {
  color: var(--diff-add);
}
.t-del {
  color: var(--diff-del);
}
.t-num {
  color: var(--ink);
}

/* The user is a button: chip + name in one lane, reading as touchable. A soft
   pill warms in on hover — the same borderless treatment the project-name
   switcher uses — but the margins are pulled back so it keeps its place beside
   "Hey," rather than shifting the line. */
.who {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin: -3px -7px;
  padding: 3px 7px;
  border: none;
  border-radius: 999px;
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: background-color 0.18s ease;
}
.who:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 1px;
}
.who .chip {
  transition: transform 0.18s ease;
}
.who:hover .chip {
  transform: scale(1.06);
}

/* Avatar chip — colour and photo come from useProfile(). */
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background-size: cover;
  background-position: center;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
}

/* Honour a reduced-motion preference: show the greeting settled, no rise, no
   word stagger. */
@media (prefers-reduced-motion: reduce) {
  .line--hey,
  .word {
    animation: none;
  }
  .seg-leave-active {
    transition: none;
  }
}
</style>
