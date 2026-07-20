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
type DotTone = "add" | "del" | "idle";
const dots = computed<DotTone[]>(() =>
  props.changes.map((c) => {
    if (c.deleted || c.removed > c.added) return "del";
    if (c.added > 0) return "add";
    return "idle";
  }),
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

  <!-- Clean: quiet empty state. -->
  <div v-else-if="total === 0" class="empty">
    <div class="empty__glyph">
      <span class="empty__sheet empty__sheet--back" />
      <span class="empty__sheet empty__sheet--front" />
      <span class="empty__check">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </div>
    <span class="empty__label">No changes</span>
    <span v-if="branch" class="empty__branch">
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" fill="none" />
        <circle cx="6" cy="18" r="3" fill="none" />
        <path d="M18 9a9 9 0 0 1-9 9" fill="none" />
      </svg>
      {{ branch }}
    </span>
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
        <span class="ch__dots">
          <i v-for="(d, i) in dots" :key="i" class="ch__dot" :class="`ch__dot--${d}`" :style="{ '--i': i }" />
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
}
.ch__meta {
  display: flex;
  align-items: center;
  gap: 14px;
}
.ch__diff {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ch__add { color: #059669; }
.ch__del { color: #e11d48; }
.ch__dots {
  display: flex;
  align-items: center;
  gap: 3px;
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
.ch__dot--add { background-color: #059669; }
.ch__dot--del { background-color: #e11d48; }
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
  align-items: center;
  gap: 14px;
  padding: 28px 0;
}
.empty__glyph {
  position: relative;
  width: 64px;
  height: 52px;
}
.empty__sheet {
  position: absolute;
  border-radius: 10px;
  background-color: var(--sheet-bg, #fff);
  box-shadow: #1e1b180f 0 4px 12px;
}
.empty__sheet--back {
  inset: 0 8px 8px 0;
  transform: rotate(-5deg);
  opacity: 0.6;
}
.empty__sheet--front { inset: 6px 0 0 8px; }
.empty__check {
  position: absolute;
  top: -6px;
  right: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background-color: #10a56f;
  border: 2px solid var(--ground);
}
.empty__label {
  font-size: 13px;
  color: var(--muted);
}
.empty__branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  background-color: var(--hover);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
}
.empty__branch svg {
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (prefers-color-scheme: dark) {
  .empty__sheet { --sheet-bg: #17171a; }
  .ch__dot--idle { background-color: #3f3f46; }
}
</style>
