<script setup lang="ts">
import { computed } from "vue";
import { CountUp } from "~/components/ui/count-up";

// board. One card, every form: freshly created (new · empty), added, removed,
// edited, or deleted (torn). Staged-ness is shown by which group the card sits
// in, so the card itself is purely presentational. The diff "marks" are a
// representative sketch of the hunk shape (git status carries no per-line
// hunks), seeded from the path so they stay stable.

const props = withDefaults(
  defineProps<{
    name: string;
    added?: number;
    removed?: number;
    /** Freshly added file — carries a quiet "new" marker. */
    isNew?: boolean;
    /** Deleted file — torn (dashed-red) card, strikethrough name. */
    deleted?: boolean;
  }>(),
  { added: 0, removed: 0, isNew: false, deleted: false },
);

// A new file with no content yet: show a dashed placeholder, "empty" label.
const empty = computed(
  () => props.isNew && props.added === 0 && props.removed === 0,
);

type Mark = { w: number; tone: "ctx" | "add" | "del" };

// Sketch the diff shape from the +/− magnitude. Widths jitter deterministically
// off the filename so no two cards read identically.
const marks = computed<Mark[]>(() => {
  if (props.deleted) return [{ w: 40, tone: "del" }, { w: 24, tone: "del" }, { w: 20, tone: "ctx" }];
  const seed = [...props.name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const jit = (base: number, i: number) => base + ((seed + i * 7) % 9) - 4;
  const { added, removed } = props;
  if (added > 0 && removed > 0)
    return [
      { w: jit(40, 0), tone: "ctx" },
      { w: jit(24, 1), tone: "del" },
      { w: jit(32, 2), tone: "add" },
      { w: jit(20, 3), tone: "ctx" },
    ];
  if (added > 0)
    return [
      { w: jit(38, 0), tone: "add" },
      { w: jit(26, 1), tone: "add" },
      { w: jit(20, 2), tone: "ctx" },
    ];
  if (removed > 0)
    return [
      { w: jit(38, 0), tone: "del" },
      { w: jit(22, 1), tone: "del" },
      { w: jit(18, 2), tone: "ctx" },
    ];
  return [{ w: 40, tone: "ctx" }, { w: 24, tone: "ctx" }];
});
</script>

<template>
  <div class="card" :class="{ 'card--torn': deleted }">
    <!-- Top: file icon and the diff sketch. -->
    <div class="card__top">
      <div class="card__badge-wrap">
        <FileIcon :path="name" :size="18" />
      </div>

      <span v-if="empty" class="card__placeholder" />
      <div v-else class="card__marks">
        <i
          v-for="(m, i) in marks"
          :key="i"
          class="card__mark"
          :class="`card__mark--${m.tone}`"
          :style="{ width: `${m.w}px` }"
        />
      </div>
    </div>

    <!-- Bottom: filename + diffstat. "new" is a quiet marker, not a badge. -->
    <div class="card__bottom">
      <span class="card__name" :class="{ 'card__name--del': deleted }">
        {{ name }}
      </span>
      <div class="card__foot">
        <span v-if="empty" class="card__empty">empty</span>
        <span v-else class="card__diff">
          <span v-if="added > 0" class="card__add"
            >+<CountUp :to="added" :duration="1.1"
          /></span>
          <span v-if="removed > 0" class="card__del"
            >−<CountUp :to="removed" :duration="1.1"
          /></span>
        </span>
        <span v-if="isNew && !empty" class="card__new">new</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  --card-bg: #ffffff;
  --card-border: rgb(161 161 170 / 0.16);
  --card-shadow: #1e1b180f 0 4px 14px;
  --ctx: #d0cec9;
  --name: #3f3f46;

  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 178px;
  padding: 15px;
  border-radius: 12px;
  background-color: var(--card-bg);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
  /* Bouncy, spring-like hover — mirrors the home project folders' lift. The
     back-out easing overshoots then settles, so it reads springy in pure CSS. */
  transition:
    box-shadow 0.32s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.44s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.card:hover {
  /* Lifts on hover. Soft shadow only — no heavy drop shadows anywhere. */
  box-shadow: #1e1b1814 0 8px 20px;
  transform: translateY(-6px);
}
.card--torn {
  background-color: color-mix(in srgb, var(--card-bg) 45%, transparent);
  border: 1.5px dashed var(--diff-del);
}

.card__top {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card__badge-wrap {
  width: 18px;
  height: 18px;
}

.card__marks {
  display: flex;
  flex-direction: column;
  gap: 4.5px;
}
.card__mark {
  height: 3.5px;
  border-radius: 2px;
}
.card__mark--ctx {
  background-color: var(--ctx);
}
.card__mark--add {
  background-color: var(--diff-add);
}
.card__mark--del {
  background-color: var(--diff-del);
}
.card__placeholder {
  width: 44px;
  border-top: 1.5px dashed #d8d7d3;
}

.card__bottom {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.card__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--name);
}
.card__name--del {
  text-decoration: line-through;
  color: #a1a1aa;
}
.card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card__diff {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.card__add {
  color: var(--diff-add);
}
.card__del {
  color: var(--diff-del);
}
.card__empty {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: #a1a1aa;
}
/* Quiet "new" marker — a muted lowercase tag, not a coloured badge. */
.card__new {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.3px;
  color: var(--muted);
}

@media (prefers-color-scheme: dark) {
  .card {
    --card-bg: #17171a;
    --card-border: rgb(255 255 255 / 0.08);
    --card-shadow: #00000040 0 4px 14px;
    --ctx: #3f3f46;
    --name: #d4d4d8;
  }
  .card:hover {
    box-shadow: #00000047 0 8px 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .card {
    transition: box-shadow 0.2s ease;
  }
  .card:hover {
    transform: none;
  }
}
</style>
