<script setup lang="ts">
import { computed } from "vue";

// board. One card, every form: freshly created (new · empty), added, removed,
// edited, staged/unstaged, or deleted (torn). Hovering reveals a Revert control.
// The diff "marks" are a representative sketch of the hunk shape (git status
// carries no per-line hunks), seeded from the path so they stay stable.

type FileLang = "ts" | "js" | "vue";

const props = withDefaults(
  defineProps<{
    name: string;
    lang: FileLang;
    added?: number;
    removed?: number;
    staged?: boolean;
    /** Freshly added file — badge wears a green "new" dot. */
    isNew?: boolean;
    /** Deleted file — torn (dashed-red) card, strikethrough name. */
    deleted?: boolean;
  }>(),
  { added: 0, removed: 0, staged: false, isNew: false, deleted: false },
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
    <!-- Top: language badge (+ new dot) and the diff sketch. -->
    <div class="card__top">
      <div class="card__badge-wrap">
        <span v-if="lang === 'vue'" class="card__vue">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M3 3 L7 3 L12 11 L17 3 L21 3 L12 20 Z" fill="#41B883" />
            <path d="M7 3 L9.5 3 L12 7.2 L14.5 3 L17 3 L12 11 Z" fill="#35495E" />
          </svg>
        </span>
        <span v-else class="card__badge" :class="`card__badge--${lang}`">
          {{ lang === "ts" ? "TS" : "JS" }}
        </span>
        <span v-if="isNew" class="card__dot" />
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

    <!-- Bottom: filename, diffstat, staged checkbox. -->
    <div class="card__bottom">
      <span class="card__name" :class="{ 'card__name--del': deleted }">
        {{ name }}
      </span>
      <div class="card__foot">
        <span v-if="empty" class="card__empty">empty</span>
        <span v-else class="card__diff">
          <span v-if="added > 0" class="card__add">+{{ added }}</span>
          <span v-if="removed > 0" class="card__del">−{{ removed }}</span>
        </span>
        <span class="card__check" :class="{ 'card__check--on': staged }">
          <svg
            v-if="staged"
            viewBox="0 0 24 24"
            width="9"
            height="9"
            aria-hidden="true"
          >
            <path
              d="M20 6 9 17l-5-5"
              fill="none"
              stroke="#fff"
              stroke-width="3.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </div>
    </div>

    <!-- Hover: Revert (non-functional for now). -->
    <span class="card__revert" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="12.5" height="12.5">
        <path
          d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M3 3v5h5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      Revert
    </span>
  </div>
</template>

<style scoped>
.card {
  --card-bg: #ffffff;
  --card-border: rgb(161 161 170 / 0.16);
  --card-shadow: #1e1b180f 0 4px 14px;
  --ctx: #d0cec9;
  --name: #3f3f46;
  --check-off: #c8c6c1;

  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 178px;
  padding: 15px;
  border-radius: 12px;
  background-color: var(--card-bg);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
  transition:
    box-shadow 0.2s ease,
    transform 0.2s ease;
}
.card:hover {
  box-shadow:
    #1e1b1c1f 0 12px 26px,
    #0000000a 0 0 0 1px;
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
  position: relative;
  width: 18px;
  height: 18px;
}
.card__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-family: var(--font-sans);
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
}
.card__badge--ts {
  background-color: #3178c6;
  color: #fff;
}
.card__badge--js {
  background-color: #f7df1e;
  color: #1a1a1a;
}
.card__vue {
  display: inline-flex;
}
.card__dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 4px;
  background-color: var(--diff-add);
  border: 2px solid var(--card-bg);
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
.card__check {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1.5px solid var(--check-off);
}
.card__check--on {
  background-color: var(--diff-add);
  border-color: var(--diff-add);
}

.card__revert {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--diff-del);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.1px;
  opacity: 0;
  transform: translateY(-2px);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
  pointer-events: none;
}
.card:hover .card__revert {
  opacity: 1;
  transform: translateY(0);
}

@media (prefers-color-scheme: dark) {
  .card {
    --card-bg: #17171a;
    --card-border: rgb(255 255 255 / 0.08);
    --card-shadow: #00000040 0 4px 14px;
    --ctx: #3f3f46;
    --name: #d4d4d8;
    --check-off: #52525b;
  }
  .card:hover {
    box-shadow:
      #00000066 0 12px 26px,
      #ffffff0f 0 0 0 1px;
  }
}
</style>
