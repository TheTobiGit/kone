<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon, Globe02Icon, Package02Icon, PuzzleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import type { PluginEntry, SkillEntry } from "~/types/desktop";
import type { useAgentSettings } from "~/composables/useAgentSettings";
import { isKonePluginEnabled, type useSkills } from "~/composables/useSkills";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import type { BrandKey } from "~/utils/modelCatalog";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useEdgeFade } from "~/composables/useEdgeFade";

// Cards like the Discover reference — flat top, no gradient, no byline.
// Logos are the providers the skill is reachable from. `agents` = shared
// (shows all providers except claude), others = single provider.

const props = defineProps<{
  space: ReturnType<typeof useAgentSettings>;
  skills: ReturnType<typeof useSkills>;
}>();

const emit = defineEmits<{ open: [SkillEntry]; openPlugin: [PluginEntry] }>();

const ORIGIN_TO_BRAND: Record<string, BrandKey> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  factory: "droid",
};

const AGENTS_BRANDS: BrandKey[] = ["codex", "cursor", "opencode", "droid", "antigravity"];

function brandsFor(skill: SkillEntry): BrandKey[] {
  if (skill.origin === "agents") return AGENTS_BRANDS;
  const b = ORIGIN_TO_BRAND[skill.origin];
  return b ? [b] : ["generic"];
}

const { recents } = useRecentProjects();

function projectsFor(skill: SkillEntry): string[] {
  if (skill.scope !== "project") return [];
  const p = skill.path;
  let best: { path: string; name: string } | null = null;
  for (const r of recents.value) {
    if (p.startsWith(r.path + "/") && (!best || r.path.length > best.path.length)) {
      best = { path: r.path, name: r.name ?? r.path.split("/").pop() ?? r.path };
    }
  }
  const label = best ? best.name : p.split("/").slice(-3, -2)[0] ?? "project";
  return [label];
}

const all = computed(() => props.space.inventory.value?.skills ?? []);
const plugins = computed(() => props.space.inventory.value?.plugins ?? []);

function label(skill: SkillEntry): string {
  return skill.displayName ?? skill.name;
}

function describe(skill: SkillEntry): string | null {
  return skill.description ?? skill.shortDescription ?? null;
}

const query = ref("");
const typeFilter = ref<"all" | "skill" | "plugin">("all");
const providerFilter = ref<string | null>(null);

const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  agents: "Shared",
  factory: "Factory",
};

const PROVIDER_ORDER = ["agents", "claude", "codex", "cursor", "opencode", "factory"] as const;

const providerOptions = computed(() => {
  const counts = new Map<string, number>();
  const includeSkills = typeFilter.value !== "plugin";
  const includePlugins = typeFilter.value !== "skill";
  if (includeSkills) {
    for (const s of all.value) counts.set(s.origin, (counts.get(s.origin) ?? 0) + 1);
  }
  if (includePlugins) {
    for (const p of plugins.value) counts.set(p.origin, (counts.get(p.origin) ?? 0) + 1);
  }
  const orderSet = new Set<string>(PROVIDER_ORDER);
  const extras = [...counts.keys()].filter((k) => !orderSet.has(k));
  const order: string[] = [...PROVIDER_ORDER, ...extras];
  return order
    .filter((o) => (counts.get(o) ?? 0) > 0 || o === providerFilter.value)
    .map((origin) => ({ origin, label: ORIGIN_LABEL[origin] ?? origin, count: counts.get(origin) ?? 0 }));
});

function matchesProvider(origin: string): boolean {
  return !providerFilter.value || origin === providerFilter.value;
}

const filteredSkills = computed(() => {
  const q = query.value.trim().toLowerCase();
  return all.value.filter((s) => {
    if (typeFilter.value === "plugin") return false;
    if (!matchesProvider(s.origin)) return false;
    if (!q) return true;
    const hay = [s.name, s.displayName, s.description, s.shortDescription].join(" ").toLowerCase();
    return hay.includes(q);
  });
});

const filteredPlugins = computed(() => {
  const q = query.value.trim().toLowerCase();
  return plugins.value.filter((p) => {
    if (typeFilter.value === "skill") return false;
    if (!matchesProvider(p.origin)) return false;
    if (!q) return true;
    const hay = [p.name, p.description, ...p.skills.map((s) => s.name)].join(" ").toLowerCase();
    return hay.includes(q);
  });
});

const loading = computed(
  () => props.space.inventoryLoading.value && !props.space.inventoryLoaded.value,
);
const hasAny = computed(() => all.value.length + plugins.value.length > 0);
const noMatch = computed(
  () => !loading.value && hasAny.value && filteredSkills.value.length === 0 && filteredPlugins.value.length === 0,
);
const emptyAll = computed(
  () => props.space.inventoryLoaded.value && !loading.value && !hasAny.value,
);

const errors = computed(
  () => props.space.inventory.value?.errors.filter((e) => /skill/i.test(e.source)) ?? [],
);

// enabled toggle — far right of name row
watch(
  all,
  (skills) => {
    if (skills.length) void props.skills.loadStates(skills);
  },
  { immediate: true },
);

function isEnabled(skill: SkillEntry): boolean {
  return props.skills.isEffectiveEnabled(skill);
}

async function flip(skill: SkillEntry): Promise<void> {
  // One coordinated write — CLI restore plus kone gate, ordered inside the
  // composable. Per-key busy there keeps parallel row toggles independent.
  await props.skills.setEffectiveEnabled(skill, !isEnabled(skill));
}

function isPluginEnabled(plugin: PluginEntry): boolean {
  return isKonePluginEnabled(plugin);
}

async function flipPlugin(plugin: PluginEntry): Promise<void> {
  await props.skills.setPluginEnabled(plugin, !isPluginEnabled(plugin));
}

const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);
</script>

<template>
  <section class="sk" aria-label="Skills">
    <div v-if="loading" class="sk__loadingWrap">
      <div class="sk__loading">
        <span v-for="n in 6" :key="n" class="placeholder" :style="{ animationDelay: `${n * 90}ms` }" />
      </div>
    </div>

    <p v-else-if="emptyAll" class="sk__empty sk__empty--standalone">No skills found on this machine.</p>

    <template v-else>
      <div class="sk__filters">
        <div class="bar">
          <div class="filters">
            <button type="button" class="chip" :class="{ on: typeFilter === 'all' }" @click="typeFilter = 'all'">All</button>
            <button type="button" class="chip" :class="{ on: typeFilter === 'skill' }" @click="typeFilter = typeFilter === 'skill' ? 'all' : 'skill'">
              <HugeiconsIcon :icon="PuzzleIcon" :size="12" :stroke-width="1.8" aria-hidden="true" /> Skills
            </button>
            <button type="button" class="chip" :class="{ on: typeFilter === 'plugin' }" @click="typeFilter = typeFilter === 'plugin' ? 'all' : 'plugin'">
              <HugeiconsIcon :icon="Package02Icon" :size="12" :stroke-width="1.8" aria-hidden="true" /> Plugins
            </button>
          </div>
          <label class="search">
            <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
            <input v-model="query" type="search" placeholder="Search skills…" aria-label="Search skills" />
          </label>
        </div>

        <div v-if="providerOptions.length > 1" class="providers" role="group" aria-label="Filter by provider">
          <button
            type="button"
            class="chip chip--provider"
            :class="{ on: !providerFilter }"
            @click="providerFilter = null"
          >
            All providers
          </button>
          <button
            v-for="opt in providerOptions"
            :key="opt.origin"
            type="button"
            class="chip chip--provider"
            :class="{ on: providerFilter === opt.origin }"
            :aria-pressed="providerFilter === opt.origin"
            @click="providerFilter = providerFilter === opt.origin ? null : opt.origin"
          >
            <span class="chip__logo" aria-hidden="true">
              <HugeiconsIcon v-if="opt.origin === 'agents'" :icon="PuzzleIcon" :size="12" :stroke-width="1.8" />
              <ProviderLogo v-else :brand="ORIGIN_TO_BRAND[opt.origin] ?? 'generic'" :size="13" />
            </span>
            {{ opt.label }}
            <span class="chip__count">{{ opt.count }}</span>
          </button>
        </div>
      </div>

      <div ref="scroller" class="sk__scroll" :style="maskStyle" @scroll.passive="measure">
        <p v-if="noMatch" class="sk__empty">
          <template v-if="providerFilter && query.trim()">
            No {{ providerFilter ? ORIGIN_LABEL[providerFilter] ?? providerFilter : "" }} match for “{{ query }}”.
          </template>
          <template v-else-if="providerFilter"> No {{ ORIGIN_LABEL[providerFilter] ?? providerFilter }} skills found. </template>
          <template v-else>No match for “{{ query }}”.</template>
        </p>

        <ul v-else class="grid">
          <!-- plugins as folders — container of skills -->
          <li
            v-for="p in filteredPlugins"
            :key="p.path"
            class="card card--plugin"
            :class="{ 'card--disabled': !isPluginEnabled(p) }"
            @click="emit('openPlugin', p)"
          >
            <div class="card__top">
              <div class="icons">
                <!-- SAFETY: Plugin origin string conforms to SkillEntry origin type for brand resolution -->
                <span v-for="b in brandsFor({ origin: p.origin } as SkillEntry)" :key="b" class="icon">
                  <ProviderLogo :brand="b" :size="18" />
                </span>
              </div>
              <div class="scopeRow">
                <HugeiconsIcon :icon="Package02Icon" :size="11" :stroke-width="1.8" class="scopeIcon" aria-label="Plugin" />
                <HugeiconsIcon
                  :icon="p.scope === 'project' ? Folder01Icon : Globe02Icon"
                  :size="11"
                  :stroke-width="1.8"
                  class="scopeIcon"
                  :aria-label="p.scope === 'project' ? 'Project' : 'Global'"
                />
                <span class="proj">{{ p.skills.length }} skill{{ p.skills.length === 1 ? "" : "s" }}</span>
              </div>
            </div>
            <div class="card__body">
              <div class="card__head">
                <span class="card__name">{{ p.name }}</span>
                <ToggleSwitch
                  :model-value="isPluginEnabled(p)"
                  :disabled="props.skills.isPluginBusy(p)"
                  :aria-label="`Turn plugin ${p.name} ${isPluginEnabled(p) ? 'off' : 'on'}`"
                  @update:model-value="flipPlugin(p)"
                  @click.stop
                />
              </div>
              <span v-if="p.description" class="card__desc">{{ p.description }}</span>
              <span v-else class="card__desc">Plugin — {{ p.skills.length }} bundled skill{{ p.skills.length === 1 ? "" : "s" }}</span>
            </div>
          </li>

          <li
            v-for="s in filteredSkills"
            :key="s.path"
            class="card"
            :class="{ 'card--disabled': !isEnabled(s) }"
            @click="emit('open', s)"
          >
            <div class="card__top">
              <div class="icons">
                <span v-for="b in brandsFor(s)" :key="b" class="icon">
                  <ProviderLogo :brand="b" :size="18" />
                </span>
              </div>
              <div class="scopeRow">
                <HugeiconsIcon :icon="PuzzleIcon" :size="11" :stroke-width="1.8" class="scopeIcon" aria-label="Skill" />
                <HugeiconsIcon
                  :icon="s.scope === 'project' ? Folder01Icon : Globe02Icon"
                  :size="11"
                  :stroke-width="1.8"
                  class="scopeIcon"
                  :aria-label="s.scope === 'project' ? 'Project' : 'Global'"
                />
                <template v-if="s.scope === 'project'">
                  <span v-for="proj in projectsFor(s)" :key="proj" class="proj">{{ proj }}</span>
                </template>
                <span v-if="s.shadowed" class="proj proj--shadowed" title="Shadowed by a higher-precedence copy">Shadowed</span>
              </div>
            </div>
            <div class="card__body">
              <div class="card__head">
                <span class="card__name">{{ label(s) }}</span>
                <ToggleSwitch
                  :model-value="isEnabled(s)"
                  :disabled="props.skills.isSkillBusy(s)"
                  :aria-label="`Turn ${s.name} ${isEnabled(s) ? 'off' : 'on'}`"
                  @update:model-value="flip(s)"
                  @click.stop
                />
              </div>
              <span v-if="describe(s)" class="card__desc">{{ describe(s) }}</span>
            </div>
          </li>
        </ul>

        <ul v-if="errors.length" class="sk__errors">
          <li v-for="e in errors" :key="e.source" class="sk__error">
            couldn't read {{ e.source }}: {{ e.message }}
          </li>
        </ul>
      </div>
    </template>

    <ul v-if="(loading || emptyAll) && errors.length" class="sk__errors sk__errors--outside">
      <li v-for="e in errors" :key="e.source" class="sk__error">
        couldn't read {{ e.source }}: {{ e.message }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.sk__filters {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  flex-shrink: 0;
  padding: 0 1rem 0.75rem;
}

.sk__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  padding: 0 1rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.sk__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.sk__loadingWrap {
  padding: 0 1rem;
}

.sk__empty {
  font-size: 14px;
  color: var(--muted);
  padding: 1.25rem 0;
}
.sk__empty--standalone {
  padding: 1.25rem 1rem;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
}

.chip.on {
  background: var(--ink);
  color: var(--panel);
  border-color: var(--ink);
}

.chip.on .scopeIcon { color: currentColor; }

.providers {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.chip--provider {
  padding: 4px 10px;
  font-size: 11.5px;
  gap: 6px;
}

.chip__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.chip__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--muted);
}

.chip.on .chip__count {
  background: color-mix(in srgb, var(--panel) 18%, transparent);
  color: var(--panel);
}

.search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--panel);
  color: var(--faint);
  flex: 1;
  max-width: 260px;
}

.search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--ink);
  min-width: 0;
}

.search input::placeholder { color: var(--faint); }

/* grid like the Discover reference: 2-col on desktop, 1 on narrow */
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

/* double outline like the wire: outer card + inset top — tight top/left/right */
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 6px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 16px;
  background: var(--panel);
  cursor: pointer;
  transition: border-color 160ms ease;
}

.card:hover {
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
}

.card--disabled {
  opacity: 0.62;
}

.card--disabled:hover {
  opacity: 0.88;
}

/* folder container — plugin is a folder of skills */
.card--plugin {
  border-color: color-mix(in srgb, var(--ink) 16%, transparent);
}
.card--plugin .card__top {
  background: color-mix(in srgb, var(--panel) 90%, var(--band) 10%);
  /* subtle stacked edge */
  box-shadow: inset 0 -1px 0 var(--line-soft);
}
.card--plugin .card__top::before {
  content: "";
  position: absolute;
  top: 6px;
  left: 12px;
  width: 28px;
  height: 6px;
  background: var(--panel);
  border: 1px solid var(--line-soft);
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  opacity: 0.9;
}

/* inset top — own border + radius, flat band, no gradient, no icon boxes */
.card__top {
  height: 88px;
  position: relative;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--panel) 96%, var(--band) 4%);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  flex-shrink: 0;
  overflow: hidden;
}

.icons {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
  padding-bottom: 10px;
  color: color-mix(in srgb, var(--ink) 78%, transparent);
}

.scopeRow {
  position: absolute;
  left: 9px;
  bottom: 7px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  max-width: calc(100% - 18px);
}

.scopeRow .scopeIcon {
  color: var(--faint);
  flex-shrink: 0;
}

.proj {
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  color: var(--muted);
  white-space: nowrap;
}

.proj--shadowed {
  border-color: color-mix(in srgb, var(--ink) 18%, transparent);
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  font-style: italic;
}

/* no box — just the mark, sized for the band */
.icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  /* subtle lift so the mark doesn't feel pasted on the flat band */
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.04));
}

@media (prefers-color-scheme: dark) {
  .card__top {
    background: color-mix(in srgb, var(--panel) 88%, black 12%);
  }
  .icons {
    color: color-mix(in srgb, var(--ink) 88%, transparent);
  }
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px 10px;
  min-width: 0;
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.card__name {
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__desc {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: calc(12.5px * 1.45 * 2);
}

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

.sk__loading {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  padding: 8px 0;
}

.sk__loading .placeholder {
  display: block;
  height: 182px;
  border-radius: 18px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
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
}
</style>
