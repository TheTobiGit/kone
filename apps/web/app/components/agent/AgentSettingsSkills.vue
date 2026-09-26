<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon, Globe02Icon, Package02Icon, PuzzleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import type { PluginEntry, SkillEntry } from "~/types/desktop";
import type { useAgentSettings } from "~/composables/useAgentSettings";
import { isKonePluginEnabled, type useSkills } from "~/composables/useSkills";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import SettingsBanner from "~/components/settings/SettingsBanner.vue";
import { ORIGIN_TO_BRAND, brandsForOrigin, originLabel } from "~/utils/detailFormat";
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
    .map((origin) => ({ origin, label: originLabel(origin), count: counts.get(origin) ?? 0 }));
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

/** Up to three skill names for a plugin's deck, front first. An empty plugin
 *  still gets one sheet, so every plugin card reads as a bundle. */
function bundleSheets(plugin: PluginEntry): string[] {
  const names = plugin.skills.slice(0, 3).map((sk) => sk.name);
  return names.length ? names : ["No skills yet"];
}

async function flipPlugin(plugin: PluginEntry): Promise<void> {
  await props.skills.setPluginEnabled(plugin, !isPluginEnabled(plugin));
}

// ── banner ──────────────────────────────────────────────────────────────────
/** Every provider something was found under, in the filter's order. */
const origins = computed(() => {
  const found = new Set<string>([...all.value.map((s) => s.origin), ...plugins.value.map((p) => p.origin)]);
  const known = PROVIDER_ORDER.filter((o) => found.has(o));
  const orderSet = new Set<string>(PROVIDER_ORDER);
  return [...known, ...[...found].filter((o) => !orderSet.has(o))];
});
const onCount = computed(() => all.value.filter((s) => isEnabled(s)).length);

// While the first scan runs the counts hold their places with a dash, so the
// band doesn't change height when they land.
const bannerStats = computed(() => {
  if (loading.value) {
    return [
      { label: "Skills", value: "–" },
      { label: "Active", value: "–" },
    ];
  }
  return [
    { label: "Skills", value: all.value.length },
    { label: "Active", value: onCount.value },
    ...(plugins.value.length ? [{ label: "Plugins", value: plugins.value.length }] : []),
  ];
});

const ART_SOURCES = 4;
const artSources = computed(() => origins.value.slice(0, ART_SOURCES));
const artOverflow = computed(() => Math.max(0, origins.value.length - ART_SOURCES));
/** What the sources fill: skills, plugins, and the skills a project carries. */
const ART_KINDS = [PuzzleIcon, Package02Icon, Folder01Icon] as const;

const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);
</script>

<template>
  <section class="sk" aria-label="Skills">
    <div class="sk__top">
      <SettingsBanner
        title="Skills"
        lede="What your agents know how to do, gathered from every provider and project, and switched on or off in one place."
        :stats="bannerStats"
      >
        <template #art>
          <!-- Providers → what they bring. Decorative: the counts beside it and
               the filters below name every provider. -->
          <div class="sk-art">
            <div class="sk-art__sources">
              <span
                v-for="(o, i) in artSources"
                :key="o"
                class="sk-art__source"
                :style="{ '--i': i }"
              >
                <HugeiconsIcon v-if="o === 'agents'" :icon="PuzzleIcon" :size="17" :stroke-width="1.7" />
                <ProviderLogo v-else :brand="ORIGIN_TO_BRAND[o] ?? 'generic'" :size="18" />
              </span>
              <!-- Nothing scanned yet: the places a scan looks still stand in,
                   so the current always has somewhere to start. -->
              <span v-if="!artSources.length" class="sk-art__source" :style="{ '--i': 0 }">
                <HugeiconsIcon :icon="Globe02Icon" :size="17" :stroke-width="1.7" />
              </span>
              <span v-if="artOverflow" class="sk-art__source sk-art__source--more" :style="{ '--i': ART_SOURCES }">
                +{{ artOverflow }}
              </span>
            </div>

            <svg class="sk-art__current" viewBox="0 0 64 40" preserveAspectRatio="none">
              <path class="sk-art__track" d="M2 20 C 22 20, 26 6, 62 6 M2 20 H62 M2 20 C 22 20, 26 34, 62 34" />
              <path class="sk-art__flow" d="M2 20 C 22 20, 26 6, 62 6 M2 20 H62 M2 20 C 22 20, 26 34, 62 34" />
            </svg>

            <div class="sk-art__kinds">
              <span v-for="(k, i) in ART_KINDS" :key="i" class="sk-art__kind" :style="{ '--i': i }">
                <HugeiconsIcon :icon="k" :size="13" :stroke-width="1.8" />
              </span>
            </div>
          </div>
        </template>
      </SettingsBanner>
    </div>

    <!-- Loading mirrors the loaded structure (filters bar + card grid) with the
      same layout classes, so resolving the scan swaps backgrounds, not boxes:
      invisible text locks the metrics, shimmer blocks stand in for glyphs and
      toggles. Anything structural here must stay identical to the branch below
      or the open transition shifts. -->
    <div v-if="loading" class="sk__loadingWrap" aria-hidden="true">
      <div class="sk__filters">
        <div class="bar">
          <div class="filters">
            <span class="chip"><span class="skel-text">All</span></span>
            <span class="chip"><span class="skel-glyph" /><span class="skel-text">Skills</span></span>
            <span class="chip"><span class="skel-glyph" /><span class="skel-text">Plugins</span></span>
          </div>
          <span class="search"><span class="skel-glyph skel-glyph--lg" /><span class="skel-text">Search skills…</span></span>
        </div>
        <div class="providers">
          <span class="chip chip--provider"><span class="skel-text">All providers</span></span>
          <span v-for="n in 3" :key="n" class="chip chip--provider"><span class="skel-glyph" /><span class="skel-text">Provider</span></span>
        </div>
      </div>

      <div class="sk__scroll sk__scroll--skel">
        <ul class="grid">
          <li
            v-for="n in 6"
            :key="n"
            class="card card--skel"
            :style="{ animationDelay: `${n * 90}ms` }"
          >
            <div class="card__top card__top--skel" />
            <div class="card__body">
              <div class="card__head">
                <span class="card__name"><span class="skel-text">Skill name</span></span>
                <span class="skel-toggle" />
              </div>
              <span class="card__desc"><span class="skel-text">A description shape holding the row height.</span></span>
            </div>
          </li>
        </ul>
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
            No {{ providerFilter ? originLabel(providerFilter) : "" }} match for “{{ query }}”.
          </template>
          <template v-else-if="providerFilter"> No {{ originLabel(providerFilter) }} skills found. </template>
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
            <div class="card__top card__top--bundle">
              <span class="bundle__from">
                <span v-for="b in brandsForOrigin(p.origin)" :key="b" class="icon">
                  <ProviderLogo :brand="b" :size="14" />
                </span>
              </span>
              <!-- The skills it carries, as a deck: the first on top, the next
                   two peeking behind it. -->
              <div class="bundle" aria-hidden="true">
                <span
                  v-for="(sk, j) in bundleSheets(p)"
                  :key="j"
                  class="bundle__sheet"
                  :style="{ '--j': j }"
                >
                  <HugeiconsIcon :icon="PuzzleIcon" :size="11" :stroke-width="1.8" class="bundle__glyph" />
                  <span class="bundle__name">{{ sk }}</span>
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
                <span v-for="b in brandsForOrigin(s.origin)" :key="b" class="icon">
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

/* The banner, fixed above the filters. The same inline padding as the rows
   below, so the band lines up with the cards. */
.sk__top {
  flex-shrink: 0;
  padding: 2px 1rem 16px;
}

/* ── banner art ── */
.sk-art {
  --sk-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  display: flex;
  align-items: center;
  gap: 4px;
}
.sk-art__sources {
  display: flex;
  align-items: center;
}
.sk-art__source {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-left: -10px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-soft);
  box-shadow: 0 0 0 2.5px var(--sunken);
  animation: sk-art-in 520ms var(--sk-spring) calc(var(--i) * 60ms + 120ms) backwards;
}
.sk-art__source:first-child {
  margin-left: 0;
}
.sk-art__source--more {
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
@keyframes sk-art-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.8);
  }
}
.sk-art__current {
  width: 64px;
  height: 40px;
  overflow: visible;
  fill: none;
  stroke-linecap: round;
}
.sk-art__track {
  stroke: color-mix(in srgb, var(--ink) 14%, transparent);
  stroke-width: 1.2;
}
.sk-art__flow {
  stroke: var(--accent);
  stroke-width: 1.4;
  stroke-dasharray: 5 60;
  animation: sk-art-flow 2.6s linear infinite;
}
@keyframes sk-art-flow {
  from {
    stroke-dashoffset: 65;
  }
  to {
    stroke-dashoffset: 0;
  }
}
.sk-art__kinds {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.sk-art__kind {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink-soft);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
  animation: sk-art-in 520ms var(--sk-spring) calc(var(--i) * 70ms + 420ms) backwards;
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
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* Skeleton stand-ins: same boxes as the real rows, only the fill differs.
   Invisible text keeps the exact font metrics; the glyph/toggle blocks match
   the icon and switch sizes they cover for. */
.skel-text {
  display: inline-block;
  color: transparent;
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 5px;
  user-select: none;
}
.skel-glyph {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.skel-glyph--lg {
  width: 14px;
  height: 14px;
}
.skel-toggle {
  width: 40px;
  height: 24px;
  flex: none;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.sk__loadingWrap .chip,
.sk__loadingWrap .search {
  pointer-events: none;
}
.card--skel {
  pointer-events: none;
  cursor: default;
  animation: sk-breathe 1700ms ease-in-out infinite;
}
.card__top--skel {
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.sk__scroll--skel {
  overflow: hidden;
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
  /* Offscreen cards skip layout and paint until scrolled near: mounting a
     forty-skill inventory resolves in one tick, and without this every card's
     SVG and toggle lays out synchronously inside the open transition's frame.
     The estimate keeps the scrollbar steady before first render. */
  content-visibility: auto;
  contain-intrinsic-size: auto 182px;
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

/* A plugin is a bundle of skills, and its card shows that rather than saying
   it: where a skill card has its provider's mark, a plugin's band holds a
   small deck of the skills it carries, the first face up and the next two
   peeking out behind. The band takes a trace of the accent so a plugin can be
   picked out of a mixed grid at a glance; the provider shrinks to a corner. */
.card--plugin .card__top--bundle {
  background:
    radial-gradient(90% 120% at 50% 0%, color-mix(in oklab, var(--accent) 7%, transparent), transparent 70%),
    color-mix(in srgb, var(--panel) 94%, var(--band) 6%);
}
.bundle__from {
  position: absolute;
  top: 9px;
  left: 10px;
  display: flex;
  gap: 5px;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}
.bundle {
  position: absolute;
  top: 34px;
  left: 50%;
  width: min(62%, 200px);
  height: 23px;
  transform: translateX(-50%);
}
.bundle__sheet {
  position: absolute;
  inset: 0;
  z-index: calc(3 - var(--j));
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 7px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent);
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  transform-origin: 50% 0;
  transform: translateY(calc(var(--j) * -5px)) scale(calc(1 - var(--j) * 0.06));
  transition:
    transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1),
    color 200ms ease;
}
.bundle__sheet:first-child {
  color: var(--ink-soft);
}
.bundle__glyph {
  flex-shrink: 0;
  color: var(--faint);
}
/* At rest only the edges of the sheets behind show; their names would be
   half-covered scraps, so they wait for the hover that makes room for them. */
.bundle__sheet:not(:first-child) > * {
  opacity: 0;
  transition: opacity 160ms ease;
}
.bundle__sheet:first-child .bundle__glyph {
  color: var(--accent);
}
.bundle__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Hover lifts the sheets behind apart, far enough to read their names — the
   card shows what's inside before you open it. */
.card--plugin:hover .bundle__sheet {
  transform: translateY(calc(var(--j) * -15px)) scale(calc(1 - var(--j) * 0.03));
  color: var(--ink-soft);
}
.card--plugin:hover .bundle__sheet:not(:first-child) > * {
  opacity: 1;
  transition-delay: 80ms;
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
  .sk-art__source,
  .sk-art__kind,
  .sk-art__flow {
    animation: none;
  }
  .card--skel {
    animation: none;
    opacity: 0.75;
  }
  .bundle__sheet {
    transition: none;
  }
}
</style>
