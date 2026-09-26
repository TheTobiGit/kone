<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useStorage } from "@vueuse/core";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Folder02Icon,
  RoboticIcon,
  SparklesIcon,
  UserGroupIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import SettingsBanner from "~/components/settings/SettingsBanner.vue";
import SettingsAgentDetail from "~/components/settings/SettingsAgentDetail.vue";
import SettingsSubagentDetail from "~/components/settings/SettingsSubagentDetail.vue";
import CreateAgentModal from "~/components/agent/CreateAgentModal.vue";
import CreateSubagentModal from "~/components/presets/CreateSubagentModal.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import { BUILTIN_SUBAGENT_PRESETS } from "@kone/protocol/subagent-presets";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSubagentPresets } from "~/composables/useSubagentPresets";
import { useSound } from "~/composables/useSound";
import { botGround, botMark } from "~/utils/bot";
import { formatModelChain } from "~/utils/detailFormat";
import { nativeSubagentIcon } from "~/utils/subagentIcons";
import type { Agent } from "~/utils/agents";
import type { AgentModelRef, SubagentPresetRecord } from "~/types/desktop";

// Everyone who does the work, on one page: the agents a thread is handed to, and
// the sub-agents those agents spawn for a piece of it. They were two panes, but
// they are two ends of one relationship — a lead and the workers it delegates
// to — and choosing either well means seeing the other. So the page opens on
// that relationship (the cast, lead → workers) and then splits into the two
// rosters under one switch, each keeping its own shape: agents are people, drawn
// as portraits in their project teams; sub-agents are definitions, drawn as
// cards carrying their model and their brief.

const props = defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { roster, teams, selected, loadProjectTeam } = useAgentRoster();
const { recents } = useRecentProjects();
const { presets, nativeConfigs, configureNative } = useSubagentPresets();
const { cue } = useSound();

// ── which roster ────────────────────────────────────────────────────────────
type Tab = "agents" | "subagents";
const TABS: readonly Tab[] = ["agents", "subagents"];
const tab = ref<Tab>("agents");
/** Which way the panels slide: forward is agents → sub-agents, the order the
 *  switch reads in, so the content moves the way the pill does. */
const direction = ref<"fwd" | "back">("fwd");
const tablist = ref<HTMLElement>();

/** Tabs whose cards have already dealt in. The deal is an arrival, so it plays
 *  the first time a roster shows and not again on every switch back to it —
 *  by then the reader knows what is there and just wants it. */
const dealt = reactive(new Set<Tab>());

function pickTab(next: Tab) {
  if (next === tab.value) return;
  dealt.add(tab.value);
  direction.value = TABS.indexOf(next) > TABS.indexOf(tab.value) ? "fwd" : "back";
  tab.value = next;
  cue("toggle");
}

// Arrow keys walk the tablist, and focus follows the selection so the pill and
// the ring never point at different tabs.
function onTabKey(e: KeyboardEvent) {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  e.preventDefault();
  const step = e.key === "ArrowRight" ? 1 : -1;
  const at = (TABS.indexOf(tab.value) + step + TABS.length) % TABS.length;
  pickTab(TABS[at]!);
  void nextTick(() => {
    const el = tablist.value?.querySelectorAll<HTMLElement>('[role="tab"]')[at];
    el?.focus();
  });
}

// ── one overlay at a time ───────────────────────────────────────────────────
// The list, a create flow, or one member's page. A union rather than booleans,
// so a modal and a detail can never stack.
type Overlay =
  | { kind: "none" }
  | { kind: "createAgent" }
  | { kind: "createSubagent" }
  | { kind: "agent"; id: string }
  | { kind: "preset"; id: string };
const overlay = ref<Overlay>({ kind: "none" });

// Closing the drawer returns you to the list, so reopening it doesn't drop you
// back inside whichever member or flow you last looked at. The tab stays: it is
// where you were working, not a place you wandered into.
watch(
  () => props.open,
  (open) => {
    if (!open) overlay.value = { kind: "none" };
  },
);

function closeOverlay() {
  overlay.value = { kind: "none" };
}

function openAgent(id: string) {
  overlay.value = { kind: "agent", id };
  cue("press");
}

function openPreset(id: string) {
  overlay.value = { kind: "preset", id };
  cue("press");
}

function startCreate() {
  overlay.value = tab.value === "agents" ? { kind: "createAgent" } : { kind: "createSubagent" };
  cue("open");
}

function onAgentCreated(agent: Agent) {
  overlay.value = { kind: "agent", id: agent.id };
}

function onPresetCreated(created: SubagentPresetRecord) {
  overlay.value = { kind: "preset", id: created.presetId };
}

// ── agents, as teams ────────────────────────────────────────────────────────
// A team lives per project and is only in hand once its project's team has been
// read from the store. This is the whole-app view, not the active project's, so
// it pulls every recent project's team up front rather than waiting for one to
// be opened.
watch(
  recents,
  (list) => {
    for (const p of list) void loadProjectTeam(p.path);
  },
  { immediate: true },
);

/** A project's display name for a path — the name it was opened under, or the
 *  folder it lives in for one that isn't in the recents. */
function nameForPath(path: string): string {
  const known = recents.value.find((p) => p.path === path);
  if (known?.name) return known.name;
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

const NO_TEAM = "__none";

/**
 * The roster laid out as teams: first the agents on no team at all, then one
 * section per project that has a team, its members inside. An agent on several
 * teams appears under each — this is a listing of teams, not a partition of
 * the roster.
 *
 * The no-team section leads, and is there even when it's empty: it's where a
 * new agent lands (an agent starts on no project), so it's where the way to
 * make one sits — and a new-agent tile that moved into whichever project
 * happened to sort last could be folded away with it.
 */
const sections = computed(() => {
  const projectSections = teams.value
    .filter((team) => team.agents.length > 0)
    .map((team) => ({ key: team.path, title: nameForPath(team.path), agents: team.agents }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const teamed = new Set(projectSections.flatMap((s) => s.agents.map((a) => a.id)));
  const loose = roster.value.filter((agent) => !teamed.has(agent.id));

  return [{ key: NO_TEAM, title: "No team", agents: loose }, ...projectSections];
});

// ── folding a team away ─────────────────────────────────────────────────────
// A project's team can be folded down to its heading. Remembered per project
// path, on this machine: which teams you keep open is how you've arranged your
// own view, not a fact about the team. The no-team section doesn't fold: it
// holds the way to make a new agent, which shouldn't be one click from hidden.
const collapsed = useStorage<string[]>("kone.teams.collapsed", []);

function isCollapsed(key: string): boolean {
  return key !== NO_TEAM && collapsed.value.includes(key);
}

function toggleTeam(key: string) {
  const folding = !isCollapsed(key);
  collapsed.value = folding
    ? [...collapsed.value, key]
    : collapsed.value.filter((k) => k !== key);
  cue(folding ? "collapse" : "expand");
}

/** Frame each project as a team only once there's a team to frame — with none
 *  anywhere the roster is one plain grid, and a lone "No team" box names nothing. */
const hasTeams = computed(() => sections.value.some((s) => s.key !== NO_TEAM));

const teamCount = computed(() => sections.value.filter((s) => s.key !== NO_TEAM).length);

// ── sub-agents ──────────────────────────────────────────────────────────────
const natives = computed(() =>
  BUILTIN_SUBAGENT_PRESETS.map((preset) => {
    const config = nativeConfigs.value.find((c) => c.presetId === preset.presetId);
    return {
      presetId: preset.presetId,
      name: preset.name,
      instructions: preset.instructions,
      enabled: config?.enabled ?? true,
      model: config?.model ?? null,
      modelFallbacks: config?.modelFallbacks ?? [],
    };
  }),
);

const nativesOn = computed(() => natives.value.filter((n) => n.enabled).length);
/** Every sub-agent an agent could spawn right now: the built-ins left on, and
 *  every custom preset (a custom preset has no off switch — deleting is how you
 *  retire one). */
const spawnable = computed(() => nativesOn.value + presets.value.length);

const heroStats = computed(() => [
  { label: "Agents", value: roster.value.length },
  ...(teamCount.value ? [{ label: "Teams", value: teamCount.value }] : []),
  { label: "Sub-agents ready", value: spawnable.value },
]);

function toggleNative(presetId: string, enabled: boolean) {
  void configureNative(presetId, { enabled });
}

function chainSummary(
  model: AgentModelRef | null,
  fallbacks: readonly AgentModelRef[] | null | undefined,
): string {
  return formatModelChain(model, fallbacks) ?? "Inherits the caller";
}

function snippetText(instructions: string | null | undefined, empty: string): string {
  const first = instructions?.split(/\n{2,}/)[0]?.trim();
  return first || empty;
}

// ── the cast ────────────────────────────────────────────────────────────────
// The hero's picture of the relationship: a few leads on the left, a few of the
// workers they can call on the right, a current running between. Only a
// handful of each — past four faces a stack stops reading as people and starts
// reading as texture, so the rest collapse into a count.
const CAST_FACES = 4;
const castAgents = computed(() => roster.value.slice(0, CAST_FACES));
const castOverflow = computed(() => Math.max(0, roster.value.length - CAST_FACES));
const castWorkers = computed(() => natives.value.filter((n) => n.enabled).slice(0, 3));

// ── hover: the face follows the pointer ─────────────────────────────────────
// A card's face turns toward the pointer while it's over the card, as if
// someone had caught its eye. The pointer's place is handed to CSS as -1…1 on
// each axis and the stylesheet decides how far that carries, so nothing here
// knows about pixels.
function track(e: PointerEvent) {
  const card = e.currentTarget;
  if (!(card instanceof HTMLElement) || e.pointerType !== "mouse") return;
  const box = card.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * 2 - 1;
  const y = ((e.clientY - box.top) / box.height) * 2 - 1;
  card.style.setProperty("--tx", x.toFixed(3));
  card.style.setProperty("--ty", y.toFixed(3));
}

function untrack(e: PointerEvent) {
  const card = e.currentTarget;
  if (!(card instanceof HTMLElement)) return;
  card.style.setProperty("--tx", "0");
  card.style.setProperty("--ty", "0");
}

/** A label split into its characters for the hover roll. A space becomes a
 *  no-break space, since each character is its own inline-block and a plain
 *  space in one collapses to nothing. */
function glyphs(text: string): string[] {
  return Array.from(text, (ch) => (ch === " " ? "\u00a0" : ch));
}

// ── the scroller ────────────────────────────────────────────────────────────
// The hero and the switch stay put; only the roster under them scrolls. So the
// page runs its own scroller rather than the shell's, and the smoked edge sits
// under the switch — where the roster goes out of view — instead of under the
// masthead, where it would take the switch with it.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

const newLabel = computed(() => (tab.value === "agents" ? "New agent" : "New sub-agent"));
</script>

<template>
  <CreateAgentModal
    v-if="overlay.kind === 'createAgent'"
    @close="closeOverlay"
    @created="onAgentCreated"
  />
  <CreateSubagentModal
    v-if="overlay.kind === 'createSubagent'"
    @close="closeOverlay"
    @created="onPresetCreated"
  />

  <SettingsAgentDetail
    v-if="overlay.kind === 'agent'"
    :open="open"
    :agent-id="overlay.id"
    @back="closeOverlay"
    @switched="(id) => (overlay = { kind: 'agent', id })"
  />

  <SettingsSubagentDetail
    v-else-if="overlay.kind === 'preset'"
    :open="open"
    :preset-id="overlay.id"
    @back="closeOverlay"
    @switched="(id) => (overlay = { kind: 'preset', id })"
  />

  <SettingsPageShell
    v-else
    :open="open"
    :scroll="false"
    breadcrumb="Ecosystem / Teams"
    :breadcrumb-icon="UserGroupIcon"
    label="Teams"
    @back="$emit('back')"
  >
    <template #actions>
      <button
        type="button"
        class="tm__new"
        :tabindex="open ? 0 : -1"
        @click="startCreate"
      >
        <HugeiconsIcon :icon="Add01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <Transition name="tm-swap" mode="out-in">
          <span :key="newLabel">{{ newLabel }}</span>
        </Transition>
      </button>
    </template>

    <div class="tm">
      <div class="tm__top">
        <!-- ── hero: the page's subject, and the relationship it's about ── -->
        <SettingsBanner
          title="Teams"
          lede="The agents you hand a thread to, and the sub-agents they call in for a piece of it."
          :stats="heroStats"
        >
          <template #art>
            <!-- Leads → workers. Decorative: the stats beside it say the same in
                 words, and the rosters below name every member. -->
            <div class="tm__cast" aria-hidden="true">
              <div class="tm__leads">
                <RosterFace
                  v-for="(a, i) in castAgents"
                  :key="a.id"
                  :agent="a"
                  :size="40"
                  :face-size="26"
                  ground="var(--panel)"
                  class="tm__lead"
                  :style="{ '--i': i, '--hue': a.hue }"
                />
                <span v-if="castOverflow" class="tm__lead tm__lead--more" :style="{ '--i': CAST_FACES }">
                  +{{ castOverflow }}
                </span>
              </div>

              <svg class="tm__current" viewBox="0 0 64 40" preserveAspectRatio="none">
                <path class="tm__current-track" d="M2 20 C 22 20, 26 6, 62 6 M2 20 H62 M2 20 C 22 20, 26 34, 62 34" />
                <path class="tm__current-flow" d="M2 20 C 22 20, 26 6, 62 6 M2 20 H62 M2 20 C 22 20, 26 34, 62 34" />
              </svg>

              <div class="tm__workers">
                <span
                  v-for="(w, i) in castWorkers"
                  :key="w.presetId"
                  class="tm__worker"
                  :style="{ '--i': i }"
                >
                  <HugeiconsIcon :icon="nativeSubagentIcon(w.presetId)" :size="13" :stroke-width="1.8" />
                </span>
              </div>
            </div>
          </template>
        </SettingsBanner>

        <!-- ── the switch ── -->
        <div
          ref="tablist"
          class="tm__tabs"
          role="tablist"
          aria-label="Team rosters"
          :data-at="tab"
          @keydown="onTabKey"
        >
          <span class="tm__pill" aria-hidden="true" />
          <button
            id="tm-tab-agents"
            type="button"
            role="tab"
            class="tm__tab"
            :class="{ 'is-on': tab === 'agents' }"
            :aria-selected="tab === 'agents'"
            aria-controls="tm-panel"
            :tabindex="open && tab === 'agents' ? 0 : -1"
            @click="pickTab('agents')"
          >
            <HugeiconsIcon :icon="UserMultiple02Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
            <span>Agents</span>
            <span class="tm__tabcount">{{ roster.length }}</span>
          </button>
          <button
            id="tm-tab-subagents"
            type="button"
            role="tab"
            class="tm__tab"
            :class="{ 'is-on': tab === 'subagents' }"
            :aria-selected="tab === 'subagents'"
            aria-controls="tm-panel"
            :tabindex="open && tab === 'subagents' ? 0 : -1"
            @click="pickTab('subagents')"
          >
            <HugeiconsIcon :icon="RoboticIcon" :size="14" :stroke-width="1.8" aria-hidden="true" />
            <span>Sub-agents</span>
            <span class="tm__tabcount">{{ natives.length + presets.length }}</span>
          </button>
        </div>

      </div>

      <div ref="scroller" class="tm__scroll" :style="maskStyle" @scroll.passive="measure">
        <div
          id="tm-panel"
          class="tm__panel"
          role="tabpanel"
          :aria-labelledby="`tm-tab-${tab}`"
        >
          <Transition :name="`tm-slide-${direction}`" mode="out-in">
            <!-- ── agents ── -->
            <div
              v-if="tab === 'agents'"
              key="agents"
              class="tm__stack tm__stack--teams"
              :class="{ 'is-dealt': dealt.has('agents') }"
            >
              <section
                v-for="(s, si) in sections"
                :key="s.key"
                class="tm-team"
                :class="{ 'is-folded': isCollapsed(s.key) }"
                :aria-label="s.title"
              >
                <!-- A heading on the page rather than a box round the team: the
                     project's name, how many are on it, and a hairline that runs
                     out to the edge. The members below are the team — a frame
                     round them would only repeat that. -->
                <header v-if="hasTeams" class="tm-team__head">
                  <h3 class="tm-team__h">
                    <component
                      :is="s.key === NO_TEAM ? 'span' : 'button'"
                      class="tm-team__row"
                      :class="{ 'tm-team__row--toggle': s.key !== NO_TEAM }"
                      v-bind="
                        s.key === NO_TEAM
                          ? {}
                          : {
                              type: 'button',
                              title: s.key,
                              tabindex: open ? 0 : -1,
                              'aria-expanded': !isCollapsed(s.key),
                              'aria-controls': `tm-team-${si}`,
                            }
                      "
                      @click="s.key !== NO_TEAM && toggleTeam(s.key)"
                    >
                      <HugeiconsIcon
                        :icon="s.key === NO_TEAM ? UserGroupIcon : Folder02Icon"
                        :size="14"
                        :stroke-width="1.8"
                        class="tm-team__glyph"
                        aria-hidden="true"
                      />
                      <span class="tm-team__name">{{ s.title }}</span>
                      <span v-if="s.key !== NO_TEAM" class="tm-team__meta">{{ s.agents.length }}</span>
                      <!-- Folded, the heading keeps a glance of who's inside. -->
                      <Transition name="tm-peek">
                        <span v-if="isCollapsed(s.key)" class="tm-team__peek" aria-hidden="true">
                          <RosterFace
                            v-for="a in s.agents.slice(0, 5)"
                            :key="a.id"
                            :agent="a"
                            :size="20"
                            :face-size="14"
                            ground="var(--panel)"
                            class="tm-team__peekface"
                          />
                        </span>
                      </Transition>
                      <span class="tm-team__rule" aria-hidden="true" />
                      <HugeiconsIcon
                        v-if="s.key !== NO_TEAM"
                        :icon="ArrowDown01Icon"
                        :size="14"
                        :stroke-width="1.8"
                        class="tm-team__chev"
                        aria-hidden="true"
                      />
                    </component>
                  </h3>
                </header>

                <div
                  :id="`tm-team-${si}`"
                  class="tm-team__body"
                  :class="{ 'is-collapsed': isCollapsed(s.key) }"
                  :inert="isCollapsed(s.key)"
                >
                  <div class="tm-team__clip">
                    <div class="tm__grid" role="list" :aria-label="s.title">
                      <article
                        v-for="(c, ci) in s.agents"
                        :key="c.id"
                        role="listitem"
                        class="tm-agent"
                        :class="{ 'is-selected': selected?.id === c.id }"
                        :style="{ '--hue': c.hue, '--i': si * 2 + ci, '--k': ci }"
                        :tabindex="open ? 0 : -1"
                        :aria-label="`${c.name}, ${c.role || 'Agent'}${selected?.id === c.id ? ', in the composer' : ''}`"
                        @click="openAgent(c.id)"
                        @keydown.enter.prevent="openAgent(c.id)"
                        @keydown.space.prevent="openAgent(c.id)"
                        @pointermove="track"
                        @pointerleave="untrack"
                      >
                        <span class="tm-agent__portrait">
                          <!-- A ring in the agent's own hue draws itself round the
                               portrait on hover, with a bead riding its leading end. -->
                          <svg class="tm-agent__ring" viewBox="0 0 100 100" aria-hidden="true">
                            <circle class="tm-agent__ring-line" cx="50" cy="50" r="47" pathLength="1" />
                            <g class="tm-agent__ring-bead">
                              <circle cx="50" cy="3" r="2.6" />
                            </g>
                          </svg>
                          <RosterFace
                            :agent="c"
                            :size="76"
                            :face-size="42"
                            ground="color-mix(in srgb, var(--ink) 7%, transparent)"
                            class="tm-agent__face"
                          >
                            <template #mark>
                              <span
                                v-if="c.bot"
                                class="tm-agent__bot"
                                :style="{ background: botGround(c.bot) }"
                                aria-hidden="true"
                                v-html="botMark(c.bot)"
                              />
                            </template>
                          </RosterFace>
                        </span>

                        <h4 class="tm-agent__name">
                          <span class="sr-only">{{ c.name }}</span>
                          <span class="tm-roll" aria-hidden="true">
                            <span
                              v-for="(ch, k) in glyphs(c.name)"
                              :key="k"
                              class="tm-roll__ch"
                              :data-ch="ch"
                              :style="{ '--c': k }"
                            >{{ ch }}</span>
                          </span>
                        </h4>
                        <p class="tm-agent__role">{{ c.role || "Agent" }}</p>

                        <span v-if="selected?.id === c.id" class="tm-agent__live" aria-hidden="true">
                          <i />In the composer
                        </span>
                      </article>

                      <!-- The way to add one sits where the next one would land. -->
                      <button
                        v-if="s.key === NO_TEAM"
                        type="button"
                        class="tm-add tm-add--agent"
                        :style="{ '--i': si * 2 + s.agents.length, '--k': s.agents.length }"
                        :tabindex="open ? 0 : -1"
                        @click="startCreate"
                      >
                        <!-- An empty portrait: the disc a new agent's face will sit
                             in, ringed on hover the same way a member's is. -->
                        <span class="tm-agent__portrait" aria-hidden="true">
                          <svg class="tm-agent__ring" viewBox="0 0 100 100">
                            <circle class="tm-agent__ring-line" cx="50" cy="50" r="47" pathLength="1" />
                            <g class="tm-agent__ring-bead">
                              <circle cx="50" cy="3" r="2.6" />
                            </g>
                          </svg>
                          <span class="tm-add__ring">
                            <HugeiconsIcon :icon="Add01Icon" :size="20" :stroke-width="1.6" />
                          </span>
                        </span>
                        <span class="tm-add__label">
                          <span class="sr-only">New agent</span>
                          <span class="tm-roll" aria-hidden="true">
                            <span
                              v-for="(ch, k) in glyphs('New agent')"
                              :key="k"
                              class="tm-roll__ch"
                              :data-ch="ch"
                              :style="{ '--c': k }"
                            >{{ ch }}</span>
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <!-- ── sub-agents ── -->
            <div v-else key="subagents" class="tm__stack" :class="{ 'is-dealt': dealt.has('subagents') }">
              <section class="tm-kind" aria-label="Built-in">
                <header class="tm-kind__head">
                  <span class="tm-kind__title">Built-in</span>
                  <span class="tm-kind__rule" aria-hidden="true" />
                </header>

                <div class="tm__rows" role="list" aria-label="Built-in">
                  <article
                    v-for="(n, i) in natives"
                    :key="n.presetId"
                    role="listitem"
                    class="tm-sub"
                    :class="{ 'is-off': !n.enabled }"
                    :style="{ '--i': i }"
                    :tabindex="open ? 0 : -1"
                    :aria-label="`${n.name}${n.enabled ? '' : ', off'}`"
                    @click="openPreset(n.presetId)"
                    @keydown.enter.prevent="openPreset(n.presetId)"
                    @keydown.space.prevent="openPreset(n.presetId)"
                  >
                    <span class="tm-sub__glyph" aria-hidden="true">
                      <HugeiconsIcon :icon="nativeSubagentIcon(n.presetId)" :size="18" :stroke-width="1.7" />
                    </span>
                    <div class="tm-sub__body">
                      <div class="tm-sub__line">
                        <h4 class="tm-sub__name">{{ n.name }}</h4>
                        <span class="tm-sub__model">{{ chainSummary(n.model, n.modelFallbacks) }}</span>
                      </div>
                      <p class="tm-sub__brief">
                        {{ snippetText(n.instructions, "No standing instructions.") }}
                      </p>
                    </div>
                    <div class="tm-sub__act" @click.stop @keydown.stop>
                      <ToggleSwitch
                        :model-value="n.enabled"
                        :aria-label="`Enable ${n.name}`"
                        @update:model-value="toggleNative(n.presetId, $event)"
                      />
                    </div>
                  </article>
                </div>
              </section>

              <section class="tm-kind" aria-label="Custom">
                <header class="tm-kind__head">
                  <span class="tm-kind__title">Custom</span>
                  <span class="tm-kind__meta">{{ presets.length }}</span>
                  <span class="tm-kind__rule" aria-hidden="true" />
                </header>

                <div class="tm__rows" role="list" aria-label="Custom">
                  <article
                    v-for="(p, i) in presets"
                    :key="p.presetId"
                    role="listitem"
                    class="tm-sub tm-sub--custom"
                    :style="{ '--i': natives.length + i }"
                    :tabindex="open ? 0 : -1"
                    :aria-label="p.name"
                    @click="openPreset(p.presetId)"
                    @keydown.enter.prevent="openPreset(p.presetId)"
                    @keydown.space.prevent="openPreset(p.presetId)"
                  >
                    <span class="tm-sub__glyph" aria-hidden="true">
                      <HugeiconsIcon :icon="SparklesIcon" :size="18" :stroke-width="1.7" />
                    </span>
                    <div class="tm-sub__body">
                      <div class="tm-sub__line">
                        <h4 class="tm-sub__name">{{ p.name }}</h4>
                        <span class="tm-sub__model">{{ chainSummary(p.model, p.modelFallbacks) }}</span>
                      </div>
                      <p class="tm-sub__brief">
                        {{ snippetText(p.instructions, "No standing instructions yet.") }}
                      </p>
                    </div>
                    <span class="tm-sub__go" aria-hidden="true">
                      <HugeiconsIcon :icon="ArrowRight01Icon" :size="15" :stroke-width="1.8" />
                    </span>
                  </article>

                  <button
                    type="button"
                    class="tm-add tm-add--sub"
                    :style="{ '--i': natives.length + presets.length }"
                    :tabindex="open ? 0 : -1"
                    @click="startCreate"
                  >
                    <span class="tm-add__ring" aria-hidden="true">
                      <HugeiconsIcon :icon="Add01Icon" :size="16" :stroke-width="1.6" />
                    </span>
                    <span class="tm-add__label">New sub-agent</span>
                  </button>
                </div>
              </section>
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <template #foot>
      An agent is whoever does the work, kept apart from the threads they do it in, so the same name
      and face follow them across every conversation. Every project has a team — the agents made
      available to work within it; the composer offers a project's team, and a teammate can delegate
      only to another. A sub-agent is the other end of that hand-off: a focused worker an agent
      spawns for one isolated task. The built-ins are tested patterns you can switch off; a custom
      one carries your own brief and can pin the model it runs on.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.tm {
  --tm-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --tm-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  /* Fast off the mark, then a long soft settle — for things that open and
     close, where an overshoot would read as the page bouncing. */
  --tm-glide: cubic-bezier(0.32, 0.72, 0, 1);
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  container-type: inline-size;
}

/* The fixed part: hero and switch. The same inline padding the shell gives its
   own scroller, so the page lines up with every other settings page. */
.tm__top {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 22px;
  max-width: calc(58rem + 2rem);
  padding: 2px 1rem 14px;
}

/* The roster, scrolling under the switch. No bar — the edge smoke bound from
   useEdgeFade stands in for it, and only shows on an edge with more beyond. */
.tm__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  padding: 4px 1rem 3.5rem;
}
.tm__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* ── masthead action ─────────────────────────────────────────────────────── */
.tm__new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.tm__new:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.tm__new:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.tm-swap-enter-active,
.tm-swap-leave-active {
  transition:
    opacity 140ms ease,
    transform 180ms var(--tm-ease),
    filter 140ms ease;
}
.tm-swap-enter-from {
  opacity: 0;
  transform: translateY(4px);
  filter: blur(2px);
}
.tm-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
  filter: blur(2px);
}

/* ── hero art ──────────────────────────────────────────────────────────── */
/* The cast: leads, a current, workers. The banner drops it where the band is
   too narrow to give it room beside the copy. */
.tm__cast {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tm__leads {
  display: flex;
  align-items: center;
}
.tm__lead {
  margin-left: -10px;
  box-shadow: 0 0 0 2.5px var(--sunken);
  animation: tm-cast-in 520ms var(--tm-spring) calc(var(--i) * 60ms + 120ms) backwards;
}
.tm__lead:first-child {
  margin-left: 0;
}
.tm__lead--more {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--panel);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}
@keyframes tm-cast-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.8);
  }
}

.tm__current {
  width: 64px;
  height: 40px;
  overflow: visible;
  fill: none;
  stroke-linecap: round;
}
.tm__current-track {
  stroke: color-mix(in srgb, var(--ink) 14%, transparent);
  stroke-width: 1.2;
}
.tm__current-flow {
  stroke: var(--accent);
  stroke-width: 1.4;
  stroke-dasharray: 5 60;
  animation: tm-flow 2.6s linear infinite;
}
@keyframes tm-flow {
  from {
    stroke-dashoffset: 65;
  }
  to {
    stroke-dashoffset: 0;
  }
}

.tm__workers {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tm__worker {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink-soft);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
  animation: tm-cast-in 520ms var(--tm-spring) calc(var(--i) * 70ms + 420ms) backwards;
}

/* ── the switch ──────────────────────────────────────────────────────────── */
/* Two equal segments, so the pill only ever travels one segment's width and can
   be pure CSS — no measuring the buttons on every resize. */
.tm__tabs {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-self: flex-start;
  width: min(100%, 320px);
  padding: 3px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.tm__pill {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 9px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent);
  transition: transform 420ms var(--tm-spring);
}
.tm__tabs[data-at="subagents"] .tm__pill {
  transform: translateX(100%);
}
.tm__tab {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 32px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  transition: color 180ms ease;
}
.tm__tab:hover {
  color: var(--ink-soft);
}
.tm__tab.is-on {
  color: var(--ink);
}
.tm__tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.tm__tabcount {
  min-width: 18px;
  padding: 2px 5px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--muted);
  transition:
    background-color 180ms ease,
    color 180ms ease;
}
.tm__tab.is-on .tm__tabcount {
  background: color-mix(in oklab, var(--accent) 14%, transparent);
  color: var(--accent);
}

/* ── panel + its slide ───────────────────────────────────────────────────── */
.tm__panel {
  min-width: 0;
  max-width: 58rem;
}
.tm__stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.tm-slide-fwd-enter-active,
.tm-slide-fwd-leave-active,
.tm-slide-back-enter-active,
.tm-slide-back-leave-active {
  transition:
    opacity 180ms ease,
    transform 260ms var(--tm-ease),
    filter 180ms ease;
}
.tm-slide-fwd-enter-from,
.tm-slide-back-leave-to {
  opacity: 0;
  transform: translateX(18px);
  filter: blur(3px);
}
.tm-slide-fwd-leave-to,
.tm-slide-back-enter-from {
  opacity: 0;
  transform: translateX(-18px);
  filter: blur(3px);
}

/* Every card and row deals in on its own beat, so a roster arrives as a hand
   laid out rather than a block switched on. */
.tm-agent,
.tm-sub,
.tm-add {
  animation: tm-deal 460ms var(--tm-ease) calc(var(--i, 0) * 28ms + 40ms) backwards;
}
.tm__stack.is-dealt :is(.tm-agent, .tm-sub, .tm-add) {
  animation: none;
}
@keyframes tm-deal {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* ── team blocks ─────────────────────────────────────────────────────────── */
/* No gap or margin here that depends on whether the team is open: spacing that
   switched on the click would jump the page before the fold even started. The
   air an open team gets lives inside its body instead, and folds with it. */
.tm-team {
  display: flex;
  flex-direction: column;
}
.tm-team__h {
  margin: 0;
  font: inherit;
}
.tm-team__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 32px;
  padding-inline: 6px;
  border-radius: 10px;
  text-align: start;
}
.tm-team__row--toggle {
  cursor: pointer;
}
.tm-team__row--toggle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The chevron points down while the team is open and turns to point along the
   heading once it's folded. It rests a shade quieter than the name and comes
   up to ink under the pointer — the one sign the heading can be pressed. */
.tm-team__chev {
  flex-shrink: 0;
  color: var(--muted);
  transition:
    transform 300ms var(--tm-glide),
    color 160ms ease;
}
.tm-team__row--toggle[aria-expanded="false"] .tm-team__chev {
  transform: rotate(-90deg);
}
.tm-team__row--toggle:hover .tm-team__chev,
.tm-team__row--toggle:focus-visible .tm-team__chev {
  color: var(--ink);
}
.tm-team__row--toggle:hover .tm-team__glyph {
  color: var(--ink-soft);
}

.tm-team__peek {
  display: flex;
  flex-shrink: 0;
  margin-left: 4px;
}
.tm-team__peekface {
  margin-left: -5px;
  box-shadow: 0 0 0 2px var(--sunken);
}
.tm-team__peekface:first-child {
  margin-left: 0;
}
/* The faces arrive as the fold finishes — a glance of what went away — and
   leave at once when it opens, since the real tiles are on their way back. */
.tm-peek-enter-active {
  transition:
    opacity 220ms ease 120ms,
    transform 320ms var(--tm-glide) 120ms;
}
.tm-peek-leave-active {
  transition:
    opacity 100ms ease,
    transform 160ms var(--tm-glide);
}
.tm-peek-enter-from,
.tm-peek-leave-to {
  opacity: 0;
  transform: translateX(-4px);
}

/* Folding moves one thing — the row track, from the content's height to
   nothing — so the teams below glide up rather than jump. The block itself
   isn't faded: its tiles leave on their own, quickly, ahead of the height, so
   what closes is already empty and reads as light. Opening is the reverse:
   the height leads and the tiles settle in behind it, a beat apart. */
.tm-team__body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 300ms var(--tm-glide);
}
.tm-team__body.is-collapsed {
  grid-template-rows: 0fr;
  transition-duration: 260ms;
}
/* clip rather than hidden, with a margin, so a tile's focus ring and hover
   ring at the grid's edge aren't shaved off while the team is open. */
.tm-team__clip {
  min-height: 0;
  overflow: clip;
  overflow-clip-margin: 8px;
}
/* The space between one open team and the next heading is this bottom
   padding, not a gap on the stack — so it folds away with the team, and folded
   headings close up into a tight list. */
.tm__stack--teams {
  gap: 4px;
}
.tm-team__clip > .tm__grid {
  padding-top: 4px;
  padding-bottom: 28px;
}
.tm-team__body .tm-agent,
.tm-team__body .tm-add--agent {
  transition:
    opacity 260ms ease calc(60ms + var(--k, 0) * 24ms),
    transform 380ms var(--tm-glide) calc(60ms + var(--k, 0) * 24ms);
}
.tm-team__body.is-collapsed .tm-agent,
.tm-team__body.is-collapsed .tm-add--agent {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
  transition:
    opacity 120ms ease,
    transform 200ms var(--tm-glide);
}
/* The press answers at once, whatever the stagger says. */
.tm-team__body .tm-agent:active {
  transition-delay: 0s;
}
.tm-team__glyph {
  flex-shrink: 0;
  color: var(--muted);
  transition: color 160ms ease;
}
.tm-team__name {
  margin: 0;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-team__meta {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.tm-team__rule {
  flex: 1;
  min-width: 24px;
  height: 1px;
  margin-left: 4px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--ink) 11%, transparent), transparent);
}

/* ── agent cards ─────────────────────────────────────────────────────────── */
.tm__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 18px 6px;
  padding-top: 8px;
}
@container (min-width: 460px) {
  .tm__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@container (min-width: 680px) {
  .tm__grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

/* The tile hugs what you can see — portrait, name, role — rather than filling
   its grid cell. With no card drawn round it, a cell-sized hit area would
   answer the pointer in empty page where nothing looks clickable. */
.tm-agent {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-self: center;
  width: fit-content;
  max-width: 100%;
  padding: 14px 14px 12px;
  border-radius: 16px;
  cursor: pointer;
  outline: none;
  text-align: center;
  transition: transform 220ms var(--tm-ease);
}
/* No wash, no lift: the card answers a pointer through its portrait — a ring
   draws round it and the face turns to follow you — and through the press,
   which gives a little. */
.tm-agent {
  --tx: 0;
  --ty: 0;
}
.tm-agent:active {
  transform: scale(0.985);
}
.tm-agent:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.tm-agent__portrait {
  position: relative;
  display: grid;
  place-items: center;
  margin-bottom: 16px;
}

/* The ring sits 7px out from the disc — far enough to read as drawn round the
   face rather than as its rim, close enough to still belong to it. It starts
   at twelve o'clock and runs clockwise; the bead is carried round with it by
   rotating its group through the same sweep. */
.tm-agent__ring {
  position: absolute;
  inset: -7px;
  width: calc(100% + 14px);
  height: calc(100% + 14px);
  overflow: visible;
  pointer-events: none;
}
.tm-agent__ring-line {
  fill: none;
  stroke: var(--hue, var(--accent));
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  transition: stroke-dashoffset 520ms var(--tm-ease);
}
.tm-agent__ring-bead {
  fill: var(--hue, var(--accent));
  opacity: 0;
  transform-origin: 50px 50px;
  transform: rotate(0deg);
  transition:
    transform 520ms var(--tm-ease),
    opacity 120ms ease 400ms;
}
.tm-agent:hover .tm-agent__ring-line,
.tm-agent:focus-visible .tm-agent__ring-line,
.tm-add--agent:hover .tm-agent__ring-line,
.tm-add--agent:focus-visible .tm-agent__ring-line {
  stroke-dashoffset: 0;
}
.tm-agent:hover .tm-agent__ring-bead,
.tm-agent:focus-visible .tm-agent__ring-bead,
.tm-add--agent:hover .tm-agent__ring-bead,
.tm-add--agent:focus-visible .tm-agent__ring-bead {
  transform: rotate(360deg);
  opacity: 1;
  transition:
    transform 520ms var(--tm-ease),
    opacity 80ms ease;
}
/* Once the ring has closed, the bead fades — it marked the drawing, and a dot
   sitting on a finished circle would read as a notification. */
.tm-agent:hover .tm-agent__ring-bead circle,
.tm-agent:focus-visible .tm-agent__ring-bead circle,
.tm-add--agent:hover .tm-agent__ring-bead circle,
.tm-add--agent:focus-visible .tm-agent__ring-bead circle {
  animation: tm-bead-out 200ms ease 520ms forwards;
}
@keyframes tm-bead-out {
  to {
    opacity: 0;
  }
}

/* The face follows the pointer: a drawn face slides across its disc (it has
   room — it sits inset), a picture only tilts, since it fills the disc and
   sliding it would show the edge. The spring gives the following a little lag,
   which is what makes it read as looking rather than as being dragged. */
.tm-agent__face :deep(.roster-face__photo),
.tm-agent__face :deep(.roster-face__drawn) {
  transition: transform 420ms var(--tm-spring);
}
.tm-agent:hover .tm-agent__face :deep(.roster-face__drawn) {
  transform: translate(calc(var(--tx) * 7px), calc(var(--ty) * 5px)) rotate(calc(var(--tx) * 6deg))
    scale(1.06);
}
.tm-agent:hover .tm-agent__face :deep(.roster-face__photo) {
  transform: perspective(240px) rotateY(calc(var(--tx) * 14deg)) rotateX(calc(var(--ty) * -10deg))
    scale(1.03);
}

/* The agent the composer is pointed at wears an accent ring round its disc. */
.tm-agent.is-selected .tm-agent__face {
  box-shadow:
    0 0 0 2.5px var(--sunken),
    0 0 0 4px color-mix(in oklab, var(--accent) 70%, transparent);
}

/* Small, and on the ground its own colour needs — at this size a body that
   sinks into the surface leaves nothing to see. */
.tm-agent__bot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: block;
  width: 26px;
  height: 26px;
  padding: 3px;
  box-sizing: border-box;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--sunken);
}
/* The bot hops, a beat behind the face — it's the agent's creature, and it
   notices you second. */
.tm-agent__bot {
  transition: transform 460ms var(--tm-spring) 60ms;
}
.tm-agent:hover .tm-agent__bot {
  transform: translateY(-3px) rotate(-8deg);
}
.tm-agent__bot :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.tm-agent__name {
  margin: 0;
  transition: color 200ms ease;
  max-width: 100%;
  font-size: 14.5px;
  font-weight: 500;
  letter-spacing: -0.012em;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-agent:hover .tm-agent__role,
.tm-agent:focus-visible .tm-agent__role {
  color: var(--ink-soft);
}
/* Capped in characters, not left to the cell: a role that wraps at the cell's
   width would stretch the tile — and its hit area — right back out to it.
   A bare length, not min(100%, …): while the tile is sizing to its content the
   percentage has nothing to resolve against and the cap is dropped. The tile's
   own max-width still keeps it inside a narrow cell. */
.tm-agent__role {
  margin: 4px 0 0;
  transition: color 200ms ease;
  max-width: 22ch;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  overflow: hidden;
  text-wrap: pretty;
}

/* ── the roll ────────────────────────────────────────────────────────────────
   A name turns over on hover: each character slides up out of its slot as a
   copy of itself rises in from below, left to right, a beat apart. The slot is
   one line tall and clipped, so it reads as the word rolling rather than
   moving. The copy comes up in the agent's own hue (the accent on the add
   tile), mixed toward ink so a pale hue stays legible. */
.tm-roll {
  display: inline-flex;
  max-width: 100%;
  overflow: hidden;
  vertical-align: top;
}
.tm-roll__ch {
  position: relative;
  display: inline-block;
  transition: transform 520ms var(--tm-ease) calc(var(--c) * 14ms);
}
.tm-roll__ch::after {
  content: attr(data-ch);
  position: absolute;
  top: 100%;
  left: 0;
  color: var(--roll-ink, color-mix(in oklab, var(--accent) 82%, var(--ink)));
}
.tm-agent {
  --roll-ink: color-mix(in oklab, var(--hue, var(--accent)) 78%, var(--ink));
}
.tm-agent:hover .tm-roll__ch,
.tm-agent:focus-visible .tm-roll__ch,
.tm-add:hover .tm-roll__ch,
.tm-add:focus-visible .tm-roll__ch {
  transform: translateY(-100%);
}

.tm-agent__live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 11%, transparent);
}
.tm-agent__live i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: tm-breathe 2.2s ease-in-out infinite;
}
@keyframes tm-breathe {
  50% {
    opacity: 0.35;
  }
}

/* ── add tiles ───────────────────────────────────────────────────────────── */
.tm-add {
  display: flex;
  align-items: center;
  border-radius: 16px;
  color: var(--muted);
  cursor: pointer;
  outline: none;
  transition: color 180ms ease;
}
.tm-add:hover {
  color: var(--ink);
}
.tm-add:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.tm-add__ring {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  transition:
    transform 380ms var(--tm-spring),
    color 180ms ease;
}
.tm-add:hover .tm-add__ring {
  transform: rotate(90deg);
  color: var(--accent);
}
.tm-add__label {
  font-size: 13px;
  font-weight: 500;
  color: inherit;
}

/* The new-agent tile is laid out as a member would be — disc, then a label on
   the name's line — with no border of its own, so the row reads as agents
   plus one empty seat rather than agents plus a button. Like a member's tile,
   it hugs what it shows. */
.tm-add--agent {
  --hue: var(--accent);
  flex-direction: column;
  justify-self: center;
  width: fit-content;
  max-width: 100%;
  padding: 14px 14px 12px;
}
.tm-add--agent .tm-add__ring {
  width: 76px;
  height: 76px;
}
.tm-add--agent .tm-add__label {
  font-size: 14.5px;
  letter-spacing: -0.012em;
  line-height: 1.3;
}

/* The new-sub-agent tile is a bare line under the custom cards: no ground and
   no box around the plus, so it reads as an invitation after the list rather
   than one more card in it. The inset puts the plus on the centre line of the
   glyphs above, with the label close beside it; the tile hugs its content so
   the hover answers only over the words. */
.tm-add--sub {
  justify-self: start;
  width: fit-content;
  gap: 8px;
  padding: 8px 14px 8px 22px;
  margin-top: 2px;
  border-radius: 12px;
  text-align: start;
}
.tm-add--sub .tm-add__label {
  font-size: 14px;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.tm-add--sub .tm-add__ring {
  width: 24px;
  height: 24px;
  background: none;
}
.tm-add--sub:active {
  transform: scale(0.985);
}

/* ── sub-agent rows ──────────────────────────────────────────────────────── */
.tm-kind {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tm-kind__head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-inline: 6px;
}
.tm-kind__title {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1;
  color: var(--ink-soft);
}
.tm-kind__meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.tm-kind__rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--ink) 11%, transparent), transparent);
}

/* One column until there's room for two cards that each still hold a
   two-line brief at a readable measure. */
.tm__rows {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
@container (min-width: 620px) {
  .tm__rows {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.tm-sub {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 14px 14px 14px 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  cursor: pointer;
  outline: none;
  transition:
    transform 220ms var(--tm-ease),
    opacity 220ms var(--tm-ease);
}
/* The card itself holds still on hover — a lift made a row of them feel
   heavy. What answers is inside it: the glyph wakes to the accent with a small
   spring, and the model and brief step up a shade so the card reads as
   picked up rather than moved. Pressing gives a hair of give. */
.tm-sub:active {
  transform: scale(0.992);
}
.tm-sub:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* Off reads as benched, not broken: the brief fades back, the switch stays at
   full strength so turning it on again is the obvious move. */
.tm-sub.is-off .tm-sub__glyph,
.tm-sub.is-off .tm-sub__body {
  opacity: 0.5;
}

.tm-sub__glyph {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-soft);
  transition:
    color 220ms ease,
    opacity 220ms ease;
}
.tm-sub__glyph :deep(svg) {
  transition: transform 360ms var(--tm-spring);
}
.tm-sub:is(:hover, :focus-visible) .tm-sub__glyph {
  color: var(--accent);
}
.tm-sub:is(:hover, :focus-visible) .tm-sub__glyph :deep(svg) {
  transform: scale(1.12);
}
.tm-sub--custom .tm-sub__glyph {
  color: var(--accent);
}

.tm-sub__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  flex: 1;
  transition: opacity 220ms ease;
}
.tm-sub__line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.tm-sub__name {
  margin: 0;
  flex-shrink: 0;
  max-width: 60%;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-sub__model {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.25;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 200ms ease;
}
.tm-sub:is(:hover, :focus-visible) .tm-sub__model {
  color: var(--ink-soft);
}
.tm-sub__brief {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
  overflow: hidden;
  text-wrap: pretty;
  transition: color 200ms ease;
}
.tm-sub:is(:hover, :focus-visible) .tm-sub__brief {
  color: var(--ink);
}

/* The switch's zone is wider than the switch: a click that lands just beside
   it meant the switch, and opening the page instead would be a surprise. */
.tm-sub__act {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin: -10px -10px -10px -4px;
  padding: 12px 10px 10px 8px;
  cursor: default;
}
.tm-sub__go {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  align-self: center;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity 160ms ease,
    transform 260ms var(--tm-spring),
    color 160ms ease;
}
.tm-sub:is(:hover, :focus-visible) .tm-sub__go {
  opacity: 1;
  transform: none;
  color: var(--accent);
}

@media (prefers-reduced-motion: reduce) {
  .tm__lead,
  .tm__worker,
  .tm__current-flow,
  .tm-agent,
  .tm-sub,
  .tm-add,
  .tm-agent__live i {
    animation: none;
  }
  .tm__pill,
  .tm-agent,
  .tm-agent__face :deep(.roster-face__photo),
  .tm-agent__face :deep(.roster-face__drawn),
  .tm-agent__bot,
  .tm-agent__ring-bead,
  .tm-roll__ch,
  .tm-team__chev,
  .tm-team__body,
  .tm-team__body .tm-agent,
  .tm-team__body .tm-add--agent,
  .tm-sub,
  .tm-sub__glyph,
  .tm-sub__glyph :deep(svg),
  .tm-sub__go,
  .tm-add__ring {
    transition: none;
    transform: none;
  }
  .tm-agent__ring-line {
    transition: none;
  }
  .tm-slide-fwd-enter-active,
  .tm-slide-fwd-leave-active,
  .tm-slide-back-enter-active,
  .tm-slide-back-leave-active {
    transition: opacity 120ms ease;
  }
  .tm-slide-fwd-enter-from,
  .tm-slide-fwd-leave-to,
  .tm-slide-back-enter-from,
  .tm-slide-back-leave-to {
    transform: none;
    filter: none;
  }
}
</style>
