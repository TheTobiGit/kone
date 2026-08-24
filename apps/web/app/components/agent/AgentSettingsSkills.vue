<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon } from "@hugeicons/core-free-icons";
import type { SkillEntry, SkillState } from "~/types/desktop";
import type { useAgentSettings } from "~/composables/useAgentSettings";
import type { useSkills } from "~/composables/useSkills";
import { writableStates } from "~/composables/useSkills";
import SkillMark from "~/components/skill/SkillMark.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import type { BrandKey } from "~/utils/modelCatalog";

// Every skill the agent CLIs on this machine can reach, and — where the CLI
// keeps a setting for it — whether it is switched on. Laid out as a directory:
// one search field over everything, the agents that hold skills as a strip of
// logomarks, then a section per agent of two-across rows. Forty skills is a
// catalogue to scan, not a gallery to browse, so a row is a line of text with a
// tile beside it rather than a card with cover art.
//
// The list is deliberately quiet: a skill that is simply on says nothing at all,
// so the eye lands on the handful that are off, held back, or shadowed. The
// switch appears under the pointer rather than sitting on forty rows at once.

const props = defineProps<{
  space: ReturnType<typeof useAgentSettings>;
  skills: ReturnType<typeof useSkills>;
}>();

const emit = defineEmits<{ open: [SkillEntry] }>();

/** A human label per machine-readable origin string — the same shape kone uses
 *  everywhere a provider id needs a name a person would use. */
const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  factory: "Factory",
  agents: "Agents",
  kone: "kone",
};

/** The CLI's own logomark, where one exists. Agents and kone have no mark of
 *  their own here, and get the letter tile instead of a borrowed one. */
const BRAND: Record<string, BrandKey | undefined> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  factory: "droid",
};

/** How many agents can reach this name at all. A skill installed in three places
 *  is a real fact about it, and a row is too narrow to say it in logomarks, so it
 *  says it in a count instead. */
function copyCount(skill: SkillEntry): number {
  const seen = new Set([skill.origin, ...skill.shadowedBy.map((copy) => copy.origin)]);
  return seen.size;
}

/** The short word a row wears for a state that is not plain "on". `enabled` is
 *  absent on purpose: the common case earns no ink. */
const STATE_CHIP = new Map<SkillState, string>([
  ["disabled", "Off"],
  ["name-only", "Name only"],
  ["user-invocable-only", "When asked"],
]);

const query = ref("");
const origin = ref<string | null>(null);

const all = computed(() => props.space.inventory.value?.skills ?? []);

/** Read the states once the scan lands, and again whenever the scan is redone —
 *  a skill that appeared since the last look has no state yet, and one that
 *  vanished should stop being asked about. */
watch(
  all,
  (skills) => {
    if (skills.length) void props.skills.loadStates(skills);
  },
  { immediate: true },
);

const originCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const s of all.value) counts.set(s.origin, (counts.get(s.origin) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: ORIGIN_LABEL[id] ?? id, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return all.value
    .filter((s) => (origin.value ? s.origin === origin.value : true))
    .filter((s) =>
      q
        ? s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q) ||
          (s.displayName ?? "").toLowerCase().includes(q)
        : true,
    )
    .sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name));
});

/** The rows, cut into a section per agent. Sections follow the strip's order —
 *  the agent holding the most skills first — so the strip and the list below it
 *  read top to bottom in the same order. Filtering to one agent leaves one
 *  section standing rather than dropping the heading: the answer to "whose is
 *  this" shouldn't disappear the moment you narrow to it. */
const sections = computed(() => {
  const byOrigin = new Map<string, SkillEntry[]>();
  for (const s of filtered.value) {
    const arr = byOrigin.get(s.origin);
    if (arr) arr.push(s);
    else byOrigin.set(s.origin, [s]);
  }
  return originCounts.value
    .filter((o) => byOrigin.has(o.id))
    .map((o) => ({ id: o.id, label: o.label, skills: byOrigin.get(o.id)! }));
});

function stateOf(skill: SkillEntry): SkillState | undefined {
  return props.skills.stateOf(skill)?.state;
}

/** The chip a row shows at rest. Frontmatter that asks not to be auto-invoked
 *  is worth saying even where the CLI keeps no setting kone can read — the
 *  skill really is held back, and the reason is in the file itself. */
function chipFor(skill: SkillEntry): string | null {
  const state = stateOf(skill);
  const chip = state ? STATE_CHIP.get(state) : undefined;
  if (chip) return chip;
  if (!state || state === "unsupported") return skill.manualOnly ? "When asked" : null;
  return null;
}

/** A row only offers a switch when this skill's own CLI has somewhere to write
 *  the answer, and when the answer it holds is one a switch can honestly show.
 *  A skill held to a middle rung is neither on nor off, so a two-position switch
 *  would have to lie about it; those rows keep their chip and send the reader to
 *  the ladder on the skill's own page. */
function switchable(skill: SkillEntry): boolean {
  const state = stateOf(skill);
  if (state !== "enabled" && state !== "disabled") return false;
  return writableStates(skill.origin).length > 0;
}

const busy = ref<string | null>(null);

async function flip(skill: SkillEntry) {
  if (busy.value) return;
  busy.value = skill.path;
  const on = stateOf(skill) !== "disabled";
  await props.skills.setState(skill, on ? "disabled" : "enabled");
  busy.value = null;
}

const loading = computed(
  () => props.space.inventoryLoading.value && !props.space.inventoryLoaded.value,
);
/** How many skills exist at all, before the filters narrow them. Two different
 *  facts hang off this: a search field over nothing is dead furniture, so it
 *  only appears once there's something to search; and "none on this machine" is
 *  a different sentence from "your search matched nothing" — saying the first
 *  when the second is true would be a lie. */
const total = computed(() => all.value.length);
const empty = computed(() => props.space.inventoryLoaded.value && !loading.value && total.value === 0);
const noMatch = computed(() => !loading.value && total.value > 0 && filtered.value.length === 0);

/** Only the errors this section is actually answerable for — a failed MCP or
 *  instructions read has no business showing up under Skills. */
const errors = computed(
  () => props.space.inventory.value?.errors.filter((e) => /skill/i.test(e.source)) ?? [],
);
</script>

<template>
  <section class="sk" aria-label="Skills">
    <div v-if="total > 0" class="sk__head">
      <label class="find">
        <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          class="find__input"
          placeholder="Search skills"
          aria-label="Search skills"
        />
      </label>

      <div class="strip">
        <p class="eyebrow">Installed</p>
        <div class="strip__row" role="group" aria-label="Filter by agent">
          <button
            type="button"
            class="strip__all"
            :class="{ 'is-on': origin === null }"
            :aria-pressed="origin === null"
            @click="origin = null"
          >
            All<span class="strip__n">{{ total }}</span>
          </button>
          <button
            v-for="o in originCounts"
            :key="o.id"
            type="button"
            class="strip__tile"
            :class="{ 'is-on': origin === o.id }"
            :aria-pressed="origin === o.id"
            :aria-label="`${o.label} — ${o.count} skills`"
            :title="`${o.label} · ${o.count}`"
            @click="origin = origin === o.id ? null : o.id"
          >
            <ProviderLogo v-if="BRAND[o.id]" :brand="BRAND[o.id]!" :size="18" />
            <span v-else class="strip__letter">{{ o.label.slice(0, 1) }}</span>
          </button>
        </div>
      </div>
    </div>

    <template v-if="loading">
      <ul class="rows placeholders" aria-hidden="true">
        <li v-for="n in 8" :key="n" class="placeholder" :style="{ animationDelay: `${n * 90}ms` }" />
      </ul>
    </template>
    <template v-else-if="empty">
      <p class="sk__empty">No skills found on this machine.</p>
    </template>
    <template v-else-if="noMatch">
      <p class="sk__empty">Nothing matches “{{ query }}”.</p>
    </template>
    <template v-else>
      <section v-for="g in sections" :key="g.id" class="block" :aria-label="g.label">
        <p class="eyebrow">
          {{ g.label }}<span class="eyebrow__n">{{ g.skills.length }}</span>
        </p>

        <ul class="rows">
          <li v-for="s in g.skills" :key="s.path" class="row">
            <button type="button" class="row__hit" @click="emit('open', s)">
              <SkillMark
                class="row__mark"
                :name="s.name"
                :origin="s.origin"
                :size="30"
                :muted="stateOf(s) === 'disabled'"
              />
              <span class="row__body">
                <span class="row__line">
                  <span class="row__name">{{ s.displayName ?? s.name }}</span>
                  <span v-if="s.scope !== 'user'" class="badge">{{ s.scope }}</span>
                  <span v-if="copyCount(s) > 1" class="badge">{{ copyCount(s) }} copies</span>
                </span>
                <span v-if="s.shortDescription ?? s.description" class="row__desc">
                  {{ s.shortDescription ?? s.description }}
                </span>
              </span>
            </button>

            <span class="row__end">
              <span v-if="chipFor(s)" class="chip">{{ chipFor(s) }}</span>
              <span v-else-if="stateOf(s) === 'unsupported'" class="row__nosw">no switch</span>

              <span v-if="switchable(s)" class="row__switch">
                <ToggleSwitch
                  :model-value="stateOf(s) !== 'disabled'"
                  :aria-label="`Turn ${s.name} ${stateOf(s) === 'disabled' ? 'on' : 'off'}`"
                  @update:model-value="flip(s)"
                />
              </span>
            </span>
          </li>
        </ul>
      </section>

      <ul v-if="errors.length" class="sk__errors">
        <li v-for="e in errors" :key="e.source" class="sk__error">
          couldn't read {{ e.source }}: {{ e.message }}
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding-bottom: 2rem;
  /* The grid answers to the pane's width, not the window's — the settings
     drawer widens for this page, and a media query would still be reading the
     screen while the surface it sits on changed size underneath it. */
  container-type: inline-size;
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.sk__head {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Search runs the full width because it is the one control that reaches every
   section at once — the agent strip below it only narrows which sections show. */
.find {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-radius: 11px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  color: var(--faint);
  transition: background-color 160ms ease;
}
.find:focus-within {
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--muted);
}
.find__input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 13px;
  color: var(--ink);
  outline: none;
}
.find__input::placeholder {
  color: var(--placeholder);
}
.find__input::-webkit-search-decoration,
.find__input::-webkit-search-cancel-button {
  -webkit-appearance: none;
}

/* ── the agent strip ──────────────────────────────────────────────────────── */
/* Which agents on this machine hold skills at all, as their own logomarks. It
   doubles as the filter, since "show me the Claude ones" is the same gesture as
   "which are Claude's" — the count lives in the tooltip rather than on the tile,
   so the strip stays a row of marks instead of a row of labels. */
.strip {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.strip__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.strip__all {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}
.strip__all:hover {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.strip__all.is-on,
.strip__all.is-on:hover {
  background-color: var(--ink);
  color: var(--ground);
}
.strip__n {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--faint);
}
.strip__all.is-on .strip__n {
  color: color-mix(in srgb, var(--ground) 65%, transparent);
}

/* The tile is a plate for the logomark to sit on, not a button drawn round it:
   the chosen one lifts its ground rather than gaining an outline. */
.strip__tile {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  cursor: pointer;
  transition:
    background-color 160ms ease,
    opacity 160ms ease;
}
.strip__tile:hover {
  background-color: var(--hover);
}
.strip__tile.is-on {
  background-color: color-mix(in srgb, var(--ink) 12%, transparent);
}
/* Narrowing to one agent dims the others rather than removing them, so the strip
   never reflows under the pointer that just clicked it. */
.strip__row:has(.strip__tile.is-on) .strip__tile:not(.is-on) {
  opacity: 0.4;
}
.strip__letter {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}

.strip__all:focus-visible,
.strip__tile:focus-visible,
.row__hit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── sections ─────────────────────────────────────────────────────────────── */
.block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.eyebrow {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.eyebrow__n {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  color: var(--faint);
}

.sk__empty {
  font-size: 15px;
  color: var(--muted);
  padding: 1.5rem 0;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
/* Two across, because a skill's line of text wants roughly half this pane and a
   full-width row would leave a hand's width of empty space after every
   description. One column when the pane is too narrow to split. */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 2px 28px;
}
@container (min-width: 620px) {
  .rows {
    grid-template-columns: 1fr 1fr;
  }
}

/* No box drawn round a row: the wash under the pointer is the only frame it ever
   gets, and it sits behind the text rather than enclosing it. */
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 4px;
  border-radius: 12px;
  transition: background-color 160ms ease;
}
.row:hover,
.row:focus-within {
  background-color: var(--hover);
}

.row__hit {
  display: flex;
  align-items: center;
  gap: 11px;
  flex: 1;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  border-radius: 10px;
}

.row__mark {
  transition:
    filter 220ms ease,
    opacity 220ms ease;
}

.row__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.row__line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.row__name {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* One line, then stop — a row is scanned, not read, and a description that wraps
   would set its neighbour across the gap out of step with it. */
.row__desc {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Set beside the name rather than in the foot: a row has no foot, and scope and
   copy count are both facts about which file you'd be opening. */
.badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 5px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  line-height: 1.6;
  color: var(--faint);
  white-space: nowrap;
}

/* One slot, two occupants: the chip states the exception at rest, and the switch
   takes its place under the pointer. Nothing moves — they cross-fade in the same
   grid cell — so a row never resizes as the mouse crosses it. */
.row__end {
  display: grid;
  place-items: center end;
  flex-shrink: 0;
  height: 20px;
}
.row__end > * {
  grid-area: 1 / 1;
}
.chip,
.row__nosw {
  transition: opacity 160ms ease;
}
.row__switch {
  opacity: 0;
  transition: opacity 160ms ease;
  pointer-events: none;
}
.row:hover .row__switch,
.row:focus-within .row__switch {
  opacity: 1;
  pointer-events: auto;
}
/* The chip steps aside only for a switch that is actually there to take its
   place. A row with nothing to swap in keeps what it was saying, since blanking
   it under the pointer reads as a control that failed to appear. */
.row:hover .row__end:has(.row__switch) .chip,
.row:focus-within .row__end:has(.row__switch) .chip {
  opacity: 0;
}

.chip {
  padding: 2px 8px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted);
  white-space: nowrap;
}
.row__nosw {
  font-size: 10.5px;
  color: var(--faint);
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
.placeholder {
  height: 46px;
  border-radius: 12px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
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
  .row,
  .row__mark,
  .row__switch,
  .chip,
  .find,
  .strip__all,
  .strip__tile {
    transition: none;
  }
}
</style>
