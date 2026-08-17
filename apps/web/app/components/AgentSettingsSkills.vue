<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SkillEntry, SkillState } from "~/types/desktop";
import type { useAgentSettings } from "~/composables/useAgentSettings";
import type { useSkills } from "~/composables/useSkills";
import { writableStates } from "~/composables/useSkills";
import SkillMark from "~/components/SkillMark.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import type { BrandKey } from "~/utils/modelCatalog";

// Every skill the agent CLIs on this machine can reach, and — where the CLI
// keeps a setting for it — whether it is switched on. The list is deliberately
// quiet: a skill that is simply on says nothing at all, so the eye lands on the
// handful that are off, held back, or shadowed. The switch appears under the
// pointer rather than sitting on forty rows at once.

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

/** Which CLIs can reach this name, the winner first. A skill installed in three
 *  places is a real fact about it, and the cover is where that reads at a glance
 *  — one tile per agent that has a copy, capped so a wide row stays a row. */
function coverOrigins(skill: SkillEntry): string[] {
  const seen = [skill.origin, ...skill.shadowedBy.map((copy) => copy.origin)];
  return [...new Set(seen)].slice(0, 3);
}

/** The short word a row wears for a state that is not plain "on". `enabled` is
 *  absent on purpose: the common case earns no ink. */
const STATE_CHIP: Partial<Record<SkillState, string>> = {
  disabled: "Off",
  "name-only": "Name only",
  "user-invocable-only": "When asked",
};

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

function stateOf(skill: SkillEntry): SkillState | undefined {
  return props.skills.stateOf(skill)?.state;
}

/** The chip a row shows at rest. Frontmatter that asks not to be auto-invoked
 *  is worth saying even where the CLI keeps no setting kone can read — the
 *  skill really is held back, and the reason is in the file itself. */
function chipFor(skill: SkillEntry): string | null {
  const state = stateOf(skill);
  if (state && STATE_CHIP[state]) return STATE_CHIP[state]!;
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
    <div v-if="total > 0" class="sk__bar">
      <div class="sk__pills" role="group" aria-label="Filter by origin">
        <button
          type="button"
          class="pill"
          :class="{ 'is-on': origin === null }"
          @click="origin = null"
        >
          All<span class="pill__n">{{ total }}</span>
        </button>
        <button
          v-for="o in originCounts"
          :key="o.id"
          type="button"
          class="pill"
          :class="{ 'is-on': origin === o.id }"
          @click="origin = origin === o.id ? null : o.id"
        >
          {{ o.label }}<span class="pill__n">{{ o.count }}</span>
        </button>
      </div>

      <input
        v-model="query"
        type="search"
        class="sk__input"
        placeholder="Search skills"
        aria-label="Search skills"
      />
    </div>

    <template v-if="loading">
      <ul class="grid placeholders" aria-hidden="true">
        <li v-for="n in 6" :key="n" class="placeholder" :style="{ animationDelay: `${n * 120}ms` }" />
      </ul>
    </template>
    <template v-else-if="empty">
      <p class="sk__empty">No skills found on this machine.</p>
    </template>
    <template v-else-if="noMatch">
      <p class="sk__empty">Nothing matches “{{ query }}”.</p>
    </template>
    <template v-else>
      <ul class="grid">
        <li v-for="s in filtered" :key="s.path" class="card">
          <button type="button" class="card__hit" @click="emit('open', s)">
            <SkillMark
              class="card__cover"
              cover
              :name="s.name"
              :origin="s.origin"
              :muted="stateOf(s) === 'disabled'"
            >
              <span class="tiles">
                <span v-for="o in coverOrigins(s)" :key="o" class="tile">
                  <ProviderLogo v-if="BRAND[o]" :brand="BRAND[o]!" :size="17" />
                  <span v-else class="tile__letter">{{ (ORIGIN_LABEL[o] ?? o).slice(0, 1) }}</span>
                </span>
              </span>
            </SkillMark>

            <span class="card__name">{{ s.displayName ?? s.name }}</span>
            <span v-if="s.shortDescription ?? s.description" class="card__desc">
              {{ s.shortDescription ?? s.description }}
            </span>
          </button>

          <span class="card__foot">
            <span class="card__by">{{ ORIGIN_LABEL[s.origin] ?? s.origin }}</span>

            <span class="card__end">
              <span v-if="chipFor(s)" class="chip">{{ chipFor(s) }}</span>
              <span v-else-if="stateOf(s) === 'unsupported'" class="card__nosw">no switch</span>

              <span v-if="switchable(s)" class="card__switch">
                <ToggleSwitch
                  :model-value="stateOf(s) !== 'disabled'"
                  :aria-label="`Turn ${s.name} ${stateOf(s) === 'disabled' ? 'on' : 'off'}`"
                  @update:model-value="flip(s)"
                />
              </span>
            </span>
          </span>
        </li>
      </ul>

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

/* ── bar ──────────────────────────────────────────────────────────────────── */
.sk__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.sk__pills {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
/* Origin is the one facet worth a permanent control: it is how a person holds
   forty skills in their head ("the Claude ones"), and the count is the answer
   to the question the pill raises. */
.pill {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 12.5px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}
.pill:hover {
  background-color: var(--hover);
  color: var(--ink-soft);
}
/* The chosen facet is the one thing on this bar that changes what is below it,
   so it is the one place worth spending full contrast. */
.pill.is-on {
  background-color: var(--ink);
  color: var(--ground);
}
.pill.is-on:hover {
  background-color: var(--ink);
  color: var(--ground);
}
.pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pill__n {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--faint);
}
.pill.is-on .pill__n {
  color: color-mix(in srgb, var(--ground) 65%, transparent);
}

.sk__input {
  width: min(200px, 100%);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--line-soft);
  padding: 5px 0;
  font-size: 13px;
  color: var(--ink);
  outline: none;
  transition: border-color 140ms ease;
}
.sk__input::placeholder {
  color: var(--placeholder);
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

/* ── grid ─────────────────────────────────────────────────────────────────── */
/* A skill has no logo, so the generated cover is what makes forty of them
   tellable apart at a glance — which only works at a size worth looking at. The
   columns are as wide as the covers need, not as many as would fit. */
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 26px 22px;
}
@container (min-width: 520px) {
  .grid {
    grid-template-columns: 1fr 1fr;
  }
}
@container (min-width: 860px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@container (min-width: 1240px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

/* The card is the cover plus what it is called — no box drawn round it, no
   border, no shadow. The wash on hover is the only frame it ever gets, and it
   sits behind everything rather than enclosing it. */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.card::before {
  content: "";
  position: absolute;
  inset: -10px -10px -8px;
  border-radius: 18px;
  background-color: var(--hover);
  opacity: 0;
  transition: opacity 180ms ease;
  pointer-events: none;
}
.card:hover::before,
.card:focus-within::before {
  opacity: 1;
}

.card__hit {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  border-radius: 14px;
}
.card__hit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.card__cover {
  transition:
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 220ms ease,
    opacity 220ms ease;
}
.card:hover .card__cover {
  transform: translateY(-2px);
}

/* The white tiles set into the cover: one per agent that holds a copy of this
   name, so a shadowed skill says so before it is opened. */
.tiles {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tile {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background-color: #ffffff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}
.tile__letter {
  font-family: var(--font-mono);
  font-size: 12px;
  color: #4a4a4a;
}

.card__name {
  margin-top: 12px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card__desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  /* Two lines, then stop. A description is written to be read in a listing, and
     a card that grows to fit the longest one breaks the row it sits in. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

/* ── the foot of the card ─────────────────────────────────────────────────── */
/* Pushed to the bottom rather than trailing the description, so a one-line and a
   two-line card standing next to each other still say who owns them on the same
   line — the row reads across as well as down. */
.card__foot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 10px;
  min-height: 20px;
}
.card__by {
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
}

/* One slot, two occupants: the chip states the exception at rest, and the switch
   takes its place under the pointer. Nothing moves — they cross-fade in the same
   grid cell — so a card never resizes as the mouse crosses it. */
/* Held to the height of the line it shares rather than to its tallest occupant:
   a switch is half again as tall as a chip, and letting it set the foot's height
   would drop that card's origin line below its neighbours' across the row. It
   overhangs the line instead, centred on it. */
.card__end {
  display: grid;
  place-items: center end;
  flex-shrink: 0;
  height: 20px;
}
.card__end > * {
  grid-area: 1 / 1;
}
.chip,
.card__nosw {
  transition: opacity 160ms ease;
}
.card__switch {
  opacity: 0;
  transition: opacity 160ms ease;
  pointer-events: none;
}
.card:hover .card__switch,
.card:focus-within .card__switch {
  opacity: 1;
  pointer-events: auto;
}
/* The chip steps aside only for a switch that is actually there to take its
   place. A card with nothing to swap in keeps what it was saying, since blanking
   it under the pointer reads as a control that failed to appear. */
.card:hover .card__end:has(.card__switch) .chip,
.card:focus-within .card__end:has(.card__switch) .chip {
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
.card__nosw {
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
  aspect-ratio: 16 / 9;
  border-radius: 14px;
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
  .card::before,
  .card__cover,
  .card__switch,
  .chip,
  .pill {
    transition: none;
  }
  .card:hover .card__cover {
    transform: none;
  }
}
</style>
