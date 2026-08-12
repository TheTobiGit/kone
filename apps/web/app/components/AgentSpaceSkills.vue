<script setup lang="ts">
import { computed, ref } from "vue";
import type { SkillEntry } from "~/types/desktop";
import type { useAgentSpace } from "~/composables/useAgentSpace";

// What the agent CLIs on this machine can reach for as a skill — Claude's
// `.claude/skills`, Codex/OpenCode/Cursor's equivalents, kone's own, and
// anything a plugin dropped in. Read-only: this section can only ever tell the
// user what is sitting on disk, never toggle it.

const props = defineProps<{ space: ReturnType<typeof useAgentSpace> }>();

/** A human label per machine-readable origin string — the same shape kone uses
 *  everywhere a provider id needs a name a person would use. */
const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  agents: "Agents",
  kone: "kone",
};

const query = ref("");

const skills = computed(() => props.space.inventory.value?.skills ?? []);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return skills.value;
  return skills.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description ?? "").toLowerCase().includes(q) ||
      s.origin.toLowerCase().includes(q),
  );
});

type Group = { origin: string; label: string; count: number; skills: SkillEntry[] };

/** Grouped by origin, biggest group first; skills inside a group sort
 *  alphabetically by whichever name a person would actually recognise. */
const groups = computed<Group[]>(() => {
  const byOrigin = new Map<string, SkillEntry[]>();
  for (const s of filtered.value) {
    const list = byOrigin.get(s.origin);
    if (list) list.push(s);
    else byOrigin.set(s.origin, [s]);
  }
  const out: Group[] = [];
  for (const [origin, list] of byOrigin) {
    const sorted = [...list].sort((a, b) =>
      (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
    );
    out.push({ origin, label: ORIGIN_LABEL[origin] ?? origin, count: sorted.length, skills: sorted });
  }
  return out.sort((a, b) => b.count - a.count);
});

const loading = computed(() => props.space.inventoryLoading.value && !props.space.inventoryLoaded.value);
/** How many skills exist at all, before the query narrows them. Two different
 *  facts hang off this: a search field over nothing is dead furniture, so it
 *  only appears once there's something to search; and "none on this machine" is
 *  a different sentence from "your search matched nothing" — saying the first
 *  when the second is true would be a lie. */
const total = computed(() => props.space.inventory.value?.skills.length ?? 0);
const empty = computed(() => props.space.inventoryLoaded.value && !loading.value && total.value === 0);
const noMatch = computed(() => !loading.value && total.value > 0 && groups.value.length === 0);

/** Only the errors this section is actually answerable for — a failed MCP or
 *  instructions read has no business showing up under Skills. */
const errors = computed(() => props.space.inventory.value?.errors.filter((e) => /skill/i.test(e.source)) ?? []);
</script>

<template>
  <section class="sk" aria-label="Skills">
    <div v-if="total > 0" class="sk__search">
      <input
        v-model="query"
        type="search"
        class="sk__input"
        placeholder="Search skills"
        aria-label="Search skills"
      />
    </div>

    <template v-if="loading">
      <ul class="placeholders" aria-hidden="true">
        <li v-for="n in 4" :key="n" class="placeholder" :style="{ animationDelay: `${n * 180}ms` }" />
      </ul>
    </template>
    <template v-else-if="empty">
      <p class="sk__empty">No skills found on this machine.</p>
    </template>
    <template v-else-if="noMatch">
      <p class="sk__empty">Nothing matches “{{ query }}”.</p>
    </template>
    <template v-else>
      <section v-for="g in groups" :key="g.origin" class="block" :aria-label="g.label">
        <div class="block__head">
          <p class="eyebrow">{{ g.label }}</p>
          <span class="block__count">{{ g.count }}</span>
        </div>
        <ul class="rows">
          <li v-for="s in g.skills" :key="s.path" class="row" tabindex="0">
            <div class="row__head">
              <span class="row__name">{{ s.displayName ?? s.name }}</span>
              <span class="chip">{{ s.scope }}</span>
            </div>
            <p v-if="s.shortDescription ?? s.description" class="row__desc">
              {{ s.shortDescription ?? s.description }}
            </p>
            <p class="row__path" :title="s.path">{{ s.path }}</p>
          </li>
        </ul>
      </section>

      <ul v-if="errors.length" class="sk__errors">
        <li v-for="e in errors" :key="e.source" class="sk__error">couldn't read {{ e.source }}: {{ e.message }}</li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding-bottom: 2rem;
}

/* ── search ───────────────────────────────────────────────────────────────── */
.sk__search {
  margin-bottom: 0.5rem;
}
.sk__input {
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  padding: 6px 0;
  font-size: 13px;
  color: var(--ink);
  outline: none;
  transition: border-color 140ms ease;
}
.sk__input::placeholder {
  color: var(--muted);
}
.sk__input:focus {
  border-bottom-color: var(--accent);
}
.sk__input::-webkit-search-decoration,
.sk__input::-webkit-search-cancel-button {
  -webkit-appearance: none;
}

.sk__empty {
  font-size: 15px;
  color: var(--muted);
  padding: 1.5rem 0;
}

/* ── blocks ───────────────────────────────────────────────────────────────── */
.block__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 14px;
}
.eyebrow {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.block__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: block;
  width: 100%;
  padding: 11px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  text-align: left;
  cursor: default;
  border-radius: 8px;
}
.row:first-child {
  border-top: none;
}
.row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.row__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.row__name {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__desc {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* The path is a detail worth having, not one worth always showing — it only
   surfaces once the row has your attention, by mouse or by keyboard. */
.row__path {
  margin: 6px 0 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 140ms ease;
}
.row:hover .row__path,
.row:focus-visible .row__path {
  opacity: 1;
}

/* ── chips ────────────────────────────────────────────────────────────────── */
.chip {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}

/* ── errors ───────────────────────────────────────────────────────────────── */
.sk__errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sk__error {
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
  animation: sk-breathe 1700ms ease-in-out infinite;
}
@keyframes sk-breathe {
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
  .row__path,
  .sk__input {
    transition: none;
  }
}
</style>
