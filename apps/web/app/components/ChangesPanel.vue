<script setup lang="ts">
import { computed } from "vue";

// The file-changes block that heads the project rail. Composes the adaptive
// controls change with the working tree) over a grid of ChangeCards that fills,
// wraps, then caps at two rows with the rest packed into a +N bundle ("File row
// — states"). When the tree is clean it collapses to a quiet empty state.
//
// The header actions are inert for now (no staging wired up yet).

export interface ChangeItem {
  name: string;
  lang: "ts" | "js" | "vue";
  added: number;
  removed: number;
  staged: boolean;
  isNew: boolean;
  deleted: boolean;
}

const props = defineProps<{
  branch: string | null;
  added: number;
  removed: number;
  changes: ChangeItem[];
}>();

const total = computed(() => props.changes.length);
const stagedCount = computed(() => props.changes.filter((c) => c.staged).length);

// unstaged → all-staged spectrum drives which primary action shows.
const allStaged = computed(() => total.value > 0 && stagedCount.value === total.value);
const noneStaged = computed(() => stagedCount.value === 0);

// Cap at ~two rows; the rest fold into one bundle in the last slot.
const CAP = 8;
const visible = computed(() =>
  total.value > CAP ? props.changes.slice(0, CAP - 1) : props.changes,
);
const overflow = computed(() => Math.max(0, total.value - (CAP - 1)));

// One dot per file, coloured by what changed (not by staging — that's shown on
// the cards). Additions read green, removals/deletions red, and a pure no-op
// delta (rename, mode, binary) stays grey.
type DotTone = "add" | "del" | "idle";
const dots = computed<DotTone[]>(() =>
  props.changes.map((c) => {
    if (c.deleted || (c.removed > 0 && c.added === 0)) return "del";
    if (c.added > 0) return "add";
    return "idle";
  }),
);
</script>

<template>
  <!-- Clean: quiet empty state. -->
  <div v-if="total === 0" class="empty">
    <div class="empty__glyph">
      <span class="empty__sheet empty__sheet--back" />
      <span class="empty__sheet empty__sheet--front" />
      <span class="empty__check">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            d="M20 6 9 17l-5-5"
            fill="none"
            stroke="#fff"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
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
    <!-- Adaptive header: controls left, diffstat + progress right. -->
    <header class="ch">
      <div class="ch__actions">
        <button type="button" class="ch__btn ch__btn--primary">
          <svg v-if="allStaged" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2.4" />
            <line x1="3" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            <line x1="15" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ allStaged ? "Commit" : "Stage all" }}
        </button>
        <button type="button" class="ch__btn" :class="{ 'ch__btn--off': noneStaged }">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
          Unstage all
        </button>
        <button type="button" class="ch__btn ch__btn--ghost">
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M3 7v6h6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Discard
        </button>
      </div>

      <span class="ch__meta">
        <span class="ch__diff">
          <span v-if="added > 0" class="ch__add">+{{ added }}</span>
          <span v-if="removed > 0" class="ch__del">−{{ removed }}</span>
        </span>
        <span class="ch__dots">
          <i
            v-for="(d, i) in dots"
            :key="i"
            class="ch__dot"
            :class="`ch__dot--${d}`"
          />
        </span>
      </span>
    </header>

    <!-- Card grid: two columns, capped at two rows + a bundle. -->
    <div class="grid">
      <ChangeCard
        v-for="c in visible"
        :key="c.name"
        :name="c.name"
        :lang="c.lang"
        :added="c.added"
        :removed="c.removed"
        :staged="c.staged"
        :is-new="c.isNew"
        :deleted="c.deleted"
      />
      <button v-if="overflow > 0" type="button" class="bundle">
        <span class="bundle__stack">
          <span class="bundle__sheet bundle__sheet--3" />
          <span class="bundle__sheet bundle__sheet--2" />
          <span class="bundle__sheet bundle__sheet--1" />
        </span>
        <span class="bundle__label">+{{ overflow }} more</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ── header ─────────────────────────────────────────────────────────────── */
.ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.ch__meta {
  display: flex;
  align-items: center;
  gap: 12px;
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
.ch__add {
  color: #059669;
}
.ch__del {
  color: #e11d48;
}
.ch__dots {
  display: flex;
  align-items: center;
  gap: 3px;
}
.ch__dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
}
.ch__dot--add {
  background-color: #059669;
}
.ch__dot--del {
  background-color: #e11d48;
}
.ch__dot--idle {
  background-color: #d4d4d8;
}

.ch__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.ch__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-family: "Inter", system-ui, sans-serif;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    opacity 0.16s ease;
}
.ch__btn:hover {
  background-color: var(--hover);
}
.ch__btn--primary {
  background-color: var(--ink);
  color: var(--ground);
}
.ch__btn--primary:hover {
  background-color: var(--ink);
  opacity: 0.88;
}
.ch__btn--ghost {
  font-weight: 400;
  color: var(--muted);
}
.ch__btn--off {
  opacity: 0.45;
  pointer-events: none;
}

/* ── card grid ──────────────────────────────────────────────────────────── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 158px);
  justify-content: start;
  gap: 12px;
}

/* +N bundle: a little stack of sheets you'll be able to unpack. */
.bundle {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 178px;
  cursor: pointer;
}
.bundle__stack {
  position: relative;
  width: 46px;
  height: 56px;
}
.bundle__sheet {
  position: absolute;
  inset: 0;
  border-radius: 7px;
  background-color: var(--sheet-bg, #fff);
  border: 1px solid rgb(161 161 170 / 0.18);
  box-shadow: #1e1b180f 0 3px 8px;
}
.bundle__sheet--3 {
  transform: translate(8px, -6px) rotate(7deg);
  opacity: 0.55;
}
.bundle__sheet--2 {
  transform: translate(4px, -3px) rotate(3deg);
  opacity: 0.8;
}
.bundle__sheet--1 {
  transform: translate(0, 0);
}
.bundle__label {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  background-color: var(--ink);
  color: var(--ground);
  font-family: "Inter", system-ui, sans-serif;
  font-size: 10.5px;
  font-weight: 500;
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
.empty__sheet--front {
  inset: 6px 0 0 8px;
}
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
  .bundle__sheet,
  .empty__sheet {
    --sheet-bg: #17171a;
  }
  .bundle__sheet {
    border-color: rgb(255 255 255 / 0.08);
  }
  .ch__dot--idle {
    background-color: #3f3f46;
  }
}
</style>
