<script setup lang="ts">
import { computed, ref } from "vue";
import type { InstructionFile } from "~/types/desktop";
import type { useAgentSpace } from "~/composables/useAgentSpace";

// Every AGENTS.md / CLAUDE.md kone found in scope — global, this project, and
// any nested ones a subfolder carries. A read-only preview: expanding a row
// shows the first part of the file kone already scanned, never a live editor.

const props = defineProps<{ space: ReturnType<typeof useAgentSpace> }>();

const SCOPE_ORDER: Array<{ scope: InstructionFile["scope"]; label: string }> = [
  { scope: "user", label: "Global" },
  { scope: "project", label: "Project" },
  { scope: "nested", label: "Nested" },
];

type Group = { scope: InstructionFile["scope"]; label: string; files: InstructionFile[] };

const groups = computed<Group[]>(() => {
  const list = props.space.inventory.value?.instructions ?? [];
  return SCOPE_ORDER.map(({ scope, label }) => ({
    scope,
    label,
    // Most recently touched first — the file most likely to be why the agent
    // is behaving the way it is right now.
    files: list.filter((f) => f.scope === scope).sort((a, b) => b.modifiedAt - a.modifiedAt),
  })).filter((g) => g.files.length > 0);
});

const loading = computed(() => props.space.inventoryLoading.value && !props.space.inventoryLoaded.value);
const empty = computed(() => props.space.inventoryLoaded.value && !loading.value && groups.value.length === 0);

const errors = computed(
  () => props.space.inventory.value?.errors.filter((e) => /instruction|agents\.md|claude\.md/i.test(e.source)) ?? [],
);

// ── expansion: one row open at a time ───────────────────────────────────────
const openPath = ref<string | null>(null);
function toggle(path: string): void {
  openPath.value = openPath.value === path ? null : path;
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtRelative(ts: number): string {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.round(month / 12);
  return `${year} year${year === 1 ? "" : "s"} ago`;
}
</script>

<template>
  <section class="ins" aria-label="Instructions">
    <template v-if="loading">
      <ul class="placeholders" aria-hidden="true">
        <li v-for="n in 3" :key="n" class="placeholder" :style="{ animationDelay: `${n * 180}ms` }" />
      </ul>
    </template>
    <template v-else-if="empty">
      <p class="ins__empty">No AGENTS.md or CLAUDE.md files found in scope.</p>
    </template>
    <template v-else>
      <section v-for="g in groups" :key="g.scope" class="block" :aria-label="g.label">
        <p class="eyebrow">{{ g.label }}</p>
        <ul class="rows">
          <li v-for="f in g.files" :key="f.path" class="row">
            <button
              type="button"
              class="row__btn"
              :aria-expanded="openPath === f.path"
              @click="toggle(f.path)"
            >
              <div class="row__head">
                <span class="row__kind">{{ f.kind }}</span>
                <span class="chip">{{ fmtBytes(f.bytes) }}</span>
                <span class="row__time">{{ fmtRelative(f.modifiedAt) }}</span>
              </div>
              <p class="row__path" :title="f.path">{{ f.path }}</p>
            </button>
            <div class="row__expand" :class="{ 'row__expand--open': openPath === f.path }">
              <div class="row__expand-inner">
                <pre class="row__excerpt">{{ f.excerpt }}</pre>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <p class="ins__note">These are read-only previews of the first part of each file.</p>

      <ul v-if="errors.length" class="ins__errors">
        <li v-for="e in errors" :key="e.source" class="ins__error">couldn't read {{ e.source }}: {{ e.message }}</li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.ins {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding-bottom: 2rem;
}

.ins__empty {
  font-size: 15px;
  color: var(--muted);
  padding: 1.5rem 0;
}
.ins__note {
  font-size: 11.5px;
  color: var(--muted);
}

.eyebrow {
  margin: 0 0 14px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.row:first-child {
  border-top: none;
}
.row__btn {
  display: block;
  width: 100%;
  padding: 11px 0;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  border-radius: 6px;
}
.row__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.row__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.row__kind {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
}
.row__time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
.row__path {
  margin: 5px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── chips ────────────────────────────────────────────────────────────────── */
.chip {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}

/* ── expansion ────────────────────────────────────────────────────────────── */
/* The 0fr/1fr grid trick: the track height (and so the excerpt block) animates
   like a measured auto-height, without any JS measuring. */
.row__expand {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 320ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 320ms cubic-bezier(0.22, 1, 0.36, 1);
}
.row__expand--open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.row__expand-inner {
  overflow: hidden;
  min-height: 0;
  padding-bottom: 12px;
}
.row__excerpt {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background-color: var(--hover);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: var(--ink-soft);
}

/* ── errors ───────────────────────────────────────────────────────────────── */
.ins__errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ins__error {
  font-size: 11.5px;
  color: var(--muted);
}

/* ── loading placeholders ─────────────────────────────────────────────────── */
.placeholders {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.placeholder {
  height: 44px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  animation: ins-breathe 1700ms ease-in-out infinite;
}
@keyframes ins-breathe {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .placeholder {
    animation: none;
    opacity: 0.75;
  }
  .row__expand {
    transition: none;
  }
}
</style>
