<script setup lang="ts">
import { computed } from "vue";
import { CountUp } from "~/components/ui/count-up";
import type { ChangeItem } from "~/types/change";

// The file-changes block that heads the project rail. Splits the working tree
// into two lanes — Staged and Changed — each a ChangeLane with its own sweep
// (Unstage all / Stage all), and the Changed lane owns Discard (it only ever
// touches unstaged work). A compact header carries Commit + the diffstat
// summary. When the tree is clean it collapses to a quiet empty state.

const props = defineProps<{
  /** false until the first git read resolves — suppresses the "No changes"
   *  empty state (and the whole block) so nothing flashes before the working
   *  tree is known; the lanes then cascade in when data lands. */
  loading: boolean;
  /** false when the open folder isn't a git repo — swaps the clean empty state
   *  for the "not tracked yet" variant (no check badge, no branch pill). */
  repo: boolean;
  branch: string | null;
  added: number;
  removed: number;
  changes: ChangeItem[];
}>();

const emit = defineEmits<{
  stageAll: [];
  unstageAll: [];
  commit: [];
  discardPaths: [paths: string[]];
  open: [item: ChangeItem, rect: DOMRect];
}>();

const { cue } = useSound();

const total = computed(() => props.changes.length);
const staged = computed(() => props.changes.filter((c) => c.staged));
const unstaged = computed(() => props.changes.filter((c) => !c.staged));
const canCommit = computed(() => staged.value.length > 0);

// When both lanes share the panel they each get a single row (overflow → +N);
// a lone lane spreads to two rows before it packs.
const laneRows = computed(() =>
  staged.value.length && unstaged.value.length ? 1 : 2,
);

// One dot per file, coloured by what changed (not by staging). Matches the
// stretch the header (and the page) sideways — sample proportionally when
// there are more files than slots.
type DotTone = "add" | "del" | "idle";
const MAX_DOTS = 24;

function toneFor(c: ChangeItem): DotTone {
  if (c.deleted || c.removed > c.added) return "del";
  if (c.added > 0) return "add";
  return "idle";
}

function sampleDots(all: DotTone[], max: number): DotTone[] {
  if (all.length <= max) return all;

  const counts = { add: 0, del: 0, idle: 0 };
  for (const d of all) counts[d]++;

  let add = Math.round((max * counts.add) / all.length);
  let del = Math.round((max * counts.del) / all.length);
  let idle = max - add - del;

  if (counts.add > 0 && add === 0) {
    add = 1;
    idle = Math.max(0, idle - 1);
  }
  if (counts.del > 0 && del === 0) {
    del = 1;
    idle = Math.max(0, idle - 1);
  }
  if (counts.idle > 0 && idle === 0) {
    idle = 1;
    if (add > del && add > 1) add--;
    else if (del > 1) del--;
  }

  while (add + del + idle > max) {
    if (add >= del && add >= idle && add > 0) add--;
    else if (del >= idle && del > 0) del--;
    else if (idle > 0) idle--;
  }
  while (add + del + idle < max) {
    if (counts.add >= counts.del && counts.add >= counts.idle) add++;
    else if (counts.del >= counts.idle) del++;
    else idle++;
  }

  return [
    ...Array(add).fill("add"),
    ...Array(del).fill("del"),
    ...Array(idle).fill("idle"),
  ] as DotTone[];
}

const allDots = computed<DotTone[]>(() => props.changes.map(toneFor));
const dots = computed(() => sampleDots(allDots.value, MAX_DOTS));
const dotsOverflow = computed(() =>
  Math.max(0, allDots.value.length - dots.value.length),
);

// Changed-lane Discard — every unstaged change, staged work untouched.
function discardUnstaged() {
  cue("press");
  emit("discardPaths", unstaged.value.map((c) => c.path));
}
</script>

<template>
  <!-- Hold until the first git read resolves — render nothing so the block
       simply arrives with the data, no "No changes" flash on the way in. -->
  <template v-if="loading" />

  <!-- Empty state. A full-width status header crowns a centred three-sheet
       folder glyph. Two variants: a clean git tree (green check + branch), and a
       folder that isn't a repo yet (neutral, no check, no branch). -->
  <div v-else-if="total === 0" class="empty">
    <header class="empty__head">
      <span class="empty__clean">
        <svg v-if="repo" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" />
          <path d="M9 12l2 2 4-4" fill="none" />
        </svg>
        {{ repo ? "Working tree clean" : "Not a git repository" }}
      </span>
      <span class="empty__sync">{{ repo ? "up to date" : "not tracked" }}</span>
    </header>

    <div class="empty__stage">
      <div class="empty__glyph">
        <span class="empty__sheet empty__sheet--l">
          <i class="empty__dot" />
        </span>
        <span class="empty__sheet empty__sheet--r">
          <i class="empty__dot empty__dot--end" />
        </span>
        <span class="empty__sheet empty__sheet--front">
          <i class="empty__dash" />
        </span>
        <span v-if="repo" class="empty__check">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="#fff" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </div>
      <span class="empty__label">{{ repo ? "No changes" : "Not tracked yet" }}</span>
      <span v-if="repo && branch" class="empty__branch">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" fill="none" />
          <circle cx="6" cy="18" r="3" fill="none" />
          <path d="M18 9a9 9 0 0 1-9 9" fill="none" />
        </svg>
        {{ branch }}
      </span>
    </div>
  </div>

  <div v-else class="panel">
    <!-- Header is a right-aligned summary strip: Commit sits just left of the
         diffstat + dots. Discard lives down in the Changed section (it only ever
         touches unstaged work). -->
    <header class="ch">
      <span class="ch__meta">
        <button
          v-if="canCommit"
          type="button"
          class="ch__btn ch__btn--primary"
          @click="emit('commit')"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2.4" />
            <line x1="3" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            <line x1="15" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
          Commit
        </button>
        <span class="ch__diff">
          <span v-if="added > 0" class="ch__add">+<CountUp :to="added" :duration="1.1" /></span>
          <span v-if="removed > 0" class="ch__del">−<CountUp :to="removed" :duration="1.1" /></span>
        </span>
        <span class="ch__dots" :title="`${allDots.length} changed files`">
          <i v-for="(d, i) in dots" :key="i" class="ch__dot" :class="`ch__dot--${d}`" :style="{ '--i': i }" />
          <span v-if="dotsOverflow > 0" class="ch__dots-more">+{{ dotsOverflow }}</span>
        </span>
      </span>
    </header>

    <!-- The two lanes. Each only appears when it has something in it. -->
    <div class="lanes">
      <ChangeLane
        v-if="staged.length"
        title="Staged"
        tone="staged"
        :items="staged"
        :rows="laneRows"
        @sweep="emit('unstageAll')"
        @open="(item, rect) => emit('open', item, rect)"
      />
      <ChangeLane
        v-if="unstaged.length"
        title="Changed"
        tone="changed"
        :items="unstaged"
        :rows="laneRows"
        @sweep="emit('stageAll')"
        @discard-lane="discardUnstaged"
        @open="(item, rect) => emit('open', item, rect)"
      />
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
  max-width: 100%;
}
.lanes {
  display: flex;
  flex-direction: column;
  gap: 30px;
}

/* ── header ─────────────────────────────────────────────────────────────── */
@keyframes ch-header-in {
  from { opacity: 0; transform: translateY(9px); }
  to { opacity: 1; transform: none; }
}
.ch {
  animation: ch-header-in 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
  max-width: 100%;
}
.ch__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 14px;
  min-width: 0;
  max-width: 100%;
}
.ch__diff {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ch__add { color: var(--diff-add); }
.ch__del { color: var(--diff-del); }
.ch__dots {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
  min-width: 0;
  max-width: 100%;
}
.ch__dots-more {
  flex-shrink: 0;
  margin-left: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
}
@keyframes ch-dot-pop {
  from { opacity: 0; transform: scale(0.2); }
  to { opacity: 1; transform: scale(1); }
}
.ch__dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  animation: ch-dot-pop 340ms cubic-bezier(0.34, 1.45, 0.64, 1) backwards;
  animation-delay: calc(240ms + min(var(--i, 0) * 46ms, 620ms));
}
.ch__dot--add { background-color: var(--diff-add); }
.ch__dot--del { background-color: var(--diff-del); }
.ch__dot--idle { background-color: #d4d4d8; }

.ch__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color 0.16s ease, opacity 0.16s ease;
}
.ch__btn:hover { background-color: var(--hover); }
.ch__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.ch__btn--primary {
  background-color: var(--ink);
  color: var(--ground);
}
.ch__btn--primary:hover { background-color: var(--ink); opacity: 0.88; }
/* The primary Commit sits on --ink, so ring it with a --ground gap for contrast. */
.ch__btn--primary:focus-visible {
  box-shadow: 0 0 0 2px var(--ground), 0 0 0 4px color-mix(in srgb, var(--ink) 45%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .ch,
  .ch__dot { animation: none; }
}

/* ── empty state ────────────────────────────────────────────────────────── */
.empty {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
}

/* Status header — clean tree on the left, sync state on the right. */
.empty__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  opacity: 0.9;
  animation: ch-header-in 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.empty__clean {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1;
  color: var(--clean-ink, #71717a);
}
.empty__clean svg {
  flex-shrink: 0;
  stroke: #059669;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.empty__sync {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
  color: var(--sync-ink, #c8c6c1);
}

/* Centred illustration region. */
.empty__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  min-height: 236px;
  padding: 28px;
}

/* Three-sheet folder glyph: two fanned back sheets + a centred front sheet,
   topped by a check badge. Matches the Paper "No changes" board. */
.empty__glyph {
  position: relative;
  width: 180px;
  height: 118px;
  flex-shrink: 0;
}
.empty__sheet {
  --r: 0deg; /* single source of truth — shared by the resting tilt + keyframe */
  position: absolute;
  width: 76px;
  height: 92px;
  border-radius: 12px;
  border: 1px solid var(--sheet-bd, #e7e6e2);
  background-color: var(--sheet-bg, #fcfcfb);
  box-shadow: #1e1b180a 0 4px 12px;
  transform-origin: top left;
  transform: rotate(var(--r));
  animation: empty-sheet-in 560ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.empty__sheet--l {
  --r: -9deg;
  left: 26px;
  top: 22px;
  animation-delay: 60ms;
}
.empty__sheet--r {
  --r: 9deg;
  left: 78px;
  top: 22px;
  animation-delay: 120ms;
}
.empty__sheet--front {
  left: 52px;
  top: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-color: var(--sheet-front-bd, #e4e3df);
  background-color: var(--sheet-front-bg, #fff);
  box-shadow: #1e1b1812 0 6px 16px;
  animation-delay: 180ms;
}
.empty__dot {
  width: 15px;
  height: 15px;
  margin: 12px 0 0 12px;
  border-radius: 4px;
  background-color: var(--sheet-mark, #e7e6e2);
}
.empty__dot--end { margin-left: auto; margin-right: 12px; }
.empty__dash {
  width: 14px;
  height: 6px;
  border-radius: 3px;
  background-color: var(--sheet-front-mark, #eae9e5);
}
.empty__check {
  position: absolute;
  left: 74px;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background-color: #059669;
  border: 3px solid var(--ground);
  animation: empty-check-in 420ms cubic-bezier(0.34, 1.45, 0.64, 1) 320ms backwards;
}
.empty__label {
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.1px;
  line-height: 1;
  color: var(--ink-soft);
}
.empty__branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 8px;
  background-color: var(--branch-bg, #00000008);
  color: var(--branch-ink, #3f3f46);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
}
.empty__branch svg {
  stroke: var(--branch-mark, #a1a1aa);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@keyframes empty-sheet-in {
  from { opacity: 0; transform: translateY(10px) rotate(var(--r)); }
}
@keyframes empty-check-in {
  from { opacity: 0; transform: scale(0.3); }
}

@media (prefers-reduced-motion: reduce) {
  .empty__head,
  .empty__sheet,
  .empty__check { animation: none; }
}

@media (prefers-color-scheme: dark) {
  .empty {
    --clean-ink: #8a8a90;
    --sync-ink: #55555b;
    --sheet-bd: #2a2a2e;
    --sheet-bg: #161618;
    --sheet-front-bd: #33333a;
    --sheet-front-bg: #1c1c1f;
    --sheet-mark: #2f2f34;
    --sheet-front-mark: #34343a;
    --branch-bg: rgb(244 244 245 / 0.05);
    --branch-ink: #d4d4d8;
    --branch-mark: #6b6b70;
  }
  .empty__sheet { box-shadow: #0000002e 0 4px 12px; }
  .empty__sheet--front { box-shadow: #00000038 0 6px 16px; }
  .ch__dot--idle { background-color: #3f3f46; }
}
</style>
